import {attachHair,mountHair,loadHairMasks} from './hair-color.mjs';
import {createAccessoryFollow,AI_ACCESSORIES} from './ai-accessories.mjs';
// Module loading is awaited by sfx-host before attaching a loaded model.
const response = await fetch(new URL('../hair_palettes.json', import.meta.url));
if (!response.ok) throw Error('Hair palettes: ' + response.status);
const data = await response.json();
const masks = await loadHairMasks(new URL('../hair_masks/', import.meta.url));
const states = new WeakMap();
export function attachHostHair(model, sfx) {
  const renderer = model.getRenderer?.();
  if (!renderer || !model?._model?._model) return;
  const previous = states.get(model);
  if (previous?.renderer === renderer) return previous.api;
  const canvas = () => renderer.gl?.canvas || document.querySelector('canvas');
  const api = attachHair({raw:model._model._model,renderer,data,masks,canvas,sfx,storageKey:'deepseek-host-hair',
    snapshot:()=>{
      const gl=renderer.gl,clear=gl.getParameter(gl.COLOR_CLEAR_VALUE);
      try {gl.clearColor(0,0,0,0);gl.clear(gl.COLOR_BUFFER_BIT);renderer.drawModel();return canvas().toDataURL('image/png');}
      finally {gl.clearColor(...clear);}
    }});
  const canonical=new Map();
  for(let i=0;i<(model._modelSetting?.getExpressionCount()||0);i++){
    const key=model._modelSetting.getExpressionFileName(i).split('/').pop().replace(/\.exp3\.json$/,'');
    canonical.set(model._modelSetting.getExpressionName(i),key);canonical.set(key,key);
  }
  const accessories=previous?.accessories || new Map();
  const follow=createAccessoryFollow({storageKey:'deepseek-host-follow-hair',has:key=>canonical.has(key),apply:(key,on)=>accessories.set(AI_ACCESSORIES[key.slice(7)],Number(on))});
  api.follow=follow;follow.hair(api.palette);
  states.set(model, {renderer,api,canonical,accessories,follow});
  const native = model.setExpression?.bind(model);
  if (native && !previous) model.setExpression = name => {
    const state=states.get(model),key=state.canonical.get(name)||String(name).replace(/\.exp3\.json$/, '');
    if(key==='g4_bowl')return;
    if (key.startsWith('hair_')) {states.get(model).api.set(key.slice(5));return;}
    if (key==='eye_follow') {state.api.eyes.setFollow(true);return;}
    if (key.startsWith('eye_')) {state.api.eyes.set(key.slice(4));return;}
    if (key.startsWith('bow_')) {states.get(model).api.bow.set(key.slice(4));return;}
    if (key.startsWith('acc_ai_')) {state.follow.manual(key.replace(/_off$/,''),!key.endsWith('_off'));return;}
    return native(name);
  };
  if (!window.AIStage?.enabled) {
    let panel = document.getElementById('host-hair-controls');
    if (!panel) {panel=document.createElement('div');panel.id='host-hair-controls';panel.style.cssText='position:fixed;right:20px;top:130px;z-index:10000;background:#18384b;color:white;padding:0 12px;border-radius:12px';document.body.append(panel);}
    panel.replaceChildren(); mountHair(panel,api,data);
  }
  return api;
}

// Called inside the host's existing save/restore parameter scope, before Core
// update. Native expressions cannot undo this persistent, mutually exclusive set.
export function applyHostAccessories(model,write) {
  for(const [id,value] of states.get(model)?.accessories || [])write(id,value);
}
