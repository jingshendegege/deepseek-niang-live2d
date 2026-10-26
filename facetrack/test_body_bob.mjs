import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {BODY_BOB_CONFIG as C,bobEnvelope,createBodyBob,writeBodyBob,mountBodyBob} from './body-bob.mjs';
const checks=[],pass=s=>checks.push(s),near=(a,b,e=1e-8)=>assert(Math.abs(a-b)<e,`${a} != ${b}`);
const make=options=>createBodyBob({storage:null,random:()=>.5,...options});
const sample=(bob,t,options={})=>bob.sample(t,{source:true,...options}).value;
for(const fps of [15,30,60,120,1000]){
  const bob=make();bob.trigger(0);let previous=0;
  for(let i=0;i<=fps;i++){
    const t=i/fps,v=sample(bob,t);assert(v>=-1&&v<=0);
    if(t<=.12)assert(v<=previous+1e-10);
    if(t>=.12+1/fps)assert(v>=previous-1e-10);
    previous=v;
  }
  assert.equal(sample(bob,1),0);
}
near(bobEnvelope(.12),1);near(bobEnvelope(.37),0);
pass('15/30/60/120/1000 FPS: single dip is monotone down/up, bounded [-1,0], exact zero after 370 ms');

const clicks=make();clicks.trigger(0);
for(const t of [.04,.08,.12,.14,.21,.35,.38]){
  const h=1e-6,before=sample(clicks,t),left=(before-sample(clicks,t-h))/h;
  clicks.trigger(t);near(sample(clicks,t),before);
  const right=(sample(clicks,t+h)-before)/h;near(left,right,.01);
}
for(let i=400;i<1500;i++){const v=sample(clicks,i/1000);assert(v>=-1&&v<=0);}
assert.equal(sample(clicks,2),0);
pass('Rapid repeated clicks preserve value and velocity at every trigger and remain bounded');

const missing={_model:{parameters:{ids:['Other']}},setParameterValueById(){throw Error('unknown ID written');}};
assert.equal(writeBodyBob(missing,-.5),false);assert.equal(writeBodyBob(null,-.5),false);
const writes=[],core={_model:{parameters:{ids:[C.input.id],minimumValues:[-.7],maximumValues:[1]}},setParameterValueById:(id,v)=>writes.push([id,v])};
assert(writeBodyBob(core,-1));assert.deepEqual(writes.pop(),[C.input.id,-.7]);
assert(writeBodyBob(core,1));assert.equal(writes.pop()[1],0);assert(!writeBodyBob(core,NaN));
const custom={...C,input:{id:'CustomBob',limit:1}};
core._model.parameters.ids=['CustomBob'];assert(writeBodyBob(core,-.4,custom));assert.equal(writes.pop()[0],'CustomBob');
pass('Missing parameters silently skip; configured ID and model limits respected; no skirt output writes');

const store=new Map(),storage={getItem:k=>store.get(k),setItem:(k,v)=>store.set(k,v)};
const idle=make({storage});assert.deepEqual(idle.enabled,{idle:true,face:true});
sample(idle,0,{source:false});sample(idle,6,{source:false});near(sample(idle,6.16,{source:false}),-.2);
const offAt=6.17,prior=sample(idle,offAt,{source:false});idle.setEnabled('idle',false,offAt);
near(sample(idle,offAt,{source:false}),prior);assert.equal(sample(idle,6.3,{source:false}),0);
assert.equal(sample(idle,30,{source:false}),0);assert.equal(make({storage}).enabled.idle,false);
idle.setEnabled('face',false,31);assert.equal(make({storage}).enabled.face,false);
idle.trigger(32);assert(sample(idle,32.12)<-.99);
const blocked=make({storage:{getItem(){throw Error('blocked');},setItem(){throw Error('blocked');}}});blocked.setEnabled('idle',false,0);
Object.defineProperty(globalThis,'localStorage',{configurable:true,get(){throw Error('getter blocked');}});
assert.doesNotThrow(()=>createBodyBob());delete globalThis.localStorage;
pass('Idle .2 pulse, persisted defaults/toggles, smooth off to exact zero, manual independent, blocked storage including getter safe');

