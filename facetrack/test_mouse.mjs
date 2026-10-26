import assert from 'node:assert/strict';
import fs from 'node:fs';
import {MouseFollow,MonotoneSpring,mapMouse,faceScreenBounds,bindMouseFollow,FOLLOW_IDS,idleBlink,MOUSE_MAX_X} from './mouse-follow.mjs';
import {DEFAULTS,BODY_FOLLOW_X,ParameterSmoother} from './mapping.mjs';
const checks=[],metrics={},pass=s=>checks.push(s),near=(a,b,e=1e-8)=>assert(Math.abs(a-b)<=e,`${a} vs ${b}`);
const face={x:380,y:220,width:180,height:220},point={x:1100,y:30};
const origin=mapMouse(face,face);for(const v of Object.values(origin))near(v,0);
for(const sign of [-1,1]){
  const v=mapMouse({x:face.x+sign*1e9,y:face.y-sign*1e9},face);
  near(v.ParamAngleX,sign*MOUSE_MAX_X);near(v.ParamAngleY,sign*18);near(v.ParamEyeBallX,sign);near(v.ParamEyeBallY,sign);
  near(v.ParamBodyAngleX,10*Math.tanh(sign*MOUSE_MAX_X*BODY_FOLLOW_X/10));assert(Math.abs(v.ParamAngleZ)<=.65);
}
assert(mapMouse({x:face.x,y:face.y+40},face).ParamAngleY<0);
assert(mapMouse({x:face.x+1,y:face.y},face).ParamAngleX>0);
pass('Face origin, tanh saturation, horizontal/vertical signs, BODY_FOLLOW_X and restrained roll');

// Renderer contract, including local transform, model world, CSS scaling and
// transient basin translation. View changes must shift the origin, never window centre.
let sx=2,tx=30,ty=40;
const model={internalModel:{coreModel:{_model:{drawables:{ids:['ArtMeshFace']}}},
  getDrawableVertices:()=>[10,20,110,20,110,140,10,140],localTransform:{apply:p=>({x:p.x+5,y:p.y-10})}},
  toGlobal:p=>({x:p.x*sx+tx,y:p.y*sx+ty})};
let rect={left:100,top:70,width:600,height:400},screen={width:1200,height:800};
let bounds=faceScreenBounds(model,rect,screen,12);
assert.deepEqual(bounds,{x:180,y:166,width:100,height:120});
sx=1;tx=80;ty=-20;bounds=faceScreenBounds(model,rect,screen);
assert.deepEqual(bounds,{x:172.5,y:95,width:50,height:60});
for(const v of Object.values(mapMouse(bounds,bounds)))near(v,0);
pass('Live mesh -> local/world -> CSS projection survives full/upper/zoom/pan and basin offset');

let maxOvershoot=0;
for(const hz of [15,25,30,60,120,144])for(const response of [.08,.10,.12,.30,.35,1.2]){
  const spring=new MonotoneSpring();
  for(const goal of [25,-25,18,-18,0,1,-1,.000001,0]){
    for(let i=0;i<hz*2;i++){
      const prev=spring.value,x=spring.step(goal,1/hz,response);
      const excess=Math.max(x-Math.max(prev,goal),Math.min(prev,goal)-x,0);maxOvershoot=Math.max(maxOvershoot,excess);
      assert(excess<=1e-12);
    }
  }
  const before=spring.value;spring.step(25,0);near(before,spring.value);
}
metrics.maxOvershoot=maxOvershoot;pass('Step/reversal at 15/25/30/60/120/144 Hz: no overshoot, rebound or motion away from goal');

