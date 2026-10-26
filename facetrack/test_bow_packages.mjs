import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {probeHair} from './hair-color.mjs';
import {createAccessoryFollow,expressionKey} from './ai-accessories.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const sandbox={console,WebAssembly,atob,btoa,setTimeout,clearTimeout};vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(root,'facetrack/vendor/cubism/live2dcubismcore.min.js'),'utf8'),sandbox);
await new Promise(r=>setTimeout(r,200));
const Core=sandbox.Live2DCubismCore,report={};
const packages=process.env.FACETRACK_MODEL_DIR?[['snapshot',process.env.FACETRACK_MODEL_DIR,process.env.FACETRACK_MASK_DIR]]:[['release','export/DeepSeekNiang_v4','hair_masks']];
for(const [variant,folder,maskFolder] of packages){
  const dir=path.resolve(root,folder), settings=JSON.parse(fs.readFileSync(path.join(dir,'DeepSeekNiang.model3.json'),'utf8').replace(/^\uFEFF/,''));
  const manifest=JSON.parse(fs.readFileSync(path.resolve(root,maskFolder,'manifest.json'),'utf8'));
  const hashes={};
  for(const [page,expected] of Object.entries(manifest.texture_sha256)){
    const actual=createHash('sha256').update(fs.readFileSync(path.join(dir,settings.FileReferences.Textures[Number(page)]))).digest('hex');
    assert.equal(actual,expected,variant+' texture '+page);hashes[page]=actual;
  }
  const bytes=fs.readFileSync(path.join(dir,settings.FileReferences.Moc));
  const moc=Core.Moc.fromArrayBuffer(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength)),raw=Core.Model.fromMoc(moc);raw.update();
  const masks={headband:new Map(),ids:new Set()};
  for(const mask of manifest.masks){
    assert(mask.drawables?.length>0);
    for(const id of mask.drawables){const i=raw.drawables.ids.indexOf(id);assert(i>=0,variant+' missing '+id);assert.equal(raw.drawables.textureIndices[i],mask.page);}
    if(mask.role==='headband'){masks.headband.set(mask.page,{texels:mask.texels});for(const id of mask.drawables)masks.ids.add(id);}
  }
  const probe=probeHair(raw,masks);
  const bowIDs=manifest.masks.filter(m=>m.role==='bow').flatMap(m=>m.drawables);
  for(const id of bowIDs){const index=raw.drawables.ids.indexOf(id);assert(!probe.indices.includes(index)&&!probe.headband.includes(index),'hair/bow drawable overlap');}
  const refs=settings.FileReferences.Expressions,keys=new Set(refs.map(expressionKey)),active=new Map();
  const follow=createAccessoryFollow({has:k=>keys.has(k),apply:(k,v)=>active.set(k,v)});
  follow.hair('claude');assert([...active].filter(([,v])=>v).length===(keys.has('acc_ai_claude')?1:0));
  follow.hair('custom');assert([...active.values()].every(v=>!v));
  report[variant]={status:'passed',drawables:raw.drawables.count,bowIDs,headbandIDs:[...masks.ids],aiExpressions:refs.filter(r=>expressionKey(r).startsWith('acc_ai_')),hashes,mocSHA256:createHash('sha256').update(bytes).digest('hex')};
  raw.release();moc._release();
}
fs.writeFileSync(path.join(root,'renders/qa',process.env.COLOR_QA||'bowcolor','package_checks.json'),JSON.stringify(report,null,2));
console.log('PASS selected packages: own texture hashes, Core drawable pages, hair/bow separation, available-expression follow');
