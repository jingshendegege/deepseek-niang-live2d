// Shared by facetrack and the AI host. No renderer or face-mapping dependencies.
export function createSfx({baseURL=null,streamer=false,storageKey='deepseek-sfx'}={}) {
  const api={events:[],errors:[],enabled:!!baseURL,volume:streamer?.12:.45,map:null,context:null};
  const buffers=new Map(),previous=new Map(),voices=new Set();
  let last=-Infinity,master,savedSettings=false,controls;
  try {const v=JSON.parse(localStorage.getItem(storageKey));if(v){savedSettings=true;api.enabled=v.enabled!==false;if(Number.isFinite(v.volume))api.volume=Math.max(0,Math.min(1,v.volume));}} catch {}
  const save=()=>{savedSettings=true;try{localStorage.setItem(storageKey,JSON.stringify({enabled:api.enabled,volume:api.volume}));}catch{}};
  api.setEnabled=value=>{api.enabled=!!value;save();if(!value)for(const voice of voices)voice.stop();};
  api.setVolume=value=>{api.volume=Math.max(0,Math.min(1,Number(value)||0));if(master)master.gain.value=api.volume;save();};
  function context(){if(!api.context){api.context=new AudioContext({latencyHint:'interactive'});master=api.context.createGain();master.gain.value=api.volume;master.connect(api.context.destination);}return api.context;}
  api.unlock=()=>context().resume().catch(e=>api.errors.push(String(e)));
  if(baseURL&&typeof document!=='undefined')for(const event of ['pointerdown','keydown'])document.addEventListener(event,()=>{void api.unlock();},{capture:true});
  api.ready=(async()=>{
    if(!baseURL)return api;
    const response=await fetch(new URL('sfx_map.json',baseURL));if(!response.ok)throw Error('sfx_map: '+response.status);
    api.map=await response.json();
    if(!savedSettings){api.volume=streamer?api.map.streamerVolume:api.map.defaultVolume;if(master)master.gain.value=api.volume;if(controls)controls.slider.value=Math.round(api.volume*100);}
    const names=new Set();const collect=x=>{if(typeof x==='string')names.add(x);else if(x&&typeof x==='object')Object.values(x).forEach(collect);};
    collect(api.map.groups);collect(api.map.expressions);collect(api.map.prefixes);
    for(const k of ['faceOn','clear','knock','motion','hair','bow'])collect(api.map[k]);
    Object.keys(api.map.groups).forEach(k=>names.delete(k));
    await Promise.all([...names].map(async name=>{const r=await fetch(new URL(name+'.ogg',baseURL));if(!r.ok)throw Error(name+': '+r.status);buffers.set(name,await context().decodeAudioData(await r.arrayBuffer()));}));
    return api;
  })().catch(e=>{api.errors.push(String(e));console.warn('SFX preload:',e);return api;});
  api.playSfx=(name,{gain=1,pitch=1}={})=>{
    const now=performance.now(),group=api.map?.groups[name],choices=group?.filter(n=>n!==previous.get(name));
    const chosen=choices?.length?choices[Math.floor(Math.random()*choices.length)]:name;
    const event={name:chosen,requested:name,time:now,status:'skipped'};
    if(api.events.length>=5000)api.events.shift();api.events.push(event);
    if(!api.enabled){event.reason='disabled';return false;}
    if(now-last<(api.map?.cooldownMs??120)){event.reason='cooldown';return false;}
    if(!buffers.has(chosen)||api.context?.state!=='running'){event.reason='not-ready-or-locked';return false;}
    const ctx=context(),source=ctx.createBufferSource(),volume=ctx.createGain();
    source.buffer=buffers.get(chosen);source.playbackRate.value=Math.max(.1,pitch)*(group?(.95+Math.random()*.1):1);
    // Single foreground effect, with a short crossfade instead of overlapping tails.
    for(const v of voices){v.volume.gain.setTargetAtTime(0,ctx.currentTime,.012);v.stop(ctx.currentTime+.06);}
    volume.gain.value=Math.max(0,gain);source.connect(volume);volume.connect(master);source.volume=volume;
    voices.add(source);source.onended=()=>{voices.delete(source);source.disconnect();volume.disconnect();};
    source.start();last=now;previous.set(name,chosen);
    Object.assign(event,{status:'played',pitch:source.playbackRate.value,gain:gain*api.volume,audioTime:ctx.currentTime});
    return true;
  };
  api.soundFor=(key,on=true)=>{const m=api.map;if(!m)return null;const rule=m.expressions[key]||Object.entries(m.prefixes).find(([p])=>key.startsWith(p))?.[1];return rule?.[on?'on':'off']||(on&&m.faceExpressions.includes(key)?m.faceOn:null);};
  api.expression=(key,on=true)=>{const name=api.soundFor(key,on);if(name)return api.playSfx(name);return false;};
  api.motion=name=>{if(api.map&&new RegExp(api.map.motionPattern,'i').test(name))return api.playSfx(api.map.motion);return false;};
  api.mount=host=>{
    if(!baseURL)return null;
    const row=document.createElement('div');row.className='sfx-controls';row.style.cssText='display:flex;gap:12px;align-items:center;padding:8px 0';
    const label=document.createElement('label'),toggle=document.createElement('input');toggle.type='checkbox';toggle.checked=api.enabled;toggle.id='sfx-enabled';label.append(toggle,' 音效');
    const slider=document.createElement('input');slider.type='range';slider.id='sfx-volume';slider.min=0;slider.max=100;slider.value=Math.round(api.volume*100);slider.setAttribute('aria-label','音效音量');slider.style.width='110px';
    controls={toggle,slider};toggle.onchange=()=>api.setEnabled(toggle.checked);slider.oninput=()=>api.setVolume(slider.value/100);row.append(label,slider);host.append(row);return row;
  };
  return api;
}
let defaultSfx;
export const playSfx=(name,options)=>(defaultSfx??=createSfx()).playSfx(name,options);
export const getSfx=()=>defaultSfx??=createSfx();

