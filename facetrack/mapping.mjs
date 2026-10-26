import {Median3} from './robustness.mjs';
import {DEFAULT_RANGES} from './calibration.mjs';
export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, Number.isFinite(v) ? v : 0));
export const BODY_FOLLOW_X=.20;
export const DEFAULTS = Object.freeze({ParamAngleX:0,ParamAngleY:0,ParamAngleZ:0,ParamBodyAngleX:0,ParamBodyAngleY:0,ParamBodyAngleZ:0,ParamEyeLOpen:1,ParamEyeROpen:1,ParamEyeLSmile:0,ParamEyeRSmile:0,ParamEyeBallX:0,ParamEyeBallY:0,ParamBrowLY:0,ParamBrowRY:0,ParamBrowLAngle:0,ParamBrowRAngle:0,ParamMouthOpenY:0,ParamMouthForm:0,ParamMouthPress:0,ParamMouthShrug:0,ParamMouthPout:0,ParamCheek:0,ParamBreath:.5});

// MediaPipe returns column-major 4x4 matrices. Normalize columns to remove scale.
export function matrixToEuler(matrix) {
  const m = matrix?.data;
  if (!m || m.length !== 16 || !Array.from(m).every(Number.isFinite)) return null;
  const sx = Math.hypot(m[0],m[1],m[2]), sy = Math.hypot(m[4],m[5],m[6]), sz = Math.hypot(m[8],m[9],m[10]);
  if (Math.min(sx,sy,sz) < 1e-5) return null;
  const yaw = Math.atan2(-m[2]/sx, Math.hypot(m[0]/sx,m[1]/sx));
  const pitch = Math.atan2(m[6]/sy,m[10]/sz);
  // Screen lean follows the projected head-up axis, not the eye/right axis.
  // With pitch followed by yaw, the latter contains atan(tan(yaw)*sin(pitch)):
  // a turn can tilt the eye line while the forehead/chin axis stays upright.
  // Keep the established yaw/pitch response and mirror signs unchanged.
  const upLength = Math.hypot(m[4]/sy,m[5]/sy);
  const roll = upLength > 1e-4 ? Math.atan2(-m[4]/sy,m[5]/sy) : Math.atan2(m[1]/sx,m[0]/sx);
  const degrees = 180 / Math.PI;
  // Mirror yaw; Cubism Y is up. This model's positive AngleZ is clockwise
  // on screen, matching positive projected head-up lean after preview mirroring.
  return {x:-yaw*degrees,y:-pitch*degrees,z:roll*degrees};
}

// C1 continuous centre: keep small movements at 1x; recover the full 2.2x
// response by 5 degrees. Static mapping cannot spring back after a stopped turn.
const smoothstep=(lo,hi,x)=>{const t=clamp((x-lo)/(hi-lo),0,1);return t*t*(3-2*t);};
export function headCurve(degrees,central=true,centreStart=2,centreEnd=5){const x=Math.abs(degrees),k=9,g=2.2;const centre=central?x*(1+1.2*smoothstep(centreStart,centreEnd,x)):g*x;return Math.sign(degrees)*(x<=k?centre:30-(30-g*k)*Math.exp(-(x-k)*g/(30-g*k)));}
// Yaw range (user 2026-10-25: ±30 -> ±23). Same centre and 2.2x slope; the knee scales with the
// range (9 deg at 30) so the soft approach stays C1 continuous. Real ±9° -> ±18.7, ±15° -> ±22.2.
export const HEAD_RANGE_X=23;
export function headCurveRange(degrees,range,centreStart=2,centreEnd=5){const x=Math.abs(degrees),k=9*range/30,g=2.2;const centre=x*(1+1.2*smoothstep(centreStart,centreEnd,x));return Math.sign(degrees)*(x<=k?centre:range-(range-g*k)*Math.exp(-(x-k)*g/(range-g*k)));}

