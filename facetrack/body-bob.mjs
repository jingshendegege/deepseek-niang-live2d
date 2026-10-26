// Seconds, degrees and MediaPipe canonical translation units (approximately cm).
// Only input.id is written. The skirt outputs belong exclusively to model physics.
export const BODY_BOB_CONFIG=Object.freeze({
  // User 2026-10-25: “不要小跳”. Off = no hop button, no idle/face hops, basin dip untouched.
  active:false,
  input:{id:'ParamBodyBob',limit:1},physicsOutputs:['ParamSkirtBounce','ParamSkirtHemLag'],
  easing:t=>t*t*t*(t*(t*6-15)+10),
  manual:{amplitude:1,down:.12,up:.25},
  idle:{amplitude:[.15,.25],interval:[4,8],down:.16,up:.32},
  face:{amplitude:[.16,.32],down:.12,up:.25,pitchSpeed:65,ySpeed:10,
    maxPitchSpeed:400,maxYSpeed:60,filter:.055,warmup:.25,maxGap:.15,
    confirmSamples:2,cooldown:1.1,releaseRatio:.4},
  offSeconds:.12,basinFade:.05,basinSeconds:.6,
  storage:{idle:'facetrack-body-bob-idle',face:'facetrack-body-bob-face'}
});
const clamp=(v,lo=0,hi=1)=>Math.max(lo,Math.min(hi,v));
export function bobEnvelope(t,shape=BODY_BOB_CONFIG.manual,config=BODY_BOB_CONFIG){
  if(!Number.isFinite(t)||t<=0||t>=shape.down+shape.up)return 0;
  return t<shape.down?config.easing(t/shape.down):1-config.easing((t-shape.down)/shape.up);
}
// Never ask Cubism for an unknown ID: its wrapper can create virtual parameters.
export function writeBodyBob(core,value,config=BODY_BOB_CONFIG){
  const p=core?._model?.parameters,i=p?.ids?.indexOf(config.input.id)??-1;
  if(i<0||!Number.isFinite(value))return false;
  core.setParameterValueById(config.input.id,clamp(value,Math.max(-config.input.limit,p.minimumValues[i]),Math.min(0,p.maximumValues[i])));
  return true;
}

