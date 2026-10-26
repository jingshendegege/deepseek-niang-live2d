import {FaceReliabilityGuard} from './robustness.mjs';
import {DetectorBridge} from './detector.mjs';
import {PerformanceWindow} from './performance.mjs';
import {clamp, DEFAULTS, mapFace, matrixToEuler, PoseOutlierGuard, ParameterSmoother} from './mapping.mjs';
import {CALIBRATION_KEY,CalibrationSession,validProfile} from './calibration.mjs';
import {requestCamera,shouldDetect} from './capture.mjs';
import {getSfx,BasinReaction,probeBasin,triangleHit} from './sfx.mjs';
import {attachHair,mountHair,loadHairMasks} from './hair-color.mjs';
import {createTailIdle,mountTailIdle,TAIL_IDLE_CONFIG} from './tail-idle.mjs';
import {createBodyBob,mountBodyBob,writeBodyBob,BODY_BOB_CONFIG} from './body-bob.mjs';
import {MouseFollow,bindMouseFollow,faceScreenBounds,idleBlink} from './mouse-follow.mjs';
import {createAccessoryFollow,AI_LABELS,expressionKey} from './ai-accessories.mjs';

const $ = id => document.getElementById(id);
const sfx=getSfx(),basinReaction=new BasinReaction();
sfx.mount(document.querySelector('.expressions-panel .section-title').parentElement);
let basinDrawables=[],basinLanded=false,bodySink=0,accessoryFollow;
const sfxSamples=[],hitEvents=[];
function basinHit(clientX,clientY){
  if(!core||!basinLanded||!state.active.get('acc_basin')?.enabled)return false;
  const rect=app.view.getBoundingClientRect();
  const p=model.toModelPosition(new PIXI.Point((clientX-rect.left)*app.screen.width/rect.width,(clientY-rect.top)*app.screen.height/rect.height-bodySink));
  return basinDrawables.some(i=>core.getDrawableOpacity(i)>.05&&triangleHit(p.x,p.y,model.internalModel.getDrawableVertices(i),core.getDrawableVertexIndices(i)));
}
function knockBasin(){
  if(!basinLanded||!state.active.get('acc_basin')?.enabled)return false;
  basinReaction.trigger('knock',()=>sfx.playSfx(sfx.map?.knock||'basin_knock'));return true;
}
window.addEventListener('keydown',e=>{if(e.code==='KeyK'&&!e.repeat&&!/INPUT|TEXTAREA|SELECT/.test(e.target.tagName)&&!e.target.isContentEditable){e.preventDefault();knockBasin();}});
const MODEL_URL = new URL('../export/DeepSeekNiang_v4/DeepSeekNiang.model3.json', location.href).href;
const state = {ready:false,mode:'none',delegate:null,face:null,lastFaceTime:0,zero:{x:0,y:0,z:0},gain:{head:1,mouth:1,brow:1,eye:1},expressions:new Map(),active:new Map(),motion:null,readouts:{...DEFAULTS},fps:0,frames:0};
let app, model, core, detector, detectorPromise, stream, objectURL, sourceEpoch=0, lastVideoTime=-1, lastDetect=0, lastFrame=performance.now(), lastUI=0, viewMode='upper', naturalSize, activeMotionSequence=0;
const query=new URLSearchParams(location.search);
const mainBaseline=query.get('detector')==='main';
// main retains the v3 detector cadence and body baseline for detector A/B runs;
// both backends share the v5 face guards and head filter.
const smoother = new ParameterSmoother(mainBaseline?{bodyResponse:null}:{});
let mouseStorage;try{mouseStorage=localStorage;}catch{}
const mouseFollow=new MouseFollow(mouseStorage);
const bodyBob=createBodyBob({storage:mouseStorage});
// User 2026-10-25: no hop. The driver stays wired but inert unless BODY_BOB_CONFIG.active.
if(BODY_BOB_CONFIG.active){mountBodyBob(document.querySelector('.motions-panel'),bodyBob);const hop=$('body-bob-hop');if(hop)hop.onclick=()=>bodyBob.trigger();}
const basinBobActive=()=>{const t=(performance.now()-basinReaction.start)/1000;return t>=0&&t<BODY_BOB_CONFIG.basinSeconds;};
$('mouse-follow').checked=mouseFollow.enabled;
$('mouse-follow').onchange=e=>mouseFollow.setEnabled(e.target.checked);
bindMouseFollow(mouseFollow,$('canvas-host'));
let mouseFaceBounds=null;
const telemetry=new PerformanceWindow();
let performanceSnapshot={},lastPerfUI=0,landmarksDirty=false,lastSample=null;
const work=(name,ms)=>telemetry.sync(name,ms);
let latestDetection=null;
const poseGuard = new PoseOutlierGuard();
const reliabilityGuard = new FaceReliabilityGuard();
let calibration=null,calibrationSession=null,cameraSettings={},captureWindow=null,captureFPS=0,detectCount=0,detectFPS=0,detectWindow=performance.now();
try{const saved=JSON.parse(localStorage.getItem(CALIBRATION_KEY));if(validProfile(saved)){calibration=saved;state.zero={...saved.zero};}}catch{}
const video=$('video'), photo=$('photo'), overlay=$('landmarks'), overlayContext=overlay.getContext('2d');
const motionNames={Idle:'待机',Blink:'眨眼',Nod:'点头',Shake:'摇头',TailSwing:'摆尾',Crouch:'蹲下',WeightShift:'重心移动',Shy:'害羞',Wave:'挥手',HeadTilt:'歪头',Cheer:'欢呼',LegKick:'踢腿',Sway:'摇摆',
  'Upper Blink':'眨眼','Upper Nod':'点头','Upper Shake':'摇头','Upper TailSwing':'摆尾','Upper Shy':'害羞','Upper Wave':'挥手','Upper HeadTilt':'歪头','Upper Cheer':'欢呼','Upper Sway':'摇摆','v4e upper showcase':'展示动作'};