// A deliberate one-sided squint may have almost no eyeBlink signal. Use raw
// squint contrast plus lid geometry, so neutral calibration cannot subtract it.
// Geometry alone is insufficient (perspective/occlusion can make one eye small).
export function squintClosure(points,shapes,aspect=1){
  const raw=n=>clamp(shapes[n]??0,0,1),distance=(a,b)=>{const p=points?.[a],q=points?.[b];return p&&q?Math.hypot((p.x-q.x)*aspect,p.y-q.y):0;};
  const aperture=(a,b,c,d)=>{const w=distance(a,b);return w>1e-5?distance(c,d)/w:null;};
  const lid={Left:aperture(362,263,386,374),Right:aperture(33,133,159,145)};
  return Object.fromEntries(['Left','Right'].map(side=>{
    const other=side==='Left'?'Right':'Left',s=raw('eyeSquint'+side),contrast=s-raw('eyeSquint'+other);
    const lidContrast=lid[side]!==null&&lid[other]!==null?smoothstep(.035,.10,lid[other]-lid[side]):1;
    const squint=smoothstep(.03,.28,contrast)*smoothstep(.12,.30,s)*lidContrast;
    const geometry=lid[side]!==null&&lid[other]!==null?smoothstep(.035,.12,lid[other]-lid[side])*smoothstep(.27,.36,lid[other])*smoothstep(.02,.065,contrast)*smoothstep(.12,.27,s):0;
    return [side,Math.max(squint,geometry)*(1-smoothstep(.30,.50,raw('eyeSquint'+other)))*(1-smoothstep(.18,.40,raw('eyeBlink'+other)))];
  }));
}
const soft=(v,limit)=>limit*Math.tanh(v/limit);
export function matrixTranslation(matrix){const m=matrix?.data;return {x:m?.[12]||0,y:m?.[13]||0,z:m?.[14]||0};}

// Eye-local coordinates compensate roll and aspect ratio. Each eye gets its own
// weight; collapsed lids, out-of-eye irises and occluded far eyes lose influence.
export function irisGaze(points,openLeft,openRight,aspect=1){
  const eyes=[{side:'Right',corners:[33,133],lids:[159,145],iris:[468,469,470,471,472],open:openRight},
    {side:'Left',corners:[362,263],lids:[386,374],iris:[473,474,475,476,477],open:openLeft}];
  const xy=i=>{const p=points?.[i];return p&&Number.isFinite(p.x)&&Number.isFinite(p.y)?[p.x*aspect,p.y]:null;};
  const result=[];
  for(const e of eyes){
    const all=[...e.corners,...e.lids,...e.iris].map(xy);if(all.some(p=>!p)){result.push({...e,weight:0,x:0,y:0});continue;}
    const [a,b,top,bottom,...ring]=all,dx=b[0]-a[0],dy=b[1]-a[1],width=Math.hypot(dx,dy);
    if(width<1e-5){result.push({...e,weight:0,x:0,y:0});continue;}
    const ux=dx/width,uy=dy/width,vx=-uy,vy=ux,project=p=>[(p[0]-a[0])*ux+(p[1]-a[1])*uy,(p[0]-a[0])*vx+(p[1]-a[1])*vy];
    const centre=ring.reduce((s,p)=>[s[0]+p[0]/ring.length,s[1]+p[1]/ring.length],[0,0]);
    const ip=project(centre),tp=project(top),bp=project(bottom),height=bp[1]-tp[1];
    const horizontal=ip[0]/width,vertical=(ip[1]-tp[1])/Math.max(height,1e-5);
    const valid=height>width*.08&&horizontal>.08&&horizontal<.92&&vertical>-.15&&vertical<1.15;
    result.push({...e,x:clamp((.5-horizontal)*3.8,-1,1),y:clamp((.5-vertical)*1.5,-1,1),weight:valid?e.open**2*width*clamp(height/width/.25,0,1):0});
  }
  const sum=result.reduce((s,e)=>s+e.weight,0);
  return {x:sum?result.reduce((s,e)=>s+e.x*e.weight,0)/sum:0,y:sum?result.reduce((s,e)=>s+e.y*e.weight,0)/sum:0,confidence:clamp(sum/.035,0,1),eyes:result.map(({side,x,y,weight})=>({side,x,y,weight}))};
}

