import {BODY_FOLLOW_X,clamp} from './mapping.mjs';
// Mouse yaw stays a little inside the ±23 tracking range (was 25 of 30).
export const MOUSE_MAX_X=20;

export const FOLLOW_IDS=['ParamAngleX','ParamAngleY','ParamAngleZ','ParamEyeBallX','ParamEyeBallY','ParamBodyAngleX','ParamBodyAngleY','ParamBodyAngleZ'];
const neutral=()=>Object.fromEntries(FOLLOW_IDS.map(id=>[id,0]));
export const MOUSE_CONFIG=Object.freeze({eye:.10,head:.30,return:.35,idleReturn:1.2,idleAfter:8});

// Exact critically damped spring. Project velocity into the monotone cone on
// every goal change: reversals cannot carry momentum away from / past the goal.
export class MonotoneSpring {
  constructor(value=0){this.value=value;this.velocity=0;}
  reset(value){this.value=value;this.velocity=0;}
  step(goal,dt,response=.30){
    if(!Number.isFinite(goal)||!Number.isFinite(dt)||dt<=0)return this.value;
    const x=this.value,error=goal-x,w=3.89/Math.max(.001,response),direction=Math.sign(error);
    const v=direction*clamp(this.velocity*direction,0,w*Math.abs(error));
    const c=v-w*error,decay=Math.exp(-w*dt);
    this.value=clamp(goal+(-error+c*dt)*decay,Math.min(x,goal),Math.max(x,goal));
    this.velocity=(v-w*c*dt)*decay;
    if(Math.abs(goal-this.value)<1e-7&&Math.abs(this.velocity)<1e-6)this.reset(goal);
    return this.value;
  }
}

export function mapMouse(point,face){
  if(!point||!face||![point.x,point.y,face.x,face.y,face.width,face.height].every(Number.isFinite))return neutral();
  const x=Math.tanh((point.x-face.x)/Math.max(80,face.width*1.25));
  const y=Math.tanh((face.y-point.y)/Math.max(90,face.height*1.4));
  return {ParamAngleX:MOUSE_MAX_X*x,ParamAngleY:18*y,ParamAngleZ:-.65*x*y,
    ParamEyeBallX:x,ParamEyeBallY:y,ParamBodyAngleX:10*Math.tanh(MOUSE_MAX_X*x*BODY_FOLLOW_X/10),
    ParamBodyAngleY:18*y*.06,ParamBodyAngleZ:-.65*x*y*.12};
}

// Same transforms as the renderer: Cubism vertices -> local canvas -> world ->
// CSS client pixels. Read live vertices (never cached preview geometry).
export function faceScreenBounds(model,rect,screen,offsetY=0){
  const internal=model?.internalModel,raw=internal?.coreModel?._model;
  if(!raw||!rect.width||!rect.height||!screen.width||!screen.height)return null;
  const d=raw.drawables;
  let indices=Array.from(d.ids, (id,i)=>/^ArtMeshFace(?:$|[_\d])/.test(id)?i:-1).filter(i=>i>=0);
  if(!indices.length)indices=Array.from(d.ids,(id,i)=>/^ArtMeshEyewhite[LR]$/.test(id)?i:-1).filter(i=>i>=0);
  let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
  for(const i of indices){
    const vertices=internal.getDrawableVertices(i);
    for(let j=0;j<vertices.length;j+=2){
      const p=model.toGlobal(internal.localTransform.apply({x:vertices[j],y:vertices[j+1]}));
      const x=rect.left+p.x*rect.width/screen.width,y=rect.top+(p.y+offsetY)*rect.height/screen.height;
      minX=Math.min(minX,x);maxX=Math.max(maxX,x);minY=Math.min(minY,y);maxY=Math.max(maxY,y);
    }
  }
  return Number.isFinite(minX)?{x:(minX+maxX)/2,y:(minY+maxY)/2,width:maxX-minX,height:maxY-minY}:null;
}