function create(){const f=new MouseFollow();f.move(point.x,point.y,0);return f;}
const f=create(),target=mapMouse(point,face);let time=0;
const tick=(instance,extra={},dt=1/120)=>instance.step({time:time+=dt,dt,face,...extra});
const arrivals={};
for(let i=0;i<720;i++){
  const v=tick(f);
  for(const [name,id]of [['eye','ParamEyeBallX'],['head','ParamAngleX'],['body','ParamBodyAngleX']])if(!arrivals[name]&&v[id]>=target[id]*.9)arrivals[name]=time;
}
assert(arrivals.eye>=.08&&arrivals.eye<=.12);assert(arrivals.head>=.25&&arrivals.head<=.35);assert(arrivals.body>arrivals.head);
metrics.arrivals90=arrivals;
const held={...f.values};for(let i=0;i<120;i++)tick(f,{face:{...face,x:face.x+Math.sin(i)*2}});
assert.deepEqual(f.values,held);pass('Eyes 80–120 ms, head 250–350 ms, body last; held pointer ignores animated centre noise exactly');
f.leave();const leftAt=time;for(let i=0;i<72;i++)tick(f);
metrics.leaveAt600ms={...f.values};assert(Math.abs(f.values.ParamAngleX)<.25);assert(Math.abs(f.values.ParamEyeBallX)<.01);near(time-leftAt,.6,1e-9);
pass('Window leave / blur return: head within 0.25 degrees and eye within 0.01 at 600 ms');

time=0;const idle=create();for(let i=0;i<960;i++)tick(idle);assert.equal(idle.mode,'idle');
const idleStart=idle.values.ParamAngleX;for(let i=0;i<360;i++)tick(idle);assert(idle.values.ParamAngleX<idleStart*.002);
idle.move(point.x-1,point.y,time);tick(idle);assert.equal(idle.mode,'mouse');
const viewBefore=idle.target.ParamAngleX;tick(idle,{face:{...face,x:950},viewKey:'zoom'});assert(idle.target.ParamAngleX<viewBefore);
pass('8-second inactivity eases to rest; movement reactivates; view changes recompute face-relative target');

// Feed the actual production smoother through camera, still image, no-face and
// stop paths; switching never assigns a new position, even at zero elapsed time.
time=0;const switcher=create(),smoother=new ParameterSmoother();
for(let i=0;i<120;i++)tick(switcher);
const facePose={...DEFAULTS,ParamAngleX:-23,ParamAngleY:14,ParamEyeBallX:-.8,ParamBodyAngleX:-4};
for(const source of [true,false,true,false]){
  smoother.holdImage(facePose,time);const saved={...switcher.values};
  switcher.step({time,dt:0,face,source,faceValues:smoother.values});assert.deepEqual(switcher.values,saved);
  for(let i=0;i<120;i++){
    smoother.render(time+1/120,1/120,source);
    tick(switcher,{source,faceValues:smoother.values});
    for(const id of FOLLOW_IDS)assert(Number.isFinite(switcher.values[id]));
  }
}
const extreme=create();for(let i=0;i<120;i++)extreme.step({time:i/60,dt:1/60,face});
const entry=extreme.values.ParamAngleX;
extreme.step({time:2,dt:1/60,face,source:true,faceValues:{...DEFAULTS,ParamAngleX:-25}});
assert(Math.abs(extreme.values.ParamAngleX-entry)<1.2,'Opposite source handoff must not snap at 60 Hz');
const beforeMissing={...switcher.values};switcher.step({time,dt:0,source:true,faceValues:DEFAULTS});assert.deepEqual(switcher.values,beforeMissing);assert.equal(switcher.mode,'face');
const motionPose={ParamAngleX:-12,ParamAngleY:7,ParamAngleZ:2,ParamBodyAngleX:-2,ParamBodyAngleY:1,ParamBodyAngleZ:.5};
switcher.adoptMotion(motionPose);for(let i=0;i<30;i++)tick(switcher,{motion:true});
for(const [id,value]of Object.entries(motionPose))near(switcher.values[id],value);
const beforeResume={...switcher.values};switcher.step({time,dt:0,face,motion:false});assert.deepEqual(switcher.values,beforeResume);
tick(switcher);assert(switcher.values.ParamAngleX>-12&&switcher.values.ParamAngleX<0);
const entryMotion=create();for(let i=0;i<120;i++)entryMotion.step({time:i/60,dt:1/60,face});
const startMotion=entryMotion.values.ParamAngleX;
entryMotion.step({time:2,dt:1/60,face,motion:true});entryMotion.adoptMotion(motionPose);near(entryMotion.values.ParamAngleX,startMotion);
for(let i=1;i<=20;i++){entryMotion.step({time:2+i/60,dt:1/60,face,motion:true});entryMotion.adoptMotion(motionPose);}
near(entryMotion.values.ParamAngleX,motionPose.ParamAngleX);
pass('Camera/image/no-face/stop continuity; motion owns head/body, eyes continue, resume from last motion pose');