export function mapFace(result,zero={x:0,y:0,z:0},gain={head:1,mouth:1,brow:1,eye:1},options={}){
  const matrix=result?.facialTransformationMatrixes?.[0],angles=options.anglesOverride??matrixToEuler(matrix);
  if(!result?.faceLandmarks?.length||!angles||!result.faceBlendshapes?.length)return null;
  const shapes=Object.fromEntries(result.faceBlendshapes[0].categories.map(c=>[c.categoryName,c.score]));
  const raw=n=>clamp(shapes[n]??0,0,1), b=n=>{const r=options.calibration?.ranges?.[n]||DEFAULT_RANGES[n];return r?clamp((raw(n)-r[0])/(r[1]-r[0]),0,1):raw(n);};
  const v={...DEFAULTS},translation=matrixTranslation(matrix);
  for(const [axis,id] of [['x','ParamAngleX'],['y','ParamAngleY'],['z','ParamAngleZ']]){
    let degrees=(angles[axis]-(zero[axis]||0))*(gain.head??1);
    // C1 soft dead zone for small lean noise; intentional >=4-degree lean
    // retains the existing full response. Apply after neutral calibration.
    if(axis==='z')degrees*=smoothstep(1,4,Math.abs(degrees));
    v[id]=axis==='x'?headCurveRange(degrees,HEAD_RANGE_X,2,5):headCurve(degrees,true,3,axis==='z'?7:5);
  }
  // Transform translation uses canonical face units (~cm). Centre relative to calibration.
  // Missing translation zero deliberately gives zero displacement, never a startup jump.
  const delta=Object.fromEntries(['x','y','z'].map(k=>[k,translation[k]-(zero['t'+k]??translation[k])]));
  // Face translation cannot distinguish a neck pivot from a shoulder lean.
  // Share yaw with the torso; drive torso lean only from measured head lean.
  // Keep the original 0.10 yaw share: this rig's BodyAngleX also adds lean.
  // Increase only after that keyform is corrected (see qa_turn evidence).
  // Body follows head yaw (0.20 since v4v/v4x removed the tilt baked into BodyAngleX; Allium/witch use ~1/3).
  v.ParamBodyAngleX=soft(v.ParamAngleX*BODY_FOLLOW_X,10);
  v.ParamBodyAngleZ=soft(v.ParamAngleZ*.12,10);
  v.ParamBodyAngleY=soft(delta.y*.65+delta.z*.18+v.ParamAngleY*.06,5);
  const squint=squintClosure(result.faceLandmarks[0],shapes,options.aspect||1);
  let blinkL=Math.max(b('eyeBlinkLeft'),squint.Left),blinkR=Math.max(b('eyeBlinkRight'),squint.Right);
  const difference=Math.abs(blinkL-blinkR);
  // Continuous coupling: exact common blink for near-equal eyes; strong winks untouched.
  const coupling=1-smoothstep(.10,.26,difference),mean=(blinkL+blinkR)/2;
  blinkL+=coupling*(mean-blinkL);blinkR+=coupling*(mean-blinkR);
  // Eye response with a dead zone at the open end: resting lids, a smile or a downward glance stay open, a
  // real blink or wink still closes fully. gain.eye picks the band (柔和 / 标准 / 灵敏; the old pow(.8) curve was
  // close to 灵敏 and half-closed the eyes on ordinary expressions).
  const eyeGain=gain.eye??1,[e0,e1]=eyeGain<.9?[.32,.95]:eyeGain>1.1?[.06,.72]:[.2,.86];
  v.ParamEyeLOpen=1-smoothstep(e0,e1,blinkR);v.ParamEyeROpen=1-smoothstep(e0,e1,blinkL);
  const smile=(b('mouthSmileLeft')+b('mouthSmileRight'))/2;
  // A lid squint counts as smile eyes only with a smiling mouth: a frowning
  // squint narrows the lids, and some faces rest at eyeSquint .4-.8 unsmiling.
  // Cheek raise is itself a smile cue and stays ungated.
  const smileGate=smoothstep(.20,.50,(raw('mouthSmileLeft')+raw('mouthSmileRight'))/2);
  v.ParamEyeLSmile=Math.max(raw('cheekSquintRight'),raw('eyeSquintRight')*smileGate);
  v.ParamEyeRSmile=Math.max(raw('cheekSquintLeft'),raw('eyeSquintLeft')*smileGate);
  v.ParamEyeLSmile*=1-smoothstep(.08,.22,squint.Right);
  v.ParamEyeRSmile*=1-smoothstep(.08,.22,squint.Left);
  const gaze=irisGaze(result.faceLandmarks[0],1-blinkL,1-blinkR,options.aspect||1);
  let weight=0,gx=0,gy=0;
  for(const [side,open] of [['Left',1-blinkL],['Right',1-blinkR]]){
    const w=open**2,sign=side==='Left'?1:-1;weight+=w;
    gx+=w*(raw('eyeLookIn'+side)-raw('eyeLookOut'+side))*sign*1.6;
    gy+=w*(raw('eyeLookUp'+side)-raw('eyeLookDown'+side))*1.6;
  }
  const blend=.65*gaze.confidence;
  v.ParamEyeBallX=clamp(blend*gaze.x+(1-blend)*(weight?gx/weight:0),-1,1);
  v.ParamEyeBallY=clamp(blend*gaze.y+(1-blend)*(weight?gy/weight:0),-1,1);
  // A closed pair carries no reliable gaze; the smoother holds the last open-eye value.
  if(weight<.06)v.ParamEyeBallX=v.ParamEyeBallY=NaN;
  for(const [dest,side] of [['L','Right'],['R','Left']]){
    v['ParamBrow'+dest+'Y']=clamp((b('browInnerUp')*.55+b('browOuterUp'+side)*.65-b('browDown'+side))*(gain.brow??1),-1,1);
    v['ParamBrow'+dest+'Angle']=clamp(b('browDown'+side)*(gain.brow??1)*.8,-1,1);
  }
  const jaw=Math.pow(clamp(b('jawOpen')*(gain.mouth??1),0,1),.72),stretch=(b('mouthStretchLeft')+b('mouthStretchRight'))/2;
  const wide=Math.max(smile,stretch),round=Math.max(b('mouthFunnel'),b('mouthPucker'));
  const form=clamp((wide-round)*(gain.mouth??1),-1,1),press=(b('mouthPressLeft')+b('mouthPressRight'))/2;
  // Continuous Form x OpenY vowel lattice: a (0,1), i (+1,.3), e (+1,.6),
  // u (-1,.3), o (-1,1). At jaw=.3 i/u share openness; wide jaw=1 gives e.
  const latticeOpen=jaw*(1-.4*Math.max(form,0)*clamp((jaw-.3)/.7,0,1));
  v.ParamMouthOpenY=clamp(latticeOpen*(1-.85*press)*(1-.5*b('mouthClose')),0,1);
  // Lip separation supplies teeth-showing grin even when the jaw barely moves.
  // Smile alone never opens the mouth; upper lip lift AND lower lip/stretch
  // evidence must agree. Pucker, press and lip close suppress the grin branch.
  const upper=(raw('mouthUpperUpLeft')+raw('mouthUpperUpRight'))/2;
  const lower=(raw('mouthLowerDownLeft')+raw('mouthLowerDownRight'))/2;
  const rawSmile=(raw('mouthSmileLeft')+raw('mouthSmileRight'))/2;
  const grin=smoothstep(.45,.70,upper)*smoothstep(.04,.18,rawSmile)*
    Math.max(smoothstep(.03,.10,lower),smoothstep(.10,.45,stretch))*(1-round)*(1-press)*(1-b('mouthClose'));
  v.ParamMouthOpenY=Math.max(v.ParamMouthOpenY,grin);
  v.ParamMouthForm=form+(1-form)*smoothstep(.20,.65,grin);
  v.ParamMouthPress=press;
  v.ParamMouthShrug=Math.max(b('mouthShrugUpper'),b('mouthShrugLower'));
  v.ParamMouthPout=b('mouthPucker');
  return {values:v,angles,translation,shapes,gaze,blink:{left:blinkL,right:blinkR},mouth:{jaw,wide,round,press,grin,upper,lower},squint};
}

