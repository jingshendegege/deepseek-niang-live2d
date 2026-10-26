// v4y integration point: all driver IDs, amplitudes and timing live here.
// Since v4y, ParamSkelTailSwing is a NORMAL physics input (range -0.6..0.45) written
// before physics; PhysicsV4yTailWave outputs ParamTail1..4 with per-segment lag.
// Light = the v4y-tested signal 0.18*sin(2*pi*t/4.8); no post-physics offset (output:null).
export const TAIL_IDLE_CONFIG=Object.freeze({period:4.8,fadeSeconds:.5,bodyFollow:.035,
  levels:{off:0,light:.20,medium:.35},
  input:{id:'ParamSkelTailSwing',amplitude:.9},output:null,
  physicsOutputs:['ParamTail1','ParamTail2','ParamTail3','ParamTail4']});
export function createTailIdle(storageKey='deepseek-tail-idle'){
  let level='light',amount=TAIL_IDLE_CONFIG.levels.light,last=null;
  try{const v=localStorage.getItem(storageKey);if(Object.hasOwn(TAIL_IDLE_CONFIG.levels,v))level=v;}catch{}
  amount=TAIL_IDLE_CONFIG.levels[level];
  return {get level(){return level;},set(v){if(!Object.hasOwn(TAIL_IDLE_CONFIG.levels,v))throw Error('Unknown tail level');level=v;try{localStorage.setItem(storageKey,v);}catch{}},
    sample(seconds,bodyX=0,motion=false){
      const c=TAIL_IDLE_CONFIG,dt=last===null?0:Math.max(0,Math.min(.1,seconds-last));last=seconds;
      const goal=motion?0:c.levels[level];amount+=(goal-amount)*(1-Math.exp(-dt/c.fadeSeconds));
      const wave=Math.sin(seconds*2*Math.PI/c.period)+Math.max(-1,Math.min(1,bodyX/10))*c.bodyFollow;
      const out={[c.input.id]:wave*amount*c.input.amplitude};
      if(c.output)out[c.output.id]=wave*amount*c.output.amplitude;
      return out;
    }};
}
export function mountTailIdle(host,api){const label=document.createElement('label');label.textContent='尾巴摆动 ';const select=document.createElement('select');select.id='tail-idle';for(const [v,t]of [['off','关'],['light','轻'],['medium','中']]){const o=document.createElement('option');o.value=v;o.textContent=t;select.append(o);}select.value=api.level;select.onchange=()=>api.set(select.value);label.append(select);host.append(label);}
