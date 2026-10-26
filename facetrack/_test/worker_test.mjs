import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {DetectorBridge} from '../detector.mjs';
import {ParameterSmoother, DEFAULTS} from '../mapping.mjs';
import {PerformanceWindow} from '../performance.mjs';
const checks=[],pass=s=>checks.push(s),bitmaps=[];
class FakeWorker{
  constructor(url){this.url=url;this.sent=[];FakeWorker.last=this;}
  postMessage(data,transfer){
    if(data.type==='init'){queueMicrotask(()=>this.onmessage({data:{type:'ready',delegate:'GPU'}}));return;}
    assert.deepEqual(transfer,[data.bitmap]);this.sent.push(data);
  }
  finish(data=this.sent.at(-1)){
    data.bitmap.close();this.onmessage({data:{...data,type:'result',result:{},duration:12,delegate:'GPU'}});
  }
  terminate(){this.terminated=true;}
}
globalThis.Worker=FakeWorker;globalThis.OffscreenCanvas=class{};
globalThis.createImageBitmap=async(source,options)=>{
  const bitmap={options,closed:0,close(){this.closed++;}};bitmaps.push(bitmap);return bitmap;
};
const seen=[],source={videoWidth:1280,videoHeight:720};
const bridge=new DetectorBridge({onResult:x=>seen.push(x)});await bridge.init();
const worker=FakeWorker.last;
await bridge.submit(source,{capturedAt:100,sourceTime:0,epoch:1});
for(let i=1;i<20;i++)await bridge.submit(source,{capturedAt:100+i*16,sourceTime:i*.016,epoch:1});
assert.equal(worker.sent.length,1);assert.equal(bridge.pending.capturedAt,404);
assert(bitmaps.slice(1,-1).every(b=>b.closed===1));
worker.finish(worker.sent[0]);assert.equal(worker.sent.length,2);assert.equal(worker.sent[1].capturedAt,404);
assert.equal(seen[0].capturedAt,100);assert.equal(seen[0].sourceTime,0);
worker.finish();assert.equal(bridge.inflight,null);assert.equal(bridge.pending,null);
assert(bitmaps.every(b=>b.closed===1));
assert.deepEqual(bitmaps[0].options,{resizeWidth:640,resizeHeight:360,resizeQuality:'low'});
pass('20 帧拥塞只运行首帧和最新帧；其余 bitmap 关闭；采集时间与媒体时间原样往返');
await bridge.submit(source,{capturedAt:500,sourceTime:1,epoch:1});
await bridge.submit(source,{capturedAt:516,sourceTime:1.016,epoch:1});
bridge.reset();worker.finish();assert.equal(seen.length,2);assert.equal(bridge.pending,null);
pass('换源/拖动后旧结果被 generation 拒绝，待处理 bitmap 回收');
let release;
globalThis.createImageBitmap=()=>new Promise(resolve=>{release=resolve;});
const capture=bridge.submit(source,{capturedAt:600,sourceTime:2});
await bridge.submit(source,{capturedAt:616,sourceTime:2.016});
bridge.reset();const late={closed:0,close(){this.closed++;}};release(late);await capture;
assert.equal(late.closed,1);assert.equal(bridge.capturing,false);bridge.close();
pass('异步缩帧过程中不重复申请；完成前换源也会回收迟到 bitmap');
class FallbackBridge extends DetectorBridge{async initMain(){this.backend='main';this.delegate='CPU';this.announce();}}
globalThis.Worker=undefined;
const fallback=new FallbackBridge({onResult(){}});await fallback.init();
assert.equal(fallback.backend,'main');assert.match(fallback.fallback,/Worker/);fallback.close();
pass('不支持 Worker 时回退主线程并保留明确原因');