export class MouseFollow {
  constructor(storage){
    this.storage=storage;this.enabled=true;
    try{this.enabled=storage?.getItem('facetrack-mouse-follow')!=='false';}catch{}
    this.point=null;this.inside=false;this.lastMove=-Infinity;this.dirty=true;
    this.target=neutral();this.springs=Object.fromEntries(FOLLOW_IDS.map(id=>[id,new MonotoneSpring()]));
    this.values=neutral();this.mode='rest';this.viewKey=null;this.wasMotion=false;this.source=false;this.handoff=0;this.motionEntry=null;this.motionAge=0;
  }
  setEnabled(value){this.enabled=!!value;this.dirty=true;try{this.storage?.setItem('facetrack-mouse-follow',String(this.enabled));}catch{}}
  move(x,y,time){
    if(!Number.isFinite(x)||!Number.isFinite(y))return;
    if(!this.inside||!this.point||x!==this.point.x||y!==this.point.y){this.lastMove=time;this.dirty=true;}
    this.point={x,y};this.inside=true;
  }
  leave(){this.inside=false;}
  adoptMotion(values){
    const t=clamp(this.motionAge/.25,0,1),weight=t*t*(3-2*t);
    for(const id of FOLLOW_IDS)if(/^Param(Angle|BodyAngle)/.test(id)&&Number.isFinite(values[id])){
      const value=this.motionEntry?this.motionEntry[id]+(values[id]-this.motionEntry[id])*weight:values[id];
      this.springs[id].reset(value);this.values[id]=value;
    }
    return this.values;
  }
  step({time,dt,face,viewKey='',source=false,faceValues={},motion=false,bodyResponse=.15}){
    if(source!==this.source||this.wasMotion&&!motion){this.handoff=.35;this.source=source;}
    if(motion&&!this.wasMotion){this.motionEntry={...this.values};this.motionAge=0;}
    else if(motion)this.motionAge+=Math.max(0,Number.isFinite(dt)?dt:0);
    else this.motionEntry=null;
    const idle=time-this.lastMove>=MOUSE_CONFIG.idleAfter;
    const mode=source?'face':this.enabled&&this.inside&&!idle&&face?'mouse':idle&&this.inside&&this.enabled?'idle':'rest';
    if(this.dirty||viewKey!==this.viewKey||mode!==this.mode||this.wasMotion&&!motion){
      this.target=mapMouse(this.point,face);this.dirty=false;this.viewKey=viewKey;
    }
    this.mode=mode;this.wasMotion=motion;
    // Latch the mapping between pointer/view events. Head deformation, physics
    // and breathing cannot feed tiny screen-centre changes back into a still gaze.
    const target=mode==='face'?faceValues:mode==='mouse'?this.target:neutral();
    for(const id of FOLLOW_IDS){
      if(motion&&/^Param(Angle|BodyAngle)/.test(id))continue;
      let goal=target[id]??0;
      let response=mode==='face'?.065:mode==='mouse'?(id.startsWith('ParamEyeBall')?MOUSE_CONFIG.eye:MOUSE_CONFIG.head):mode==='idle'?MOUSE_CONFIG.idleReturn:MOUSE_CONFIG.return;
      // Do not expose the face path's fast steady-state response on its first
      // opposite-pose frame: reserve 350 ms for a visibly smooth handoff.
      if(mode==='face'&&this.handoff>0)response=id.startsWith('ParamEyeBall')?.10:.30;
      if(mode==='mouse'&&id.startsWith('ParamBody')){
        // Cascaded follow: body inertia slider adds lag AFTER the slower head.
        goal=id.endsWith('X')?10*Math.tanh(this.values.ParamAngleX*BODY_FOLLOW_X/10):id.endsWith('Y')?this.values.ParamAngleY*.06:this.values.ParamAngleZ*.12;
        response=bodyResponse??.15;
      }
      this.values[id]=this.springs[id].step(goal,dt,response);
    }
    this.handoff=Math.max(0,this.handoff-Math.max(0,Number.isFinite(dt)?dt:0));
    return this.values;
  }
}

// Passive observers never capture, cancel, or prevent the canvas drag/tap path.
export function bindMouseFollow(follow,host,win=window,doc=document,now=()=>performance.now()/1000){
  let contact=null;
  const move=e=>follow.move(e.clientX,e.clientY,now());
  const down=e=>{if(e.pointerType!=='mouse'&&contact===null){contact=e.pointerId;move(e);}};
  const pointer=e=>{
    if((e.pointerType==='mouse'||!e.pointerType)&&doc.visibilityState!=='hidden'){
      if(e.clientX<0||e.clientY<0||e.clientX>win.innerWidth||e.clientY>win.innerHeight){leave();return;}
      move(e);
    }else if(e.pointerId===contact)move(e);
  };
  const up=e=>{if(e.pointerId===contact){contact=null;follow.leave();}};
  const leave=()=>{contact=null;follow.leave();};
  const out=e=>{if(!e.relatedTarget&&(!e.pointerType||e.pointerType==='mouse'))leave();};
  const visibility=()=>{if(doc.visibilityState==='hidden')leave();};
  const listeners=[[host,'pointerdown',down],[win,'pointermove',pointer],[win,'pointerup',up],[win,'pointercancel',up],
    [host,'lostpointercapture',up],[doc,'pointerout',out],[win,'blur',leave],[doc,'visibilitychange',visibility]];
  for(const [element,event,fn]of listeners)element.addEventListener(event,fn,{passive:true});
  return ()=>{for(const [element,event,fn]of listeners)element.removeEventListener(event,fn);};
}

export function idleBlink(time){const phase=((time%4.7)+4.7)%4.7;return phase<.18?1-Math.sin(Math.PI*phase/.18)**2:1;}