for(const random of [()=>0,()=>1]){
  const b=make({random});sample(b,0,{source:false});const due=random()===0?4:8;
  assert.equal(sample(b,due-.01,{source:false}),0);sample(b,due,{source:false});
  near(sample(b,due+.16,{source:false}),random()===0?-.15:-.25);
}
for(const mode of [{motion:true,source:false},{source:true}]){
  const b=make();for(let i=0;i<20;i++)assert.equal(sample(b,i,mode),0);
  b.trigger(20);assert(sample(b,20.12,mode)<-.99);
  sample(b,21,{source:false});assert.equal(sample(b,26.9,{source:false}),0);
  sample(b,27,{source:false});assert(sample(b,27.16,{source:false})<-.19);
}
pass('Random idle interval/amplitude endpoints; input and motion suspend auto triggers; no catch-up burst; manual works during motion');

function faceRun({fps=30,kind='pitch',noise=false,options={},disable=false}={}){
  const b=make();let fired=0,lowest=0;
  for(let i=0;i<fps*2;i++){
    const t=i/fps,move=noise?.03*Math.sin(i*2):Math.max(0,Math.min(.22,t-.5));
    fired+=Number(b.observeFace({time:t,at:t,pitch:kind==='pitch'?move*120:0,y:kind==='y'?move*20:0,...options}));
    lowest=Math.min(lowest,sample(b,t));
  }
  if(disable){
    // A second sequence gets its own fresh source baseline, then disable mid-dip.
    b.resetFace();let t=3;
    for(;t<3.8;t+=1/fps){
      const triggered=b.observeFace({time:t,at:t,pitch:Math.max(0,t-3.4)*150,y:0});sample(b,t);
      if(triggered){t+=.07;const v=sample(b,t);assert(v<0);b.setEnabled('face',false,t);near(sample(b,t),v);assert.equal(sample(b,t+.13),0);break;}
    }
    assert(t<3.8);
  }
  return {fired,lowest};
}
for(const fps of [15,30,60,120])for(const kind of ['pitch','y']){
  const r=faceRun({fps,kind});assert.equal(r.fired,1,JSON.stringify({fps,kind,r}));assert(r.lowest<0&&r.lowest>=-.32);
}
for(const options of [{motion:true},{basinActive:true},{live:false},{valid:false}])assert.equal(faceRun({options}).fired,0);
assert.equal(faceRun({noise:true}).fired,0);faceRun({disable:true});
pass('Conservative pitch/vertical velocity trigger at 15/30/60/120 FPS; noise, motion, basin, still/paused input and unreliable faces do not trigger; face toggle releases');

const guarded=make();let count=0;
for(let i=0;i<120;i++){
  const t=i/30,pitch=i===20?8:0;
  count+=Number(guarded.observeFace({time:t,at:t,pitch,y:0}));sample(guarded,t);
}
assert.equal(count,0);
assert(!guarded.observeFace({time:9,at:9,pitch:70,y:10})); // stalled/reacquired source
assert(!guarded.observeFace({time:8,at:9.1,pitch:0,y:0})); // backwards timestamp
pass('Isolated pose spike/reversal, stale gaps and backwards timestamps cannot cause a bob');

const basin=make();basin.trigger(0);const entry=sample(basin,.1);
near(basin.sample(.1,{source:true,basinActive:true}).value,entry);
for(let i=0;i<=50;i++){
  const r=basin.sample(.1+i/1000,{source:true,basinActive:true});
  assert(r.basinWeight>=0&&r.basinWeight<=1);assert(-r.value+r.basinWeight<=1+1e-8);
}
assert.equal(basin.sample(.16,{basinActive:true}).value,0);
basin.trigger(.2);assert.equal(basin.sample(.3,{basinActive:true}).value,0);
assert.equal(basin.sample(.7,{source:true}).value,0);assert(sample(basin,.82)<-.99);
const normalBasin=make();assert.equal(normalBasin.sample(1,{basinActive:true}).basinWeight,1);
pass('Basin body ownership crossfades without doubled depth; normal basin unchanged; manual during basin queues one hop');