// Explicit per-parameter settings. Beta has units Hz / (parameter units per second).
export const FILTER_CONFIG=Object.freeze(Object.fromEntries(Object.keys(DEFAULTS).map(id=>{
  const c=id.startsWith('ParamAngle')?[1.8,.12,8,0]:id==='ParamBodyAngleX'?[.002,120,5,5.6]:id==='ParamBodyAngleY'?[.02,60,3,3]:id==='ParamBodyAngleZ'?[.02,60,8,6]:
    /Eye[LR]Open/.test(id)?[2.8,6,8]:id.startsWith('ParamEyeBall')?[.75,1.8,3]:
    id.startsWith('ParamMouth')?[1.1,2.8,5]:id.startsWith('ParamBrow')?[.7,1.8,3]:[1,1,3];
  return [id,Object.freeze({min_cutoff:c[0],beta:c[1],d_cutoff:c[2],velocity_floor:c[3]??0})];
})));
export class OneEuroFilter{
  constructor(value=0){this.value=value;this.raw=value;this.derivative=0;this.initialized=false;}
  step(input,dt,config){
    if(!Number.isFinite(input))return this.value;
    dt=clamp(dt,.001,.25);const alpha=c=>1/(1+1/(2*Math.PI*c*dt));
    if(!this.initialized){this.raw=input;this.initialized=true;}
    const velocity=(input-this.raw)/dt;this.raw=input;
    this.derivative+=alpha(config.d_cutoff)*(velocity-this.derivative);
    // Continuous speed gate: noise retains the low cutoff, deliberate motion
    // opens bandwidth immediately. Convex interpolation, no prediction/spring.
    this.value+=alpha(config.min_cutoff+config.beta*Math.max(0,Math.abs(this.derivative)-(config.velocity_floor??0)))*(input-this.value);
    return this.value;
  }
}