// Run the actual classic-worker handler with a fake vision engine (no browser/MCP).
let gpuAttempts=0,cpuAttempts=0,detectArgs=[],closed=0,options=[];
const vision={FilesetResolver:{async forVisionTasks(url){assert.match(url,/\/facetrack\/vendor\/mediapipe\/wasm$/);return{};}},
  FaceLandmarker:{async createFromOptions(files,opts){
    options.push(opts);assert.match(opts.baseOptions.modelAssetPath,/\/facetrack\/vendor\/mediapipe\/face_landmarker.task$/);
    if(opts.baseOptions.delegate==='GPU'){gpuAttempts++;throw Error('no worker GPU');}
    cpuAttempts++;return {async setOptions(){},close(){},detect(){return{faceLandmarks:[]};},detectForVideo(bitmap,t){detectArgs.push(t);if(t===300)throw Error('bad frame');return{faceLandmarks:[]};}};
  }}};
const messages=[],self={location:{href:'http://localhost/facetrack/detector-worker.js'},postMessage:x=>messages.push(x)};
const workerCode=fs.readFileSync(new URL('../detector-worker.js',import.meta.url),'utf8').replace("await import('./vendor/mediapipe/vision_bundle.mjs')",'self.vision');
self.vision=vision;vm.runInNewContext(workerCode,{self,URL,OffscreenCanvas:class{},performance});
await self.onmessage({data:{type:'init'}});assert.equal(messages[0].delegate,'CPU');assert.equal(gpuAttempts,1);assert.equal(cpuAttempts,1);
for(const capturedAt of [200,180,300])await self.onmessage({data:{type:'frame',id:capturedAt,capturedAt,sourceTime:0,bitmap:{close(){closed++;}}}});
assert.deepEqual(detectArgs,[200,200.001,300]);assert.equal(closed,3);assert.equal(messages.at(-1).type,'error');
assert.equal(messages[2].capturedAt,180);assert(messages[1].duration>=0);assert(options[0].canvas);
pass('实际 Worker handler：正确绝对资源路径、OffscreenCanvas、GPU→CPU、单调推理时间、成功/失败均释放 bitmap');

// Compare input filtering with jittered delivery: acquisition time is authoritative.
const a=new ParameterSmoother(),b=new ParameterSmoother();
for(let i=0;i<60;i++){
  const captureAt=i*.04,target={...DEFAULTS,ParamAngleX:Math.sin(i*.3)*20,ParamEyeLOpen:i%9===0?0:1};
  a.sample(target,captureAt,captureAt);b.sample(target,captureAt,captureAt);
  const arrival=captureAt+[.012,.047,.021][i%3];
  assert.deepEqual(a.targetAt(arrival,true),b.targetAt(arrival,true));
  a.render(arrival,1/60,true);b.render(arrival,1/60,true);
}
assert.deepEqual(a.values,b.values);
const body=[];
for(const response of [.12,.15,.18]){
  const s=new ParameterSmoother({bodyResponse:response});
  s.holdImage({...DEFAULTS,ParamBodyAngleX:5},0);let previous=0;
  for(let i=1;i<=360;i++){
    if(i===121)s.holdImage({...DEFAULTS,ParamBodyAngleX:-5},i/120);
    if(i===241)s.holdImage({...DEFAULTS,ParamBodyAngleX:0},i/120);
    const goal=i<=120?5:i<=240?-5:0;
    s.render(i/120,1/120,true);const x=s.values.ParamBodyAngleX;
    assert(x>=Math.min(previous,goal)-1e-10&&x<=Math.max(previous,goal)+1e-10);previous=x;
  }
  assert(Math.abs(previous)<1e-6);body.push({response,finalError:previous});
}
pass('身体 120/150/180 ms 阶跃、反向、停止全程单调，无过冲或回弹');
const perf=new PerformanceWindow();perf.frame(0);perf.frame(16);perf.frame(46);assert.equal(perf.snapshot(46).over25ms,1);assert.equal(perf.snapshot(11000).over25ms,0);
pass('性能面板的慢帧计数正确且 10 秒后过期');
fs.writeFileSync(new URL('../../renders/qa/'+(process.env.COLOR_QA||'facetrack_v5')+'/worker_tests.json',import.meta.url),JSON.stringify({checks,body,browserRun:false},null,2));
console.log(JSON.stringify({checks},null,2));