// Execute the actual app afterMotionUpdate callback with a core spy, then simulate
// the next physics step. This catches moving the write to after physics or allowing
// layered expressions / motions to overwrite the driver.
const source=fs.readFileSync(new URL('./app.mjs',import.meta.url),'utf8');
const begin=source.indexOf("internal.on('afterMotionUpdate',()=>{");
const end=source.indexOf("\n  internal.on('beforeModelUpdate'",begin);
assert(begin>=0&&end>begin);
const fixture=source.slice(begin,end),calls=[],values=new Map(),driver=make();driver.trigger(0);
const context={performance:{now:()=>120},bodyBob:driver,writeBodyBob:(core,v)=>writeBodyBob(core,v,{...C,active:true}),BODY_BOB_CONFIG:{...C,active:true},
  tailIdle:{sample:()=>({Tail:1})},tailOffsets:{},addTail:id=>calls.push(id),TAIL_IDLE_CONFIG:{input:{id:'Tail'}},
  mouseFollow:{values:{},adoptMotion:()=>({})},state:{mode:'none',motion:{},active:new Map(),expressions:new Map()},
  basinReaction:{sample:()=>({t:Infinity,y:0,body:0,squint:0})},bodySink:0,smoother:{values:{}},
  headBody:()=>false,hasFace:()=>true,sfxSamples:[],basinLanded:false,
  core:{_model:{parameters:{ids:[C.input.id],minimumValues:[-1],maximumValues:[1]}},
    setParameterValueById:(id,v)=>{calls.push(id);values.set(id,v);},getParameterValueById:id=>values.get(id)||0},
  internal:{on:(event,callback)=>{assert.equal(event,'afterMotionUpdate');callback();}}
};
vm.runInNewContext(fixture,context);near(values.get(C.input.id),-1);
calls.push('physics');assert(calls.indexOf('Tail')<calls.indexOf(C.input.id));assert(calls.indexOf(C.input.id)<calls.indexOf('physics'));
assert(C.physicsOutputs.every(id=>!calls.includes(id)));
context.core._model.parameters.ids=[];calls.length=0;vm.runInNewContext(fixture,context);assert(!calls.includes(C.input.id));
context.basinReaction.sample=()=>({t:.01,y:-2,body:-.24,squint:0});vm.runInNewContext(fixture,context);near(context.bodySink,1.4);
pass('Actual afterMotionUpdate hook executes pre-physics, coexists with tail/motion, skips old models and preserves basin fallback');
// User 2026-10-25 turned the hop off: default config must write nothing and keep the full basin dip.
assert.equal(C.active,false);
{const off={...context,BODY_BOB_CONFIG:C,writeBodyBob,bodySink:0};off.core={...context.core,_model:{parameters:{ids:[C.input.id],minimumValues:[-1],maximumValues:[1]}}};calls.length=0;values.clear();
 off.basinReaction={sample:()=>({t:.01,y:-2,body:-.24,squint:0})};vm.runInNewContext(fixture,off);assert(!calls.includes(C.input.id));near(off.bodySink,1.4);}
pass('Hop disabled by default: no ParamBodyBob writes, basin dip unchanged');

const elements=[];globalThis.document={createElement:tag=>{const e={tag,children:[],append(...items){this.children.push(...items);}};elements.push(e);return e;}};
const ui=make();mountBodyBob(document.createElement('div'),ui);
for(const id of ['body-bob-idle','body-bob-face']){
  const input=elements.find(e=>e.id===id);assert(input.checked);input.checked=false;input.onchange();
}
assert.deepEqual(ui.enabled,{idle:false,face:false});delete globalThis.document;
assert.doesNotMatch(fs.readFileSync(new URL('./index.html',import.meta.url),'utf8'),/body-bob-hop/);
assert.match(source,/if\(BODY_BOB_CONFIG\.active\)\{mountBodyBob\(/);
pass('UI toggles still bind when re-enabled; hop button removed and mount gated by BODY_BOB_CONFIG.active');

const out=new URL('../renders/qa/'+(process.env.COLOR_QA||'facetrack_bob')+'/',import.meta.url);
fs.mkdirSync(out,{recursive:true});fs.writeFileSync(new URL('body_bob_tests.json',out),JSON.stringify({passed:true,checks},null,2));
console.log('PASS body bob:',checks.length,'groups');