const SWITCH_IDS=['ParamMouthPress','ParamMouthShrug','ParamMouthPout'];
export const parameterBounds=id=>/Angle/.test(id)?(id.startsWith('ParamBody')?[-10,10]:[-30,30]):/EyeBall|Brow|MouthForm/.test(id)?[-1,1]:[0,1];
// responseSeconds is the 90% settling time of a critically damped step (3.89/omega).
// It is NOT an additional frame delay. Acceleration is in parameter units / s².
export const SPRING_CONFIG=Object.freeze(Object.fromEntries(Object.keys(DEFAULTS).map(id=>{
  const [responseSeconds,maxAcceleration]=id.startsWith('ParamAngle')?[.065,20000]:
    id==='ParamBodyAngleX'?[.05,4000]:id.startsWith('ParamBody')?[.075,4000]:/Eye[LR]Open/.test(id)?[.024,6000]:
    /Eye[LR]Smile/.test(id)?[.028,12000]:id.startsWith('ParamEyeBall')?[.055,180]:
    id.startsWith('ParamBrow')?[.065,200]:id.startsWith('ParamMouth')?[.035,900]:[.08,200];
  return [id,Object.freeze({responseSeconds,maxAcceleration})];
})));

// Median before the nonlinear curve and One Euro. The former 30 deg/s speed
// floor froze slow Y/Z motion then released accumulated error as a visible snap.
export class PoseOutlierGuard{
  constructor(){this.reset();}
  reset(){this.median=new Median3();this.rejected=0;this.time=null;}
  step(angles,time){
    if(this.time!==null&&(time<=this.time||time-this.time>.15))this.reset();
    this.time=time;
    return Object.fromEntries(['x','y','z'].map(k=>{
      const value=this.median.step(k,angles[k],true);if(Math.abs(value-angles[k])>1)this.rejected++;
      return [k,value];
    }));
  }
}

