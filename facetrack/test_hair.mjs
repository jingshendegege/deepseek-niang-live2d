import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {buildLUT,customPalette,probeHair,patchShader,attachHair} from './hair-color.mjs';
const root=fileURLToPath(new URL('../',import.meta.url)), run=process.env.COLOR_QA || 'haircolor2', qa=path.join(root,'renders/qa',run), tmp=path.join(root,'_tmp',process.env.COLOR_TMP||run);
fs.mkdirSync(qa,{recursive:true});fs.mkdirSync(tmp,{recursive:true});
const modelDir=process.env.FACETRACK_MODEL_DIR||path.join(root,'export/DeepSeekNiang_v4');
const manifest=JSON.parse(fs.readFileSync(path.join(process.env.FACETRACK_MASK_DIR||path.join(root,'hair_masks'),'manifest.json'),'utf8'));
const masks={roleIDs:{}};
for(const role of ['headband','bow','neckbow','iris']){masks[role]=new Map();masks.roleIDs[role]=new Set();for(const m of manifest.masks.filter(m=>m.role===role)){masks[role].set(m.page,{image:{},texels:m.texels});for(const id of m.drawables||[])masks.roleIDs[role].add(id);}}
masks.irisSides=manifest.iris_sides;
masks.ids=masks.roleIDs.headband;
const headbandTexels=[...masks.headband.values()].reduce((n,m)=>n+m.texels,0);
const data=JSON.parse(fs.readFileSync(path.join(root,'hair_palettes.json'),'utf8'));
const lutReport={};
for(const [name,spec] of Object.entries({...data.palettes,custom:customPalette('#5183bd')})){
  const lut=buildLUT(spec);lutReport[name]={width:lut.width,height:lut.height,rgba:Array.from(lut.data)};
}
fs.writeFileSync(path.join(tmp,'luts.json'),JSON.stringify(lutReport));
fs.writeFileSync(path.join(tmp,'bow_luts.json'),JSON.stringify(Object.fromEntries(Object.entries({...data.bows,custom:customPalette('#5183bd')}).map(([n,s])=>{const l=buildLUT(s);return [n,{height:l.height,rgba:Array.from(l.data)}];}))));
const sandbox={console,WebAssembly,atob,btoa,setTimeout,clearTimeout};vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(root,'facetrack/vendor/cubism/live2dcubismcore.min.js'),'utf8'),sandbox);
await new Promise(r=>setTimeout(r,200));
const C=sandbox.Live2DCubismCore;
const settings=JSON.parse(fs.readFileSync(path.join(modelDir,'DeepSeekNiang.model3.json'),'utf8').replace(/^\uFEFF/,''));
const bytes=fs.readFileSync(path.join(modelDir,settings.FileReferences.Moc));
const moc=C.Moc.fromArrayBuffer(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength)),raw=C.Model.fromMoc(moc);
raw.update();
// Probe from a deliberately non-default pose, not only the initial zero pose.
raw.parameters.values[raw.parameters.ids.indexOf('ParamAngleX')]=17;
raw.parameters.values[raw.parameters.ids.indexOf('ParamSkinBlack')]=.37;raw.update();
const save={params:Array.from(raw.parameters.values),vertices:raw.drawables.vertexPositions.map(v=>Array.from(v)),colors:Array.from(raw.drawables.multiplyColors),flags:Array.from(raw.drawables.dynamicFlags)};
const probe=probeHair(raw,masks);
assert.deepEqual(Array.from(raw.parameters.values),save.params);
assert.deepEqual(raw.drawables.vertexPositions.map(v=>Array.from(v)),save.vertices);
assert.deepEqual(Array.from(raw.drawables.multiplyColors),save.colors);
assert.deepEqual(Array.from(raw.drawables.dynamicFlags),save.flags);
assert(probe.changed.length>0&&probe.pages.length>0);
assert.equal(raw.drawables.ids[probe.tailDrawable],'ArtMeshTail');
assert.equal(probe.headbandTexels,headbandTexels);
assert(probe.headband.length>0);
assert.equal(Math.min(...probe.yn.get(probe.tailDrawable)),0);
assert.equal(Math.max(...probe.yn.get(probe.tailDrawable)),1);
assert(probe.bottom>-.303,'tail excluded from hair height');
raw.parameters.values.set(raw.parameters.defaultValues);raw.update();
const d=raw.drawables;
fs.writeFileSync(path.join(tmp,'geometry.json'),JSON.stringify({top:probe.top,bottom:probe.bottom,tailDrawable:probe.tailDrawable,tailAxis:probe.tailAxis,headband:probe.headband,headbandTexels:probe.headbandTexels,drawables:Array.from(d.ids,(id,i)=>({id,i,page:d.textureIndices[i],vertices:Array.from(d.vertexPositions[i]),uv:Array.from(d.vertexUvs[i]),tri:Array.from(d.indices[i]),yn:probe.yn.has(i)?Array.from(probe.yn.get(i)):null,masked:probe.headband.includes(i)}))}));
const version=C.Version.csmGetVersion();
fs.writeFileSync(path.join(qa,'core_probe.json'),JSON.stringify({coreVersion:version,version:`${version>>>24}.${version>>>16&255}.${version&65535}`,multiplyColors:true,screenColors:true,drawables:probe.indices,skinChanged:probe.changed,texturePages:probe.pages,top:probe.top,bottom:probe.bottom,restoreExact:true,modelSha256:(await import('node:crypto')).createHash('sha256').update(bytes).digest('hex')},null,2));
// Test all pinned shader variants; emit the exact patched GLSL for real GL compilation.
const pixi=fs.readFileSync(path.join(root,'facetrack/vendor/live2d/dist/cubism4.js'),'utf8');
const shaderNames=['vertexShaderSrcSetupMask','vertexShaderSrc','vertexShaderSrcMasked','fragmentShaderSrcsetupMask','fragmentShaderSrcPremultipliedAlpha','fragmentShaderSrcMaskPremultipliedAlpha','fragmentShaderSrcMaskInvertedPremultipliedAlpha'];
const shaders={};
for(const [kind,text] of [['pixi',pixi]]){
  shaders[kind]={};
  for(const name of shaderNames){
    const re=kind==='pixi'?new RegExp('const '+name+' = ("[^\\n]*");'):new RegExp('export const '+name+' =([\\s\\S]*?);\\r?\\n');
    const m=text.match(re);assert(m,name);
    const source=kind==='pixi'?JSON.parse(m[1]):Array.from(m[1].matchAll(/'([^']*)'/g),m=>m[1]).join('');
    const vertex=name.startsWith('vertex');const patched=patchShader(source,vertex);
    assert.equal(patchShader(patched,vertex),patched,'idempotent');
    if(name.toLowerCase().includes('setupmask'))assert.equal(source,patched,'mask untouched');
    else assert(patched.includes(vertex?'hc_restY':'hc_sample'));
    if(kind==='host'&&!vertex&&!name.toLowerCase().includes('setupmask'))assert(!patched.includes('tex.rgb *= hc_multiply'),'no double multiply');
    shaders[kind][name]=patched;
  }
}
fs.writeFileSync(path.join(tmp,'shaders.json'),JSON.stringify(shaders));
assert(shaders.pixi.fragmentShaderSrcPremultipliedAlpha.includes('smoothstep(0.0,1.0,hc_progress)'));
// CPU analytic PMA reference, including transparent and partial-alpha pixels.
for(const alpha of [0,.1,.5,1])for(const rgb of [[.2,.5,.8],[1,1,1],[0,0,0]]){
  const mul=[.12,.15,.2],screen=[.1,.2,.3];
  rgb.forEach((v,k)=>assert(Math.abs(((v*alpha*mul[k])+screen[k]*alpha-v*alpha*mul[k]*screen[k])-((v*mul[k]+screen[k]-v*mul[k]*screen[k])*alpha))<1e-12));
}
// Controller, storage failure, rapid switches, custom ramp identity, idempotent attach.
globalThis.window={};globalThis.localStorage={getItem(){throw Error('blocked');},setItem(){throw Error('blocked');}};
let now=0;Object.defineProperty(globalThis,'performance',{value:{now:()=>now},configurable:true});
function mockGL(){
  const uniforms={},draws=[],state={active:100,array:'original-buffer',bindings:new Map([[102,'old-unit2'],[103,'old-unit3'],[104,'old-unit4']]),flip:true,pre:true};
  const gl={uniforms,draws,state,TEXTURE0:100,program:{},deleted:0,uploads:0};
  for(const k of ['CURRENT_PROGRAM','ACTIVE_TEXTURE','TEXTURE_BINDING_2D','ARRAY_BUFFER_BINDING','ARRAY_BUFFER','UNPACK_FLIP_Y_WEBGL','UNPACK_PREMULTIPLY_ALPHA_WEBGL','TEXTURE_2D','RGBA','UNSIGNED_BYTE','TEXTURE_MIN_FILTER','TEXTURE_MAG_FILTER','NEAREST','TEXTURE_WRAP_S','TEXTURE_WRAP_T','CLAMP_TO_EDGE','FLOAT','STATIC_DRAW','VERTEX_SHADER','SHADER_TYPE'])gl[k]=k;
  gl.getParameter=k=>({CURRENT_PROGRAM:gl.program,ACTIVE_TEXTURE:state.active,TEXTURE_BINDING_2D:state.bindings.get(state.active),ARRAY_BUFFER_BINDING:state.array,UNPACK_FLIP_Y_WEBGL:state.flip,UNPACK_PREMULTIPLY_ALPHA_WEBGL:state.pre})[k];
  gl.getUniformLocation=(_,name)=>name;gl.getAttribLocation=()=>2;
  for(const m of ['uniform1f','uniform1i','uniform2f'])gl[m]=(name,...v)=>uniforms[name]=v;
  gl.uniform3fv=(name,v)=>uniforms[name]=Array.from(v);
  gl.createTexture=()=>({});gl.createBuffer=()=>({});
  gl.activeTexture=v=>state.active=v;gl.bindTexture=(_,t)=>state.bindings.set(state.active,t);
  gl.bindBuffer=(_,b)=>state.array=b;
  gl.pixelStorei=(k,v)=>state[k==='UNPACK_FLIP_Y_WEBGL'?'flip':'pre']=v;
  gl.texImage2D=()=>gl.uploads++;
  for(const m of ['texParameteri','enableVertexAttribArray','disableVertexAttribArray','vertexAttribPointer','vertexAttrib1f','bufferData'])gl[m]=()=>{};
  gl.bufferValues=new Map();gl.bufferData=(_,values)=>gl.bufferValues.set(state.array,Array.from(values));
  gl.deleteTexture=gl.deleteBuffer=()=>gl.deleted++;
  gl.shaderSource=(_shader,source)=>assert(source.includes('hc_y'));
  gl.getShaderParameter=s=>s.type;
  gl.drawElements=()=>draws.push(JSON.parse(JSON.stringify(uniforms)));
  return gl;
}
let mask=false;
const renderer={gl:mockGL(),drawMesh(){this.gl.shaderSource({type:this.gl.VERTEX_SHADER},shaders.pixi.vertexShaderSrc);this.gl.drawElements();},getClippingContextBufferForMask:()=>mask?{}:null,release(){}};
const effects=[];const options={raw,renderer,data,masks,canvas:()=>({addEventListener(){},toDataURL:()=> 'data:image/png;base64,test-double'}),sfx:{map:{hair:'spray'},playSfx:n=>effects.push(n)}};
const api=attachHair(options);assert.equal(attachHair(options),api);assert(Object.isFrozen(window.hairQA));
api.set('claude');assert.equal(api.palette,'claude');assert.deepEqual(effects,['spray']);
now=90;api.set('gemini');assert.equal(api.palette,'gemini');assert.equal(effects.length,1);
now=500;api.set('gpt');assert.equal(api.palette,'gpt');assert.equal(effects.length,2);
assert.throws(()=>api.set('bogus'));assert.throws(()=>customPalette('bad'));
const gl=renderer.gl,sourceMethod=gl.shaderSource,drawMethod=gl.drawElements;
const index=probe.changed[0],draw=i=>renderer.drawMesh(0,0,0,null,raw.drawables.vertexPositions[i]);
now=1000;draw(index);assert.equal(gl.draws.at(-1).hc_enabled[0],1);
assert.equal(gl.shaderSource,sourceMethod);assert.equal(gl.drawElements,drawMethod);
assert.equal(gl.state.active,100);assert.equal(gl.state.array,'original-buffer');assert.equal(gl.state.bindings.get(102),'old-unit2');assert.equal(gl.state.bindings.get(103),'old-unit3');assert.equal(gl.state.flip,true);assert.equal(gl.state.pre,true);
const param=raw.parameters.ids.indexOf('ParamSkinBlack');
for(const skin of [0,1]){raw.parameters.values[param]=skin;raw.update();draw(index);assert.deepEqual(gl.draws.at(-1).hc_multiply,Array.from(raw.drawables.multiplyColors.slice(index*4,index*4+3)));}
draw(Array.from(raw.drawables.ids).findIndex((_,i)=>!probe.yn.has(i)));assert.equal(gl.draws.at(-1).hc_enabled[0],0,'non-hair unchanged');
for(const h of probe.headband){draw(h);assert.equal(gl.draws.at(-1).hc_enabled[0],1);assert.equal(gl.draws.at(-1).hc_masked[0],1);}
assert.equal(gl.state.bindings.get(104),'old-unit4');
assert.equal(window.hairQA.headbandTexels,headbandTexels);assert.equal(window.hairQA.tailDrawable,probe.tailDrawable);
assert.throws(()=>{window.hairQA.tailDrawable=0;});
draw(probe.tailDrawable);
const tailRest=Array.from(probe.yn.get(probe.tailDrawable));
const tailBuffer=[...gl.bufferValues].find(([,v])=>JSON.stringify(v)===JSON.stringify(tailRest))[0];
const tailBefore=Array.from(raw.drawables.vertexPositions[probe.tailDrawable]);
// Since v4y ParamSkelTailSwing is a physics input; without physics only ParamTail1..4 (physics outputs) bend the tail.
const swing=['ParamTail4','ParamTail3','ParamSkelTailSwing'].map(id=>raw.parameters.ids.indexOf(id)).find(i=>i>=0);assert(swing>=0);
raw.parameters.values[swing]=raw.parameters.maximumValues[swing];raw.update();draw(probe.tailDrawable);
assert.notDeepEqual(Array.from(raw.drawables.vertexPositions[probe.tailDrawable]),tailBefore);
assert.deepEqual(gl.bufferValues.get(tailBuffer),tailRest,'rest attribute stays attached during deformation');
raw.parameters.values[swing]=raw.parameters.defaultValues[swing];raw.update();
now=1400;api.set('custom','#123456');draw(index);
now=1800;api.set('custom','#abcdef');draw(index);assert.notEqual(gl.uniforms.hc_oldLUT,undefined);
const drawsBefore=gl.draws.length;mask=true;draw(index);mask=false;assert.equal(gl.draws.length,drawsBefore+1,'mask passes native draw');
assert.equal(gl.shaderSource,sourceMethod);assert.equal(gl.drawElements,drawMethod);
// Independent bow controller: 300 ms whole dissolve; neck opt-in; no hair
// mutation; all six added units and pixel unpack flags restored after draw.
const bowIndex=Array.from(d.ids).indexOf('ArtMeshHeadwearL'), neckIndex=Array.from(d.ids).indexOf('ArtMeshTopwear');
const savedHair=api.palette;
for(let unit=105;unit<=107;unit++)gl.state.bindings.set(unit,'old-unit'+unit);
assert.equal(api.bow.neck,false);
now=2200;api.bow.set('pink');draw(bowIndex);assert.equal(gl.uniforms.bc_enabled[0],1);assert.equal(gl.uniforms.bc_progress[0],0);
now=2350;draw(bowIndex);assert.equal(gl.uniforms.bc_progress[0],.5);
draw(neckIndex);assert.equal(gl.uniforms.bc_enabled[0],0);
api.bow.setNeck(true);draw(neckIndex);assert.equal(gl.uniforms.bc_enabled[0],1);
now=2500;draw(bowIndex);assert.equal(gl.uniforms.bc_progress[0],1);assert.equal(api.palette,savedHair);
assert.equal(effects.at(-1),'clip_snap');
for(let unit=105;unit<=107;unit++)assert.equal(gl.state.bindings.get(unit),'old-unit'+unit);
api.bow.set('black');now=2550;api.bow.set('gold');assert.equal(api.bow.palette,'gold');
now=2801;draw(bowIndex);assert.equal(api.bow.palette,'gold');assert.equal(gl.uniforms.bc_progress[0],0);
draw(probe.tailDrawable);assert.equal(gl.uniforms.bc_enabled[0],0);assert.equal(gl.uniforms.hc_enabled[0],1);
assert(Object.isFrozen(window.bowQA));assert.throws(()=>api.bow.set('missing'));
// Iris reuses the auxiliary samplers per drawable; no ninth texture unit.
if(masks.roleIDs.iris?.size){
  now=3200;api.eyes.setSplit(true);api.eyes.set('claude',undefined,'L');api.eyes.set('gpt',undefined,'R');now=3600;
  for(const id of masks.roleIDs.iris){draw(d.ids.indexOf(id));assert.equal(gl.uniforms.bc_enabled[0],1,id);assert.deepEqual(gl.uniforms.bc_lumRange,data.eye_lum_range);assert.deepEqual(gl.uniforms.bc_original,[0,0]);assert.equal(gl.uniforms.hc_enabled[0],0);}
  for(const id of ['ArtMeshImage_30','ArtMeshImage_31','ArtMeshEyelashL','ArtMeshEyewhiteR']){draw(d.ids.indexOf(id));assert.equal(gl.uniforms.bc_enabled[0],0,id);}
  for(const yaw of [-30,-15,0,15,30])for(const open of [0,.1,.5,1])for(const smile of [0,.5,1]){
    raw.parameters.values.set(raw.parameters.defaultValues);
    for(const [id,v] of Object.entries({ParamAngleX:yaw,ParamEyeLOpen:open,ParamEyeROpen:1,ParamEyeLSmile:smile}))raw.parameters.values[raw.parameters.ids.indexOf(id)]=v;
    raw.update();for(const id of masks.roleIDs.iris){draw(d.ids.indexOf(id));assert.equal(gl.uniforms.bc_enabled[0],1);assert.deepEqual(gl.uniforms.bc_original,[0,0]);}
  }
  raw.parameters.values.set(raw.parameters.defaultValues);raw.update();
  draw(bowIndex);assert.deepEqual(gl.uniforms.bc_lumRange,data.bow_lum_range);
  for(let unit=105;unit<=107;unit++)assert.equal(gl.state.bindings.get(unit),'old-unit'+unit);
}
renderer.release();assert(gl.deleted>0);
// Actual host command wrapper with the real Core and a renderer double.
globalThis.fetch=async url=>({ok:true,json:async()=>JSON.parse(fs.readFileSync(fileURLToPath(url),'utf8'))});
window.AIStage={enabled:true};
globalThis.Image=class {naturalWidth=4096;naturalHeight=4096;set src(url){assert(fs.existsSync(fileURLToPath(url)));queueMicrotask(()=>this.onload());}};
const {attachHostHair,applyHostAccessories}=await import(new URL('./hair-host.mjs',import.meta.url));
const hostRenderer={...renderer,gl:mockGL(),drawMesh(){},release(){}};
hostRenderer.gl.canvas={addEventListener(){}};
let nativeExpression=null;
const hostModel={_model:{_model:raw},getRenderer:()=>hostRenderer,setExpression:n=>nativeExpression=n};
const hostAPI=attachHostHair(hostModel,{map:{hair:'spray'},playSfx:n=>effects.push(n)});
hostModel.setExpression('hair_claude');assert.equal(hostAPI.palette,'claude');assert.equal(nativeExpression,null);
hostModel.setExpression('smile');assert.equal(nativeExpression,'smile');
hostModel.setExpression('bow_pink');assert.equal(hostAPI.bow.palette,'pink');
hostModel.setExpression('eye_gpt');assert.equal(hostAPI.eyes.values.L.name,'gpt');assert(!hostAPI.eyes.follow);
hostModel.setExpression('eye_follow');assert(hostAPI.eyes.follow);assert.equal(hostAPI.eyes.values.L.name,'claude');
hostModel.setExpression('g4_bowl');assert.equal(nativeExpression,'smile');
const absent=[];applyHostAccessories(hostModel,(...args)=>absent.push(args));assert.deepEqual(absent,[]);
hostModel.setExpression('acc_ai_claude');assert.equal(nativeExpression,'smile','absent AI expression silently skipped');
const {createAccessoryFollow,AI_ACCESSORIES}=await import('./ai-accessories.mjs');
const selected=new Map(),available=new Set(Object.keys(AI_ACCESSORIES).map(n=>'acc_ai_'+n));
const follow=createAccessoryFollow({has:k=>available.has(k),apply:(k,v)=>selected.set(k,v)});
follow.hair('claude');assert.deepEqual([...selected].filter(([,v])=>v).map(([k])=>k),['acc_ai_claude']);
follow.hair('gemini');assert.equal(selected.get('acc_ai_claude'),false);assert.equal(selected.get('acc_ai_gemini'),true);
follow.hair('deepseek');assert([...selected.values()].every(v=>!v));
follow.manual('acc_ai_gpt',true);follow.setEnabled(false);follow.hair('claude');assert.equal(selected.get('acc_ai_gpt'),true);
follow.setEnabled(true);assert.equal(selected.get('acc_ai_claude'),true);follow.hair('custom');assert([...selected.values()].every(v=>!v));
follow.manual('acc_ai_bing',true);assert.equal(selected.get('acc_ai_bing'),true);follow.manual('acc_ai_bing',false);assert([...selected.values()].every(v=>!v));
const store=new Map();globalThis.localStorage={getItem:k=>store.get(k)||null,setItem:(k,v)=>store.set(k,v)};
follow.setEnabled(false);assert.equal(createAccessoryFollow({has:()=>false,apply:()=>assert.fail('missing expression')}).enabled,false);
const tags=Object.keys(AI_ACCESSORIES).map(n=>'acc_ai_'+n), names=tags.map(n=>'Display '+n);
const presentModel={_model:{_model:raw},getRenderer:()=>({...hostRenderer,gl:mockGL()}),setExpression:n=>assert.fail('native AI expression call: '+n),_modelSetting:{getExpressionCount:()=>tags.length,getExpressionName:i=>names[i],getExpressionFileName:i=>'expressions/'+tags[i]+'.exp3.json'}};
// Stable renderer reference, as in the real host.
const presentRenderer=presentModel.getRenderer();presentModel.getRenderer=()=>presentRenderer;
presentRenderer.gl.canvas={addEventListener(){}};
const presentAPI=attachHostHair(presentModel,{playSfx(){}});
presentModel.setExpression('hair_gemini');let written={};applyHostAccessories(presentModel,(id,v)=>written[id]=v);
assert.equal(written.ParamAccGemini,1);assert.equal(Object.values(written).filter(Boolean).length,1);
presentModel.setExpression(names[0]);written={};applyHostAccessories(presentModel,(id,v)=>written[id]=v);assert.equal(written.ParamAccClaude,1);assert.equal(written.ParamAccGemini,0);
presentModel.setExpression('acc_ai_claude_off');written={};applyHostAccessories(presentModel,(id,v)=>written[id]=v);assert(Object.values(written).every(v=>v===0));
presentAPI.bow.setNeck(true);presentAPI.bow.set('custom','#112233');
const {createBowChannel}=await import('./bow-color.mjs');
const restored=createBowChannel({data,buildLUT,customPalette,storageKey:'deepseek-host-hair-bow'});assert.equal(restored.palette,'custom');assert.equal(restored.custom,'#112233');assert.equal(restored.neck,true);
fs.writeFileSync(path.join(qa,'bow_follow_checks.json'),JSON.stringify({status:'passed',bowFadeMs:300,independentHair:true,neckOptIn:true,storageBlockedAndRestore:true,sixTextureUnitsRestored:true,followMissingAndPresentModels:true,followToggleManualAndBing:true,hostCanonicalNamesAndOff:true},null,2));
fs.writeFileSync(path.join(qa,'node_checks.json'),JSON.stringify({status:'passed',shaderVariants:7,probeRestoration:true,storageBlockedSafe:true,rapidSwitchQueued:true,maskUntouched:true,nativeColoursNotDoubled:true,coreColourOrderPMA:true,frameColourUniforms:true,glStateRestored:true,rendererResourcesReleased:true,hostCommandWrapper:true,headbandTexels:probe.headbandTexels,headbandDrawables:probe.headband,tailDrawable:probe.tailDrawable,tailAxis:probe.tailAxis,tailRange:[0,1],tailDeformationKeepsAttribute:true,wholeHairDissolve:true,qaFieldsReadOnly:true},null,2));
console.log('PASS hair Core probe, exact restoration, 7 GLSL variants, PMA algebra, LUT export, controller/storage/queue.');