for(const value of ['false','true','bad',null]){const m=new MouseFollow({getItem:()=>value,setItem(){throw Error('blocked');}});assert.equal(m.enabled,value!=='false');m.setEnabled(false);}
assert(new MouseFollow({getItem(){throw Error('blocked');}}).enabled);
const store=new Map(),storage={getItem:k=>store.get(k),setItem:(k,v)=>store.set(k,v)},persist=new MouseFollow(storage);persist.setEnabled(false);assert(!new MouseFollow(storage).enabled);
pass('Default on, reload persistence, malformed and blocked localStorage safe');

class Surface extends EventTarget { emit(type,data={}){const e=new Event(type,{cancelable:true});Object.assign(e,data);this.dispatchEvent(e);assert(!e.defaultPrevented);}}
const host=new Surface(),win=new Surface(),doc=new Surface(),touch=new MouseFollow();doc.visibilityState='visible';
let taps=0,drags=0;host.addEventListener('pointerdown',()=>taps++);win.addEventListener('pointermove',()=>drags++);
const unbind=bindMouseFollow(touch,host,win,doc,()=>5);
win.innerWidth=800;win.innerHeight=600;
win.emit('pointermove',{pointerType:'touch',pointerId:1,clientX:20,clientY:30});assert(!touch.inside);
host.emit('pointerdown',{pointerType:'touch',pointerId:1,clientX:20,clientY:30});assert(touch.inside);
win.emit('pointermove',{pointerType:'touch',pointerId:1,clientX:25,clientY:35});assert.equal(touch.point.x,25);
win.emit('pointerup',{pointerId:2});assert(touch.inside);win.emit('pointerup',{pointerId:1});assert(!touch.inside);assert.equal(taps,1);assert.equal(drags,2);
for(const event of ['pointercancel','lostpointercapture']){host.emit('pointerdown',{pointerType:'touch',pointerId:1,clientX:20,clientY:30});(event==='lostpointercapture'?host:win).emit(event,{pointerId:1});assert(!touch.inside);}
for(const event of ['blur','pointerout','visibilitychange']){
  touch.move(10,10,5);if(event==='blur')win.emit(event);else if(event==='pointerout')doc.emit(event,{relatedTarget:null});else{doc.visibilityState='hidden';doc.emit(event);}assert(!touch.inside);
}
doc.visibilityState='visible';touch.move(10,10,5);win.emit('pointermove',{pointerType:'mouse',clientX:801,clientY:50});assert(!touch.inside);
unbind();win.emit('pointermove',{pointerType:'mouse',clientX:40,clientY:50});assert(!touch.inside);
near(idleBlink(.09),0);near(idleBlink(1),1);near(idleBlink(4.79),0);
pass('Passive touch press/drag/release/cancel/multi-touch, existing taps/drags, leave/blur/hidden, idle blink');
const out=new URL('../renders/qa/'+(process.env.COLOR_QA||'facetrack_mouse')+'/',import.meta.url);fs.mkdirSync(out,{recursive:true});
fs.writeFileSync(new URL('mouse_tests.json',out),JSON.stringify({passed:true,checks,metrics},null,2));
console.log('PASS mouse:',checks.length,'groups',JSON.stringify(metrics));