// Kept in the model but hidden here until redrawn (user, 2026-10-25: smug cat mouth and tears look unfinished).
const hiddenExpressions=new Set(['mouth_smug','tears','g4_bowl']);
const expressionNames={g4_bowl:'捧大饭盆',smile:'笑眼',blush:'脸红',shy:'害羞',star:'星星眼',heart:'爱心眼',tears:'流泪',cry_big:'闭眼大哭',gloom:'黑脸',sweat:'流汗',angry:'生气',cat_mouth:'猫嘴 ω',o_mouth:'圆嘴 o',acc_basin:'铁盆',acc_chef:'厨师帽',acc_glasses:'眼镜',acc_rice:'饭粒',acc_clip:'鲸鱼发夹',skin_black:'黑色女仆',q_squint:'开心眯眼 ><',q_cry:'瀑布泪 T T',q_dizzy:'晕眼 @ @',q_deadpan:'无语 - -'};
const headBody = id => /^Param(Angle|BodyAngle)/.test(id);
const notice = (text,error=false) => {$('notice').textContent=text;$('notice').classList.toggle('error',error);};
const guarded = fn => async (...args) => {try{await fn(...args);}catch(error){notice(error.message || String(error),true);}};
const fetchJSON = async url => {const r=await fetch(url,{cache:'no-store'});if(!r.ok)throw new Error(`读取失败（${r.status}）：${new URL(url,location.href).pathname}`);return r.json();};
const safeTheme = value => {document.documentElement.dataset.theme=value;try{localStorage.setItem('facetrack-theme',value);}catch{}};
try{safeTheme(localStorage.getItem('facetrack-theme') || (matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'));}catch{safeTheme('light');}
$('theme').onclick=()=>safeTheme(document.documentElement.dataset.theme==='dark'?'light':'dark');

function fitView(){
  if(!model)return;
  const w=$('canvas-host').clientWidth,h=$('canvas-host').clientHeight;
  app.renderer.resize(w,h);
  const usableH=h-140;
  const s=viewMode==='full'?Math.min((w-60)/naturalSize.w,usableH/naturalSize.h):Math.min((w-50)/naturalSize.w,usableH/(naturalSize.h*.57));
  model.scale.set(s);model.position.set(w/2,90);model.anchor.set(.5,0);
  for(const mode of ['upper','full']){$(mode).classList.toggle('selected',viewMode===mode);$(mode).setAttribute('aria-pressed',String(viewMode===mode));}
}
$('upper').onclick=()=>{viewMode='upper';fitView();};$('full').onclick=()=>{viewMode='full';fitView();};$('reset-view').onclick=fitView;
let drag=null;
$('canvas-host').addEventListener('pointerdown',e=>{if(!model||e.button!==0)return;drag={id:e.pointerId,x:e.clientX,y:e.clientY,mx:model.x,my:model.y,moved:0};e.currentTarget.setPointerCapture(e.pointerId);});
$('canvas-host').addEventListener('pointermove',e=>{if(drag&&model&&drag.id===e.pointerId){drag.moved=Math.max(drag.moved,Math.hypot(e.clientX-drag.x,e.clientY-drag.y));if(drag.moved>=4)model.position.set(drag.mx+e.clientX-drag.x,drag.my+e.clientY-drag.y);}});
$('canvas-host').addEventListener('pointerup',e=>{if(drag&&drag.id===e.pointerId&&Math.max(drag.moved,Math.hypot(e.clientX-drag.x,e.clientY-drag.y))<4){const hit=basinHit(e.clientX,e.clientY);hitEvents.push({x:e.clientX,y:e.clientY,hit,time:performance.now()});if(hit)knockBasin();}});
for(const event of ['pointerup','pointercancel','lostpointercapture'])$('canvas-host').addEventListener(event,()=>drag=null);
$('canvas-host').addEventListener('wheel',e=>{if(!model)return;e.preventDefault();const rect=e.currentTarget.getBoundingClientRect(),x=e.clientX-rect.left,y=e.clientY-rect.top;const next=clamp(model.scale.x*Math.exp(-e.deltaY*.001),.015,5),ratio=next/model.scale.x;model.position.set(x+(model.x-x)*ratio,y+(model.y-y)*ratio);model.scale.set(next);},{passive:false});
new ResizeObserver(()=>fitView()).observe($('canvas-host'));

for(const part of ['head','mouth','brow','eye'])$(part+'-sensitivity').oninput=e=>{const i=Number(e.target.value);state.gain[part]=[.65,1,1.45][i];$(part+'-level').value=['柔和','标准','灵敏'][i];if(state.face)remapFace();};
const mappingOptions=()=>({calibration,aspect:state.mode==='image'?photo.naturalWidth/photo.naturalHeight:video.videoWidth/video.videoHeight});
function remapFace(){
  if(!state.face)return;
  const options=mappingOptions(),result=state.face.result;
  let mapped=mapFace(result,state.zero,state.gain,{...options,anglesOverride:state.face.angles});
  if(!mapped)return;
  if(state.mode==='image')smoother.holdImage(mapped.values,performance.now()/1000);
  else if(lastSample){
    reliabilityGuard.reset();mapped=reliabilityGuard.step(mapped,result,lastSample.capturedAt/1000,options.aspect);
    smoother.invalidate();smoother.sample(mapped.values,lastSample.capturedAt/1000,lastSample.sourceTime,mapped.reliability);
  }
  state.face={...mapped,result};
}
$('calibrate').onclick=()=>{
  if(!hasFace()||state.mode==='image')return;
  calibrationSession=new CalibrationSession();$('calibration-progress').hidden=false;
  $('calibration-progress').textContent='准备：放松正脸。向导会依次提示六个动作。';$('cancel-calibration').hidden=false;
};
$('cancel-calibration').onclick=()=>{calibrationSession=null;$('calibration-progress').hidden=true;$('cancel-calibration').hidden=true;notice('已取消校准，保留原设置。');};
$('reset-calibration').onclick=()=>{calibration=null;calibrationSession=null;state.zero={x:0,y:0,z:0};try{localStorage.removeItem(CALIBRATION_KEY);}catch{}$('calibration-hint').textContent='已重置，使用默认表情范围。';$('calibration-progress').hidden=true;$('cancel-calibration').hidden=true;remapFace();};
$('calibration-hint').textContent=calibration?'已载入个人校准 · 切换人物或机位请重新校准':'尚未校准 · 使用默认范围；六步向导约 16 秒。';
$('smoothing').oninput=e=>{const value=Number(e.target.value);smoother.setSmoothness(1-value/100);$('smoothing-level').value=value<35?'静稳':value>65?'灵敏':'均衡';};
$('auto-mouth').onchange=e=>smoother.setAutoMouth(e.target.checked);
$('body-follow').disabled=mainBaseline;
$('body-follow-level').value=mainBaseline?'v3': '150 ms';
$('body-follow').oninput=e=>{smoother.setBodyResponse(Number(e.target.value)/1000);$('body-follow-level').value=e.target.value+' ms';};
function collectCalibration(mapped,now){
  if(!calibrationSession)return;
  const update=calibrationSession.update(mapped,now);if(!update)return;
  $('calibration-progress').textContent=update.text;
  if(update.profile){
    calibration=update.profile;state.zero={...calibration.zero};calibrationSession=null;$('cancel-calibration').hidden=true;
    let saved=true;try{localStorage.setItem(CALIBRATION_KEY,JSON.stringify(calibration));}catch{saved=false;}
    $('calibration-hint').textContent=saved?'个人校准已保存 · 刷新后保留':'校准已应用 · 浏览器禁止存储，刷新后需重做';
    notice('校准完成。未充分采到的动作保留默认活动范围。');
  }
}
const hasFace=()=>!!state.face&&(state.mode==='image'||performance.now()-state.lastFaceTime<150);

function toggleExpression(key){
  const entry=state.expressions.get(key);if(!entry)return;
  if(key.startsWith('acc_ai_')){accessoryFollow.manual(key,!state.active.get(key)?.enabled);updateExpressionButtons();return;}
  const current=state.active.get(key);
  if(current?.enabled)current.enabled=false;
  else{
    // Face expressions are mutually exclusive; accessories and skins are independent.
    if(entry.kind==='face')for(const [other,a] of state.active)if(state.expressions.get(other).kind==='face')a.enabled=false;
    if(current)current.enabled=true;else state.active.set(key,{enabled:true,weight:0});
  }
  const enabled=!!state.active.get(key)?.enabled;
  if(key==='acc_basin'){
    if(enabled){basinLanded=false;basinReaction.trigger('on',()=>{basinLanded=true;sfx.expression(key,true);});}
    else{basinLanded=false;basinReaction.cancelContact();sfx.expression(key,false);}
  }else sfx.expression(key,enabled);
  updateExpressionButtons();
}
function updateExpressionButtons(){for(const [key,entry]of state.expressions)entry.button.setAttribute('aria-pressed',String(!!state.active.get(key)?.enabled));}
$('clear-expressions').onclick=()=>{for(const value of state.active.values())value.enabled=false;basinLanded=false;basinReaction.cancelContact();sfx.playSfx(sfx.map?.clear||'off_whoosh');updateExpressionButtons();};

async function playMotion(group,index,label){
  const sequence=++activeMotionSequence,manager=model.internalModel.motionManager;
  const motion=await manager.loadMotion(group,index);if(sequence!==activeMotionSequence)return;
  if(!motion)throw new Error('动作加载失败，请等待模型导出完成后刷新。');
  motion.setIsLoop(false);
  state.motion={group,index,label};$('motion-status').textContent='正在播放：'+label;
  const ok=await manager.startMotion(group,index,3);
  if(ok)sfx.motion(group);
  if(!ok&&sequence===activeMotionSequence){state.motion=null;$('motion-status').textContent='动作未启动';}
}

async function loadModel(){
  const json=await fetchJSON(MODEL_URL);
  const hairData=await fetchJSON(new URL('../hair_palettes.json',import.meta.url));
  const hairMasks=await loadHairMasks(new URL('../hair_masks/',import.meta.url));
  if(!window.PIXI?.live2d)throw new Error('本地渲染库未加载，请检查 vendor 目录是否完整。');
  PIXI.utils.skipHello();PIXI.live2d.config.sound=false;
  app=new PIXI.Application({width:$('canvas-host').clientWidth,height:$('canvas-host').clientHeight,backgroundAlpha:0,antialias:true,resolution:Math.min(devicePixelRatio,2),autoDensity:true,preserveDrawingBuffer:true});
  $('canvas-host').appendChild(app.view);app.view.setAttribute('aria-label','DeepSeek娘 Live2D 实时画布');
  // Supply the freshly read settings; all referenced assets still resolve inside export.
  json.url=MODEL_URL;
  model=await PIXI.live2d.Live2DModel.from(json,{autoInteract:false,autoUpdate:false,motionPreload:'NONE',idleMotionGroup:'__facetrack_no_idle__'});
  app.stage.addChild(model);core=model.internalModel.coreModel;
  const hair=attachHair({raw:core._model,renderer:model.internalModel.renderer,data:hairData,masks:hairMasks,canvas:()=>app.view,snapshot:()=>{app.render();return app.view.toDataURL('image/png');},sfx});
  const tailIdle=createTailIdle();let tailOffsets={};
  mountTailIdle(document.querySelector('.expressions-panel'),tailIdle);
  const addTail=id=>{const i=core._model.parameters.ids.indexOf(id);if(i<0)return;const p=core._model.parameters;core.setParameterValueById(id,clamp(core.getParameterValueById(id)+(tailOffsets[id]||0),p.minimumValues[i],p.maximumValues[i]));};
  basinDrawables=probeBasin(core);
  naturalSize={w:model.internalModel.width,h:model.internalModel.height};
  const internal=model.internalModel,manager=internal.motionManager;
  manager.stopAllMotions();internal.eyeBlink=undefined;internal.breath=undefined;
  internal.focusController.focus(0,0,true);
  if(manager.expressionManager)manager.expressionManager.update=()=>false;
  const defaults=Array.from({length:core.getParameterCount()},(_,i)=>core.getParameterDefaultValue(i));
  // Reset before motions, then write face + layered expressions before physics.
  // Cubism physics retains its own particles; no hair/skirt/ear simulation is disabled.
  internal.on('beforeMotionUpdate',()=>{defaults.forEach((v,i)=>core.setParameterValueByIndex(i,v));});
  internal.on('afterMotionUpdate',()=>{
    tailOffsets=tailIdle.sample(performance.now()/1000,mouseFollow.values.ParamBodyAngleX,!!state.motion);
    addTail(TAIL_IDLE_CONFIG.input.id);
    const reaction=basinReaction.sample();
    bodySink=-reaction.y*.7;
    const pose={...smoother.values,...mouseFollow.values};
    for(const [id,v]of Object.entries(pose)){
      if(state.motion&&headBody(id))pose[id]=core.getParameterValueById(id);
      else core.setParameterValueById(id,v);
    }
    if(state.motion)for(const [id,v]of Object.entries(mouseFollow.adoptMotion(pose)))if(headBody(id))core.setParameterValueById(id,v);
    if(!hasFace())for(const id of ['ParamEyeLOpen','ParamEyeROpen'])core.setParameterValueById(id,core.getParameterValueById(id)*idleBlink(performance.now()/1000));
    for(const [key,a]of state.active){
      if(key.startsWith('acc_ai_')&&!a.enabled)continue;
      if(key==='acc_basin'&&a.enabled){a.weight=basinLanded?1:0;}
      if(a.weight<.001)continue;
      for(const p of state.expressions.get(key).data.Parameters||[]){
        const old=core.getParameterValueById(p.Id),blend=p.Blend||'Add';
        const value=blend==='Overwrite'?old+(p.Value-old)*a.weight:blend==='Multiply'?old*(1+(p.Value-1)*a.weight):old+p.Value*a.weight;
        core.setParameterValueById(p.Id,value);
      }
    }
    core.setParameterValueById('ParamAngleY',core.getParameterValueById('ParamAngleY')+reaction.y);
    const bob=!BODY_BOB_CONFIG.active?{value:0,basinWeight:1}:bodyBob.sample(performance.now()/1000,{source:state.mode!=='none',motion:!!state.motion,basinActive:reaction.t>=0&&reaction.t<BODY_BOB_CONFIG.basinSeconds});
    // This hook precedes physics. Never write the skirt's physics outputs.
    const bobSupported=BODY_BOB_CONFIG.active&&writeBodyBob(core,bob.value);
    // A 50 ms ownership crossfade prevents double body dips during basin contact.
    // Missing Bob parameters retain the original basin path without attenuation.
    const basinWeight=bobSupported?bob.basinWeight:1;
    bodySink*=basinWeight;
    core.setParameterValueById('ParamBodyAngleY',core.getParameterValueById('ParamBodyAngleY')+reaction.body*basinWeight);
    for(const id of ['ParamEyeLOpen','ParamEyeROpen'])core.setParameterValueById(id,core.getParameterValueById(id)*(1-reaction.squint));
    if(reaction.t<.6){sfxSamples.push({time:performance.now(),t:reaction.t,angleY:core.getParameterValueById('ParamAngleY'),dip:reaction.y,velocity:reaction.v,acceleration:reaction.a,squint:reaction.squint,landed:basinLanded});if(sfxSamples.length>5000)sfxSamples.shift();}
  });
  internal.on('beforeModelUpdate',()=>{if(TAIL_IDLE_CONFIG.output)addTail(TAIL_IDLE_CONFIG.output.id);for(const id of [...Object.keys(DEFAULTS),TAIL_IDLE_CONFIG.input.id,...(TAIL_IDLE_CONFIG.output?[TAIL_IDLE_CONFIG.output.id]:[]),...TAIL_IDLE_CONFIG.physicsOutputs])state.readouts[id]=core.getParameterValueById(id);});
  manager.on('motionFinish',()=>{state.motion=null;$('motion-status').textContent='播放完成 · 已恢复跟随';});
  const refs=json.FileReferences.Expressions||[];
  const loaded=await Promise.all(refs.map(async ref=>({ref,data:await fetchJSON(new URL(ref.File,MODEL_URL).href)})));
  $('expressions').replaceChildren();
  for(const kind of ['face','accessory','skin']){
    const entries=loaded.filter(({ref})=>{const file=ref.File.split('/').pop();if(hiddenExpressions.has(file.replace('.exp3.json','')))return false;return(kind==='accessory'&&file.startsWith('acc_'))||(kind==='skin'&&file.startsWith('skin_'))||(kind==='face'&&!/^(acc_|skin_)/.test(file));});
    if(kind==='accessory')entries.sort((a,b)=>Number(expressionKey(a.ref).startsWith('acc_ai_'))-Number(expressionKey(b.ref).startsWith('acc_ai_')) || (expressionKey(a.ref).startsWith('acc_ai_')?Object.keys(AI_LABELS).indexOf(expressionKey(a.ref).slice(7))-Object.keys(AI_LABELS).indexOf(expressionKey(b.ref).slice(7)):0));
    if(!entries.length)continue;
    const heading=document.createElement('span');heading.className='chip-group-label';heading.textContent={face:'表情',accessory:'饰品 · 可多选',skin:'肤色与服装'}[kind];$('expressions').append(heading);
    for(const {ref,data} of entries){
      const key=ref.File.split('/').pop().replace('.exp3.json','');const button=document.createElement('button');button.textContent=key.startsWith('acc_ai_')?(ref.Name!==key?ref.Name:AI_LABELS[key.slice(7)]||key):expressionNames[key]||ref.Name||key;button.title=ref.Name;button.dataset.expression=key;button.setAttribute('aria-pressed','false');button.onclick=()=>toggleExpression(key);
      state.expressions.set(key,{data,kind,button});$('expressions').append(button);
    }
  }
  accessoryFollow=createAccessoryFollow({has:key=>state.expressions.has(key),apply:(key,on)=>{
    const a=state.active.get(key)||{weight:0};a.enabled=on;if(!on)a.weight=0;state.active.set(key,a);updateExpressionButtons();
  }});
  hair.follow=accessoryFollow;accessoryFollow.hair(hair.palette);
  mountHair(document.querySelector('.expressions-panel'),hair,hairData);
  let motionCount=0;
  for(const [group,list]of Object.entries(json.FileReferences.Motions||{}))list.forEach((ref,index)=>{
    if(/g4_bowl/i.test(ref.File||''))return;
    const button=document.createElement('button'),label=(motionNames[group]||group)+(list.length>1?' '+(index+1):'');button.textContent=label;button.dataset.motion=group;button.dataset.index=index;button.onclick=guarded(()=>playMotion(group,index,label));$('motions').append(button);motionCount++;
  });
  fitView();state.ready=true;$('loading').hidden=true;$('model-status').textContent='模型已就绪 · 物理已开启';$('model-status').classList.add('ready');$('model-meta').textContent=`${refs.length} 个表情 · ${motionCount} 个动作 · 模型资源实时读取`;
  app.ticker.stop();requestAnimationFrame(frame);
}

async function ensureDetector(){
  if(detector)return detector;
  if(detectorPromise)return detectorPromise;
  detectorPromise=(async()=>{
    $('delegate').textContent='正在加载面捕';notice('正在读取本地面捕模型，首次启动需要几秒。');
    const bridge=new DetectorBridge({requested:mainBaseline?'main':'worker',cpu:query.get('delegate')==='CPU',
      width:query.get('input')==='480'?480:640,onWork:work,onResult:acceptDetection,
      onStatus:status=>{
        state.delegate=status.delegate;
        const label=status.backend==='worker'?'Worker':status.backend==='main'?'主线程':'加载中';
        $('delegate').textContent=label+' · '+(status.delegate||'面捕');
        $('detector-warning').hidden=!status.fallback;if(status.fallback)$('performance-panel').open=true;
        $('detector-warning').textContent=status.fallback?'Worker 不可用，已回退主线程识别，可能卡顿。原因：'+status.fallback:'';
        if(status.backend==='failed'){notice('面捕运行失败：'+status.fallback,true);stopSource();}
        else if(status.backend==='main'||status.backend==='worker'){
          notice(status.fallback?'已回退主线程识别，请查看性能面板。':'面捕已就绪。面向镜头后可进行个人校准。');
          if(state.mode==='image'&&detector)setTimeout(()=>{if(state.mode==='image')void detect(photo,true);},0);
        }
      }});
    await bridge.init();detector=bridge;return bridge;
  })();
  try{return await detectorPromise;}finally{detectorPromise=null;}
}

function stopSource(){
  bodyBob.resetFace();
  detector?.reset();lastSample=null;latestDetection=null;
  smoother.invalidate();poseGuard.reset();reliabilityGuard.reset();
  calibrationSession=null;captureWindow=null;captureFPS=0;detectCount=0;detectFPS=0;detectWindow=performance.now();cameraSettings={};$('capture-info').textContent='尚无输入';$('calibration-progress').hidden=true;$('cancel-calibration').hidden=true;
  if(!calibration)state.zero={x:0,y:0,z:0};
  sourceEpoch++;if(stream)stream.getTracks().forEach(track=>track.stop());stream=null;
  video.pause();video.srcObject=null;video.removeAttribute('src');video.load();photo.removeAttribute('src');photo.hidden=true;video.hidden=false;
  if(objectURL){URL.revokeObjectURL(objectURL);objectURL=null;}
  state.mode='none';state.face=null;lastVideoTime=-1;overlayContext.clearRect(0,0,overlay.width,overlay.height);
  $('preview').dataset.active='false';$('camera-placeholder').hidden=false;$('video-controls').hidden=true;$('camera').textContent='开启摄像头';$('stop-input').disabled=true;$('source-label').textContent='镜像预览';
}
$('stop-input').onclick=()=>{stopSource();notice('输入已停止，平滑恢复鼠标跟随或待机。');};
function setSourceReady(mode){state.mode=mode;$('camera-placeholder').hidden=true;$('preview').dataset.active='true';$('stop-input').disabled=false;$('source-label').textContent={camera:'摄像头 · 镜像',video:'本地视频 · 镜像',image:'本地图片 · 镜像'}[mode];lastVideoTime=-1;}

$('camera').onclick=guarded(async()=>{
  if(state.mode==='camera'){stopSource();notice('摄像头已关闭。');return;}
  if(!navigator.mediaDevices?.getUserMedia)throw new Error('摄像头需要 localhost 安全环境，请通过启动脚本打开。');
  stopSource();state.mode='loading';const epoch=sourceEpoch;$('camera').disabled=true;$('stop-input').disabled=false;
  try{
    await ensureDetector();if(epoch!==sourceEpoch)return;
    const next=await requestCamera(navigator.mediaDevices);
    if(epoch!==sourceEpoch){next.getTracks().forEach(t=>t.stop());return;}
    stream=next;cameraSettings=stream.getVideoTracks()[0].getSettings();video.srcObject=stream;await video.play();if(epoch!==sourceEpoch)return;
    setSourceReady('camera');$('camera').textContent='关闭摄像头';
    stream.getVideoTracks()[0].addEventListener('ended',()=>{if(state.mode==='camera'){stopSource();notice('摄像头已断开，请重新开启。',true);}});
  }catch(error){
    if(epoch===sourceEpoch)stopSource();
    const message={NotAllowedError:'摄像头权限被拒绝。点击地址栏权限图标允许摄像头，再重试。',NotFoundError:'未找到摄像头，可改用本地视频 / 图片测试。',NotReadableError:'摄像头被其他应用占用，请关闭占用它的应用后重试。'}[error.name];throw new Error(message||error.message);
  }finally{$('camera').disabled=false;}
});
$('file-button').onclick=()=>$('file-input').click();
$('file-input').onchange=guarded(async e=>{const file=e.target.files[0];e.target.value='';if(file)await loadFile(file);});
async function loadFile(file){
  stopSource();state.mode='loading';const epoch=sourceEpoch;$('stop-input').disabled=false;
  try{
    await ensureDetector();if(epoch!==sourceEpoch)return;
    objectURL=URL.createObjectURL(file);
    if(file.type.startsWith('image/')){
      photo.src=objectURL;await photo.decode();if(epoch!==sourceEpoch)return;photo.hidden=false;video.hidden=true;setSourceReady('image');await detect(photo,true);
    }else{
      video.src=objectURL;video.loop=true;await video.play();if(epoch!==sourceEpoch)return;setSourceReady('video');$('video-controls').hidden=false;$('video-play').textContent='暂停';
    }
  }catch(error){if(epoch===sourceEpoch)stopSource();throw new Error('素材无法解码，请使用 JPG / PNG 图片或浏览器支持的 MP4 / WebM 视频。'+error.message);}
}
$('video-play').onclick=guarded(async()=>{if(video.paused)await video.play();else video.pause();$('video-play').textContent=video.paused?'播放':'暂停';});
$('video-seek').oninput=e=>{if(Number.isFinite(video.duration))video.currentTime=Number(e.target.value)/1000*video.duration;lastVideoTime=-1;};
video.addEventListener('seeking',()=>{sourceEpoch++;detector?.reset();lastSample=null;bodyBob.resetFace();smoother.invalidate();poseGuard.reset();reliabilityGuard.reset();lastVideoTime=-1;});
$('show-landmarks').onchange=()=>drawLandmarks(state.face?.result);

async function detect(source,imageMode=false,capturedAt=performance.now(),sourceTime=video.currentTime){
  if(!detector)return;
  return detector.submit(source,{imageMode,capturedAt,sourceTime,epoch:sourceEpoch});
}
function acceptDetection(data){
  if(data.epoch!==sourceEpoch)return;
  const started=performance.now(),{result,imageMode,capturedAt,sourceTime}=data;
  if(lastSample&&capturedAt<=lastSample.capturedAt)return;
  if(lastSample&&sourceTime<lastSample.sourceTime){bodyBob.resetFace();smoother.invalidate();poseGuard.reset();reliabilityGuard.reset();}
  // Filter, outlier guard and extrapolation share acquisition time, never arrival time.
  const sampleAt=mainBaseline?started:capturedAt;
  const rawAngles=matrixToEuler(result?.facialTransformationMatrixes?.[0]);
  if(sampleAt-state.lastFaceTime>150||!state.face){poseGuard.reset();reliabilityGuard.reset();}
  const options={...mappingOptions(),anglesOverride:rawAngles?poseGuard.step(rawAngles,sampleAt/1000):null};
  let mapped=mapFace(result,state.zero,state.gain,options);
  if(mapped&&!Number.isFinite(state.zero.tx)){state.zero={...state.zero,tx:mapped.translation.x,ty:mapped.translation.y,tz:mapped.translation.z};mapped=mapFace(result,state.zero,state.gain,options);}
  collectCalibration(mapped,sampleAt);
  if(mapped){mapped=mapFace(result,state.zero,state.gain,{...options,calibration});if(imageMode)smoother.holdImage(mapped.values,sampleAt/1000);else {mapped=reliabilityGuard.step(mapped,result,sampleAt/1000,options.aspect);smoother.sample(mapped.values,sampleAt/1000,sourceTime,mapped.reliability);}}
  else {smoother.invalidate();poseGuard.reset();reliabilityGuard.reset();}
  bodyBob.observeFace({time:sampleAt/1000,pitch:mapped?.angles.y,y:mapped?.translation.y,
    valid:!!mapped&&!mapped.reliability?.unreliable&&started-sampleAt<=150,
    live:!imageMode&&(state.mode==='camera'||state.mode==='video'&&!video.paused),
    motion:!!state.motion,basinActive:basinBobActive(),at:started/1000});
  lastSample={capturedAt,sourceTime};state.face=mapped?{...mapped,result}:null;state.lastFaceTime=sampleAt;
  state.delegate=data.delegate;latestDetection={id:data.id,capturedAt,sourceTime,duration:data.duration,backend:data.backend,width:data.width,height:data.height};
  telemetry.detection(data,started);detectCount++;
  if(started-detectWindow>=1000){detectFPS=detectCount*1000/(started-detectWindow);detectWindow=started;detectCount=0;}
  landmarksDirty=true;
  if(imageMode)notice(mapped?'图片已检测到人脸。可切换表情或继续选择其他素材。':'图片中未检测到人脸，请换用清晰的正面照片。',!mapped);
  work('mapping',performance.now()-started);
}

function drawLandmarks(result){
  const box=$('preview').getBoundingClientRect();const ow=Math.round(box.width*devicePixelRatio),oh=Math.round(box.height*devicePixelRatio);if(overlay.width!==ow)overlay.width=ow;if(overlay.height!==oh)overlay.height=oh;
  overlayContext.clearRect(0,0,overlay.width,overlay.height);
  if(!$('show-landmarks').checked||!result?.faceLandmarks?.length)return;
  const sw=state.mode==='image'?photo.naturalWidth:video.videoWidth,sh=state.mode==='image'?photo.naturalHeight:video.videoHeight;if(!sw||!sh)return;
  const s=Math.min(overlay.width/sw,overlay.height/sh),w=sw*s,h=sh*s,ox=(overlay.width-w)/2,oy=(overlay.height-h)/2;
  overlayContext.fillStyle='#81f1d5';
  overlayContext.beginPath();const r=Math.max(.7,devicePixelRatio*.65);
  for(const p of result.faceLandmarks[0]){const x=ox+p.x*w,y=oy+p.y*h;overlayContext.moveTo(x+r,y);overlayContext.arc(x,y,r,0,Math.PI*2);}overlayContext.fill();
}
const readoutLabels=[['ParamAngleX','偏航 X'],['ParamAngleY','俯仰 Y'],['ParamAngleZ','侧倾 Z'],['ParamEyeLOpen','左眼开合'],['ParamEyeROpen','右眼开合'],['ParamMouthOpenY','嘴部开合'],['ParamMouthForm','嘴型'],['ParamEyeBallX','眼球 X'],['fps','渲染帧率']];
for(const [id,label]of readoutLabels){const block=document.createElement('div'),dt=document.createElement('dt'),dd=document.createElement('dd');dt.textContent=label;dd.id='readout-'+id;dd.textContent='—';block.append(dt,dd);$('readouts').append(block);}

function consumeVideoFrame(now,metadata){
  if((state.mode==='camera'||state.mode==='video')&&video.readyState>=2){
    const time=metadata?.mediaTime??video.currentTime,frames=metadata?.presentedFrames;
    if(time!==lastVideoTime){
      if(!captureWindow||time<captureWindow.time)captureWindow={time,frames:frames??0,count:0};
      captureWindow.count++;
      if(time-captureWindow.time>=1){captureFPS=(frames===undefined?captureWindow.count:(frames-captureWindow.frames))/(time-captureWindow.time);captureWindow={time,frames:frames??0,count:0};}
      lastVideoTime=time;
      if(detector?.backend==='worker'||shouldDetect(state.delegate,now,lastDetect)){lastDetect=now;const capturedAt=metadata?.captureTime??metadata?.presentationTime??now;void detect(video,false,capturedAt,time);}
    }
  }
}
if(video.requestVideoFrameCallback){const next=(now,metadata)=>{consumeVideoFrame(now,metadata);video.requestVideoFrameCallback(next);};video.requestVideoFrameCallback(next);}
function frame(now){
  const workStarted=performance.now();telemetry.frame(now);
  const actualDt=(now-lastFrame)/1000,dt=Math.min(actualDt,.1);lastFrame=now;state.frames++;
  if(!video.requestVideoFrameCallback)consumeVideoFrame(now);
  // Paused file video deliberately holds its last valid face; a stalled camera does not.
  if(state.mode==='video'&&video.paused&&state.face)state.lastFaceTime=now;
  const tracked=hasFace(),target=tracked?{...state.face.values}:{...DEFAULTS};target.ParamBreath=(1+Math.sin(now/3500*Math.PI*2))*.5;
  // Still images and paused video hold the sample. The spring always runs at
  // render cadence, including loss/reacquisition, using actual elapsed seconds.
  smoother.render(now/1000,actualDt,tracked);
  smoother.values.ParamBreath=target.ParamBreath;
  const canvasRect=app.view.getBoundingClientRect();
  mouseFaceBounds=faceScreenBounds(model,canvasRect,app.screen,bodySink);
  const viewKey=[model.x,model.y,model.scale.x,model.scale.y,canvasRect.left,canvasRect.top,canvasRect.width,canvasRect.height].join(',');
  mouseFollow.step({time:now/1000,dt:actualDt,face:mouseFaceBounds,viewKey,source:state.mode!=='none',faceValues:smoother.values,motion:!!state.motion,bodyResponse:smoother.bodyResponse});
  for(const [key,a]of state.active){const data=state.expressions.get(key).data,tau=Math.max(.04,(a.enabled?data.FadeInTime:data.FadeOutTime)||.2);a.weight+=((a.enabled?1:0)-a.weight)*(1-Math.exp(-dt/tau));if(!a.enabled&&a.weight<.001)state.active.delete(key);}
  if(landmarksDirty){landmarksDirty=false;drawLandmarks(state.face?.result);}
  model.update(dt*1000);
  const restY=model.y;model.y+=bodySink;app.renderer.render(app.stage);model.y=restY;
  state.fps=state.fps?state.fps*.94+(1/Math.max(actualDt,.001))*.06:1/Math.max(actualDt,.001);
  if(now-lastUI>150){
    lastUI=now;$('calibrate').disabled=!tracked||state.mode==='image'||!!calibrationSession;$('tracking-status').textContent=state.motion?'动作试播 · 头身跟随暂停':tracked?'人脸已捕捉 · 正在跟随':state.mode==='none'?(mouseFollow.mode==='mouse'?'跟随鼠标 · 眼睛先行':'待机 · 自动呼吸与眨眼'):'未检测到人脸 · 自动复位';$('tracking-dot').classList.toggle('live',tracked||mouseFollow.mode==='mouse');
    $('fps-badge').textContent=Math.round(state.fps)+' 帧/秒';
    if(state.mode==='camera'||state.mode==='video')$('capture-info').textContent=`实际 ${video.videoWidth}×${video.videoHeight} · 输入 ${captureFPS?captureFPS.toFixed(1):'测量中'} 帧/秒 · 检测 ${detectFPS.toFixed(1)} 帧/秒`+(cameraSettings.frameRate?`（设备协商 ${cameraSettings.frameRate.toFixed(1)}）`:'');
    for(const [id]of readoutLabels)$('readout-'+id).textContent=id==='fps'?Math.round(state.fps):state.readouts[id].toFixed(2);
    if(state.mode==='video'&&Number.isFinite(video.duration)){$('video-seek').value=video.currentTime/video.duration*1000;$('video-time').textContent=Math.floor(video.currentTime/60)+':'+String(Math.floor(video.currentTime%60)).padStart(2,'0');}
  }
  if(now-lastPerfUI>=500){
    lastPerfUI=now;performanceSnapshot=telemetry.snapshot(now);
    if($('performance-panel').open){const p=performanceSnapshot;
      $('perf-render').textContent=p.renderFPS.toFixed(1)+' 帧/秒';
      $('perf-interval').textContent=p.intervalP95.toFixed(1)+' / '+p.intervalMax.toFixed(1)+' ms';
      $('perf-slow').textContent=p.over25ms+' 帧';
      $('perf-detect').textContent=p.detectionMs.toFixed(1)+' ms / '+p.detectionFPS.toFixed(1)+' 帧/秒';
      $('perf-input').textContent=p.inputWidth+'×'+p.inputHeight;
      $('perf-backend').textContent=(detector?.backend||'未启动')+' / '+(state.delegate||'—');
      $('perf-sync').textContent=p.syncMax.toFixed(1)+' ms / '+p.syncOver8ms+' 次';
    }
  }
  work('render',performance.now()-workStarted);
  requestAnimationFrame(frame);
}
window.addEventListener('pagehide',()=>{stopSource();detector?.close();});
window.sfxQA={sfx,basinReaction,samples:sfxSamples,hits:hitEvents,hit:basinHit,knock:knockBasin,
  get drawables(){return basinDrawables;},
  meshes:()=>basinDrawables.map(i=>{const v=model.internalModel.getDrawableVertices(i),r=app.view.getBoundingClientRect();const points=[];for(let j=0;j<v.length;j+=2){const p=model.worldTransform.apply(model.internalModel.localTransform.apply(new PIXI.Point(v[j],v[j+1])));points.push([r.left+p.x*r.width/app.screen.width,r.top+p.y*r.height/app.screen.height]);}return {index:i,points,triangles:Array.from(core.getDrawableVertexIndices(i))};})};

// Read-only diagnostics and deterministic controls used by the local regression script.
window.facetrack={beginBenchmark:()=>telemetry.begin(),endBenchmark:()=>telemetry.end(),get performance(){return {...performanceSnapshot,detector:detector?.status(),latestDetection};},get mouse(){return {enabled:mouseFollow.enabled,mode:mouseFollow.mode,face:mouseFaceBounds,point:mouseFollow.point,target:{...mouseFollow.target},values:{...mouseFollow.values}};},get ready(){return state.ready;},get status(){return {ready:state.ready,mode:state.mode,delegate:state.delegate,detected:hasFace(),angles:state.face?.angles,zero:{...state.zero},values:{...state.readouts},target:state.face?.values,shapes:state.face?.shapes,frames:state.frames,fps:state.fps,expressions:[...state.active].filter(([,a])=>a.enabled).map(([key])=>key),motion:state.motion,physics:!!model?.internalModel.physics,modelSize:naturalSize,coreVersion:window.Live2DCubismCore?.Version.csmGetVersion()};},loadFile,stop:stopSource,toggleExpression,getParameter:id=>core?.getParameterValueById(id),ensureDetector,playMotion};
loadModel().catch(error=>{$('loading').replaceChildren();const strong=document.createElement('strong'),detail=document.createElement('span');strong.textContent='模型暂时无法加载';detail.textContent=error.message;$('loading').append(strong,detail);$('model-status').textContent='加载失败';notice('请确认模型资源已完整导出，再刷新页面。'+error.message,true);console.error(error);});