export class ParameterSmoother{
  constructor({smoothness=.5,autoMouth=false,bodyResponse=.150}={}){
    this.values={...DEFAULTS};this.velocity=Object.fromEntries(Object.keys(DEFAULTS).map(k=>[k,0]));
    this.filters=Object.fromEntries(Object.entries(DEFAULTS).map(([k,v])=>[k,new OneEuroFilter(v)]));
    this.smoothness=smoothness;this.autoMouth=autoMouth;this.bodyResponse=bodyResponse;this.samples=[];this.lastInput=null;this.pending={};this.rejected={};
    this.robust=new Median3();this.eyeSmile={L:false,R:false};this.switch=null;this.switchAt=-Infinity;this.transition=null;this.time=0;this.tracked=false;
  }
  setSmoothness(v){this.smoothness=clamp(v,0,1);}
  setAutoMouth(v){this.autoMouth=!!v;}
  setBodyResponse(seconds){this.bodyResponse=clamp(seconds,.120,.180);}
  // Source changes/loss discard stale prediction, never position or velocity.
  invalidate(){this.robust.reset();this.samples=[];this.lastInput=null;this.pending={};this.tracked=false;}
  sample(target,time,sourceTime=time,reliability={weight:1}){
    if(this.samples.length&&sourceTime<=this.samples.at(-1).sourceTime)this.invalidate();
    const recovering=!this.tracked||!this.samples.length;
    const dt=recovering?1/25:clamp(sourceTime-this.samples.at(-1).sourceTime,.001,.25),filtered={},accepted={};
    for(const id of Object.keys(DEFAULTS)){
      let input=Number.isFinite(target[id])?target[id]:(this.lastInput?.[id]??this.values[id]);
      // Expression impulse guard: confirm only huge isolated jumps; never gate lids.
      const limit=/Angle/.test(id)?25:/EyeBall|Brow/.test(id)?1.2:id==='ParamMouthForm'?1.6:id==='ParamMouthOpenY'?.85:Infinity;
      if(!recovering&&Math.abs(input-this.lastInput[id])>limit){
        if(this.pending[id]===undefined||Math.abs(input-this.pending[id])>limit*.5){this.pending[id]=input;input=this.lastInput[id];this.rejected[id]=(this.rejected[id]||0)+1;}else delete this.pending[id];
      }else delete this.pending[id];
      if(/EyeBall|Brow|Mouth/.test(id))input=this.robust.step(id,input);
      accepted[id]=input;
      if(recovering){this.filters[id].value=this.everTracked?input:this.values[id];this.filters[id].raw=input;this.filters[id].derivative=0;this.filters[id].initialized=true;}
      const base=FILTER_CONFIG[id],factor=2**((.5-this.smoothness)*2)*(/Eye[LR]Open/.test(id)?1:(reliability.weight??1));
      filtered[id]=/Eye[LR]Smile|Mouth(Press|Shrug|Pout)/.test(id)?input:this.filters[id].step(input,dt,{...base,min_cutoff:base.min_cutoff*factor,beta:base.beta*factor});
    }
    this.lastInput=accepted;this.tracked=true;this.everTracked=true;
    this.samples.push({time,sourceTime,values:filtered});if(this.samples.length>2)this.samples.shift();
    return filtered;
  }
  holdImage(target,time){
    // A still image has no later detection samples to converge its OneEuro state.
    // Set the stationary target directly; the render spring still eases into it.
    this.sample(target,time);
    for(const id of Object.keys(DEFAULTS))if(Number.isFinite(target[id])){
      this.filters[id].value=target[id];this.samples.at(-1).values[id]=target[id];
    }
    this.samples=this.samples.slice(-1);
  }
  targetAt(time,tracked){
    if(!tracked||!this.samples.length)return {...DEFAULTS};
    const b=this.samples.at(-1),a=this.samples[0],interval=b.time-a.time,result={...b.values};
    // Extrapolation horizon is never more than half a detection interval.
    // Hold a half-interval lead, then fade it on stale input (the spring keeps velocity).
    const age=Math.max(0,time-b.time),h=interval*.5;
    const lead=h>0?h*Math.exp(-Math.max(0,age-interval)/h):0;
    for(const id of Object.keys(result)){
      if(interval>0&&!/Eye[LR]|Mouth(Press|Shrug|Pout)/.test(id)&&!(this.bodyResponse&&id.startsWith('ParamBody'))){
        const speed=(b.values[id]-a.values[id])/interval;
        // Predict deliberate motion only; no amplification of stationary noise.
        const gate=smoothstep(/Angle/.test(id)?.1:.15,/Angle/.test(id)?2:1,Math.abs(speed));
        result[id]+=speed*lead*gate;
      }
      result[id]=clamp(result[id],...parameterBounds(id));
    }
    return result;
  }
  mouthTarget(target,time,tracked){
    const current=this.switch,allowed=this.autoMouth&&tracked;
    let winner=current;
    if(!allowed)winner=null;
    else if(time-this.switchAt>=.2&&(!current||target[current]<.45))winner=SWITCH_IDS.filter(k=>target[k]>.7).sort((a,b)=>target[b]-target[a])[0]??null;
    if(!this.transition&&winner!==current)this.transition={start:time,next:winner};
    let envelope=1;
    if(this.transition){
      const age=time-this.transition.start;
      envelope=1-smoothstep(0,.08,age);
      if(age>=.08&&this.transition.swapped===undefined&&this.values.ParamMouthOpenY<.08){
        this.switch=this.transition.next;this.switchAt=time;this.transition.swapped=time;
      }
      if(this.transition.swapped!==undefined){
        envelope=smoothstep(0,.08,time-this.transition.swapped);
        if(time-this.transition.swapped>=.08)this.transition=null;
      }
    }
    target.ParamMouthOpenY*=envelope;
    for(const k of SWITCH_IDS)target[k]=this.switch===k?1:0;
  }
  render(time,dt,tracked=true){
    if(!Number.isFinite(dt)||dt<=0)return this.values;
    // A long background-tab pause is treated as loss, then integrated without
    // resetting velocity; at most 2 s is sufficient to settle to neutral.
    if(dt>.25){tracked=false;this.invalidate();}
    if(!tracked&&this.tracked)this.invalidate();
    const target=this.targetAt(time,tracked);
    // Both eyes switch to smile drawings together; per-eye thresholds left one
    // eye ^ and the other half open, which read as a constant wink. Only a real
    // wink (one lid clearly lower) falls back to per-eye decisions. A laugh may
    // squeeze the lids shut, so a strong pair score ignores the open gate.
    const winking=['L','R'].some(side=>{const open=target[`ParamEye${side}Open`],other=target[`ParamEye${side==='L'?'R':'L'}Open`];return open<.75&&other-open>.20;});
    // Decide both eyes from the unmodified targets first: forcing one lid open
    // before judging the other made the second eye look like a wink.
    const pair=(target.ParamEyeLSmile+target.ParamEyeRSmile)/2;
    for(const side of ['L','R']){
      const smile=`ParamEye${side}Smile`,open=`ParamEye${side}Open`,other=`ParamEye${side==='L'?'R':'L'}Open`;
      const wink=target[open]<.75&&target[other]-target[open]>.20,score=winking?target[smile]:pair,laugh=!winking&&score>.75;
      if(!tracked||score<.35||(target[open]<.3&&!laugh)||wink)this.eyeSmile[side]=false;
      else if(score>.6&&(target[open]>.55||laugh))this.eyeSmile[side]=true;
    }
    for(const side of ['L','R']){
      const smile=`ParamEye${side}Smile`,open=`ParamEye${side}Open`;
      target[smile]=this.eyeSmile[side]?1:0;
      // All changes pass through the lid spring; no direct eye-open assignment.
      if(this.eyeSmile[side])target[open]=1;
    }
    this.mouthTarget(target,time,tracked);
    const elapsed=Math.min(dt,2),steps=Math.ceil(elapsed/.001),h=elapsed/steps;
    for(const id of Object.keys(DEFAULTS)){
      // These model axes select discrete drawings. Only this opt-in branch is
      // discrete; the open-axis envelope masks both sides of the swap.
      if(SWITCH_IDS.includes(id)){this.values[id]=target[id];continue;}
      if(this.bodyResponse&&id.startsWith('ParamBody')){
        // Exact critically damped solution: no 1ms integration loop for body.
        // Project inherited velocity into the monotone solution cone: on a
        // reversal, stop immediately instead of moving away or crossing target.
        // The mapping keeps its translation contribution; only following changes.
        const x=this.values[id],goal=target[id],error=goal-x;
        const w=3.89/(tracked?this.bodyResponse:.40),direction=Math.sign(error);
        const v=direction*clamp(this.velocity[id]*direction,0,w*Math.abs(error));
        const c=v-w*error,decay=Math.exp(-w*elapsed);
        this.values[id]=clamp(goal+(-error+c*elapsed)*decay,Math.min(x,goal),Math.max(x,goal));
        this.velocity[id]=(v-w*c*elapsed)*decay;
        continue;
      }
      // Clear a smile drawing faster than the closing lid, without resetting its
      // velocity. This preserves a short blink/wink that starts inside a smile.
      const cfg=SPRING_CONFIG[id],eyeSmile=/Eye[LR]Smile/.test(id);
      const response=eyeSmile&&target[id]===0?.016:cfg.responseSeconds;
      const omega=3.89/(tracked?response:.40),A=eyeSmile&&target[id]>0?2000:cfg.maxAcceleration;

      let x=this.values[id],v=this.velocity[id];
      for(let i=0;i<steps;i++){
        // Reduce stiffness for large errors so saturation doesn't remove the
        // critical damping ratio or fling the state across a physical limit.
        const w=Math.min(omega,Math.sqrt(A/Math.max(1e-9,Math.abs(target[id]-x))));
        const acceleration=clamp(w*w*(target[id]-x)-2*w*v,-A,A);
        x+=v*h+.5*acceleration*h*h;v+=acceleration*h;
      }
      this.values[id]=x;this.velocity[id]=v;
    }
    this.time=time;return this.values;
  }
  // Compatibility for callers with one input per tick; app uses separate clocks.
  step(target,dt,tracked){const time=this.time+dt;if(tracked)this.sample(target,time);return this.render(time,dt,tracked);}
}