// A smooth finite contact force driving x''+2*w*x'+w*w*x=f(t).
// x=-A*(w*t/3)^3*exp(3-w*t), w=60. C2 at t=0, peak at 50ms,
// <0.001 deg by 350ms. Unlike resetting a spring, this has no acceleration jump.
export function dipAt(t,amplitude=6){
  if(t<=0||!Number.isFinite(t)||t>12)return {y:0,v:0,a:0};
  const w=60,c=-amplitude*Math.exp(3)*w**3/27,e=Math.exp(-w*t);
  return {y:c*t**3*e,v:c*e*(3*t*t-w*t**3),a:c*e*(6*t-6*w*t*t+w*w*t**3)};
}
export class BasinReaction {
  start=-Infinity; amplitude=6; kind='on'; contact=null; contacted=true;
  residual={y:0,v:0,a:0};
  pose(t){
    const p=dipAt(t,this.amplitude);if(!Number.isFinite(t)||t<0||t>12)return p;
    const {y,v,a}=this.residual,w=60,b=v+w*y,c=(a+2*w*v+w*w*y)/2,e=Math.exp(-w*t),f=y+b*t+c*t*t,df=b+2*c*t;
    return {y:p.y+e*f,v:p.v+e*(df-w*f),a:p.a+e*(2*c-2*w*df+w*w*f)};
  }
  trigger(kind,contact,now=performance.now()){
    // Never reset a moving spring or add impulses; quick repeated taps coalesce.
    if(now-this.start<350){contact?.();return false;}
    this.residual=this.pose((now-this.start)/1000);
    this.start=now;this.amplitude=kind==='knock'?3:6;this.kind=kind;this.contact=contact;this.contacted=false;return true;
  }
  sample(now=performance.now()){
    const t=(now-this.start)/1000;
    if(!this.contacted&&t>=.05){this.contacted=true;this.contact?.();this.contact=null;}
    const p=this.pose(t);
    const squint=this.kind==='knock'&&t>0&&t<.15?.8*Math.sin(Math.PI*t/.15)**4:0;
    return {...p,squint,body:p.y*.12,t};
  }
  cancelContact(){this.contact=null;this.contacted=true;}
}

export function probeBasin(core){
  const original=core.getParameterValueById('ParamAccBasin');
  try{
    core.setParameterValueById('ParamAccBasin',0);core.update();
    const off=Array.from({length:core.getDrawableCount()},(_,i)=>core.getDrawableOpacity(i));
    core.setParameterValueById('ParamAccBasin',1);core.update();
    return off.flatMap((v,i)=>core.getDrawableOpacity(i)>v+.01?[i]:[]);
  }finally{core.setParameterValueById('ParamAccBasin',original);core.update();}
}
export function triangleHit(x,y,vertices,indices){
  const cross=(ax,ay,bx,by,cx,cy)=>(bx-ax)*(cy-ay)-(by-ay)*(cx-ax);
  for(let j=0;j<indices.length;j+=3){
    const a=indices[j]*2,b=indices[j+1]*2,c=indices[j+2]*2;
    if(Math.abs(cross(vertices[a],vertices[a+1],vertices[b],vertices[b+1],vertices[c],vertices[c+1]))<1e-10)continue;
    const u=cross(vertices[a],vertices[a+1],vertices[b],vertices[b+1],x,y),v=cross(vertices[b],vertices[b+1],vertices[c],vertices[c+1],x,y),w=cross(vertices[c],vertices[c+1],vertices[a],vertices[a+1],x,y);
    if((u>=-1e-7&&v>=-1e-7&&w>=-1e-7)||(u<=1e-7&&v<=1e-7&&w<=1e-7))return true;
  }return false;
}