export function createBodyBob({config=BODY_BOB_CONFIG,random=Math.random,storage,now=()=>performance.now()/1000}={}){
  if(storage===undefined)try{storage=globalThis.localStorage;}catch{}
  const enabled={idle:true,face:true};
  for(const source of ['idle','face'])try{enabled[source]=storage?.getItem(config.storage[source])!=='false';}catch{}
  let events=[],nextIdle=null,face=null,lastFaceTrigger=-Infinity,armed=true;
  let basin=false,basinStart=0,basinHadBob=false,pendingManual=false,value=0;
  const between=range=>range[0]+clamp(random())*(range[1]-range[0]);
  const depth=(event,time)=>event.release
    ?event.amplitude*(1-config.easing(clamp((time-event.start)/config.offSeconds)))
    :event.amplitude*bobEnvelope(time-event.start,event.shape,config);
  // Smooth bounded addition: a new pulse starts with zero value/velocity/acceleration.
  // Unlike hard-clipping a sum this also remains smooth at the -1 boundary.
  const combined=(time,items=events)=>config.input.limit*(1-items.reduce((rest,event)=>rest*(1-clamp(depth(event,time)/config.input.limit)),1));
  const add=(source,time,amplitude)=>events.push({source,start:time,amplitude,shape:config[source]});
  const resetFace=()=>{face=null;armed=true;};
  const api={
    get enabled(){return {...enabled};},get value(){return value;},
    setEnabled(source,on,time=now()){
      if(!Object.hasOwn(enabled,source))return;
      if(enabled[source]===!!on)return;
      enabled[source]=!!on;
      try{storage?.setItem(config.storage[source],String(enabled[source]));}catch{}
      if(!on){
        const amplitude=combined(time,events.filter(e=>e.source===source));
        events=events.filter(e=>e.source!==source);
        if(amplitude>0)events.push({source,start:time,amplitude,release:true});
      }
      nextIdle=null;resetFace();
    },
    trigger(time=now()){
      if(basin){pendingManual=true;return;}
      add('manual',time,config.manual.amplitude);
      nextIdle=time+between(config.idle.interval);
    },
    resetFace,
    observeFace({time,pitch,y,valid=true,live=true,motion=false,basinActive=false,at=now()}){
      const c=config.face;
      if(!enabled.face||!valid||!live||motion||basinActive||basin||![time,pitch,y].every(Number.isFinite)){resetFace();return false;}
      const dt=face?time-face.time:0;
      if(!face||dt<=0||dt>c.maxGap){face={time,pitch,y,since:time,vp:0,vy:0,count:0,direction:0};return false;}
      const vp=(pitch-face.pitch)/dt,vy=(y-face.y)/dt;
      if(Math.abs(vp)>c.maxPitchSpeed||Math.abs(vy)>c.maxYSpeed){resetFace();return false;}
      const alpha=1-Math.exp(-dt/c.filter);
      face.vp+=(vp-face.vp)*alpha;face.vy+=(vy-face.vy)*alpha;
      const ratios=[face.vp/c.pitchSpeed,face.vy/c.ySpeed],axis=Math.abs(ratios[0])>=Math.abs(ratios[1])?0:1;
      const speed=Math.abs(ratios[axis]),raw=(axis===0?vp/c.pitchSpeed:vy/c.ySpeed),direction=(axis+1)*Math.sign(raw);
      if(speed<c.releaseRatio)armed=true;
      face.count=speed>1&&Math.abs(raw)>1&&Math.sign(raw)===Math.sign(ratios[axis])?(direction===face.direction?face.count+1:1):0;
      Object.assign(face,{time,pitch,y,direction});
      if(time-face.since<c.warmup||face.count<c.confirmSamples||!armed||time-lastFaceTrigger<c.cooldown)return false;
      armed=false;lastFaceTrigger=time;
      const amplitude=c.amplitude[0]+(c.amplitude[1]-c.amplitude[0])*clamp((speed-1)/1.5);
      add('face',at,amplitude);return true;
    },
    sample(time=now(),{source=false,motion=false,basinActive=false}={}){
      if(basinActive&&!basin){basinStart=time;basinHadBob=combined(time)>0;resetFace();}
      if(!basinActive&&basin){
        events=[];
        if(pendingManual){add('manual',time,config.manual.amplitude);pendingManual=false;}
      }
      basin=basinActive;
      let basinWeight=1;
      if(basin){
        basinWeight=basinHadBob?config.easing(clamp((time-basinStart)/config.basinFade)):1;
        if(basinWeight===1)events=[];
      }
      if(!enabled.idle||source||motion||basin)nextIdle=null;
      else if(nextIdle===null)nextIdle=time+between(config.idle.interval);
      else if(time>=nextIdle){add('idle',time,between(config.idle.amplitude));nextIdle=time+between(config.idle.interval);}
      if(!source||motion||basin)resetFace();
      events=events.filter(e=>time-e.start<(e.release?config.offSeconds:e.shape.down+e.shape.up));
      value=-combined(time)*(basin?1-basinWeight:1);
      if(value===0)value=0;
      return {value,basinWeight};
    }
  };
  return api;
}

export function mountBodyBob(host,api){
  const row=document.createElement('div');row.className='body-bob-controls';
  for(const [source,title]of [['idle','待机弹跳'],['face','面捕弹跳']]){
    const label=document.createElement('label'),toggle=document.createElement('input');label.className='check';
    toggle.type='checkbox';toggle.id='body-bob-'+source;toggle.checked=api.enabled[source];
    toggle.onchange=()=>api.setEnabled(source,toggle.checked);label.append(toggle,title);row.append(label);
  }
  host.append(row);
}
