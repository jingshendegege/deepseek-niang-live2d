// Versioned, portable profile. Neutral-only video estimation never invents expression maxima.
export const CALIBRATION_KEY='deepseek-facetrack-calibration-v2';
export const STEPS=Object.freeze([
  {id:'neutral',label:'放松正脸',seconds:2}, {id:'blink',label:'闭上双眼',seconds:1.5},
  {id:'jaw',label:'张大嘴',seconds:1.5}, {id:'smile',label:'大笑',seconds:1.5},
  {id:'frown',label:'皱眉',seconds:1.5}, {id:'brow',label:'抬眉',seconds:1.5}
]);
export const DEFAULT_RANGES=Object.freeze(Object.fromEntries([
  ...['Left','Right'].flatMap(s=>[
    ['eyeBlink'+s,[.08,.55]],['mouthSmile'+s,[.02,.8]],['mouthStretch'+s,[.02,.65]],
    ['mouthFrown'+s,[.02,.65]],['mouthPress'+s,[.02,.8]],['browDown'+s,[.02,.65]],
    ['browOuterUp'+s,[.02,.65]],['eyeSquint'+s,[.02,.85]],['cheekSquint'+s,[.02,.85]]]),
  ['jawOpen',[.025,.65]],['browInnerUp',[.02,.65]],['mouthFunnel',[.02,.75]],
  ['mouthPucker',[.02,.85]],['mouthShrugUpper',[.02,.8]],['mouthShrugLower',[.02,.8]],['mouthClose',[.02,.8]]
]));
export const quantile=(xs,q)=>{const a=xs.filter(Number.isFinite).sort((a,b)=>a-b);if(!a.length)return 0;const p=(a.length-1)*q,i=Math.floor(p);return a[i]+(a[Math.min(i+1,a.length-1)]-a[i])*(p-i);};
export function validProfile(p){return p?.version===2 && p.zero && ['x','y','z','tx','ty','tz'].every(k=>Number.isFinite(p.zero[k])) && p.ranges && Object.entries(p.ranges).every(([k,r])=>k in DEFAULT_RANGES && Array.isArray(r)&&r.length===2&&r.every(Number.isFinite)&&r[0]>=0&&r[1]<=1&&r[1]-r[0]>=.08);}
export function buildCalibration(samples){
  const neutral=samples.neutral||[];
  if(neutral.length<8)throw Error('有效正脸样本不足，请保持正脸后重新校准。');
  const ranges={},fallback=[];
  const zero=Object.fromEntries(['x','y','z','tx','ty','tz'].map(k=>[k,quantile(neutral.map(f=>k.length===1?f.angles[k]:f.translation[k.slice(1)]),.5)]));
  for(const [name,[lo,hi]] of Object.entries(DEFAULT_RANGES)){
    // Resting squint and lip posture must not become a strong expression baseline.
    const low=Math.min(.55,quantile(neutral.map(f=>f.shapes[name]||0),.5));
    const group=name.startsWith('eyeBlink')?'blink':name==='jawOpen'?'jaw':/mouthSmile|mouthStretch|Squint/.test(name)?'smile':/browDown|mouthFrown/.test(name)?'frown':/brow/.test(name)?'brow':null;
    const rows=group?samples[group]:null;
    const high=rows?.length>=8?quantile(rows.map(f=>f.shapes[name]||0),.9):0;
    if(high-low>=.12)ranges[name]=[low,Math.min(1,high)];
    else {ranges[name]=[low,Math.min(1,Math.max(low+.12,low+hi-lo))];fallback.push(name);}
  }
  return {version:2,createdAt:new Date().toISOString(),mode:STEPS.every(s=>samples[s.id]?.length>=8)?'personal':'neutral-only',zero,ranges,fallback,sampleCounts:Object.fromEntries(STEPS.map(s=>[s.id,samples[s.id]?.length||0]))};
}
export class CalibrationSession{
  constructor(){this.index=0;this.elapsed=0;this.prepare=1;this.samples={};this.lastTime=null;this.done=false;}
  update(face,time){
    if(this.done)return null;
    const dt=this.lastTime===null?0:Math.max(0,Math.min(.1,(time-this.lastTime)/1000));this.lastTime=time;
    if(!face)return {text:'没有检测到人脸，采样已暂停。'};
    const s=STEPS[this.index];
    if(this.prepare>0){this.prepare-=dt;return {text:`准备 ${this.index+1}/6：${s.label}（${Math.max(1,Math.ceil(this.prepare))} 秒后采样）`};}
    (this.samples[s.id]??=[]).push(face);this.elapsed+=dt;
    if(this.elapsed+1e-8<s.seconds)return {text:`${this.index+1}/6：${s.label} · 请保持 ${(s.seconds-this.elapsed).toFixed(1)} 秒`};
    this.index++;this.elapsed=0;this.prepare=1;
    if(this.index===STEPS.length){this.done=true;return {profile:buildCalibration(this.samples),text:'六步校准完成'};}
    return {text:`下一步：${STEPS[this.index].label}`};
  }
}
