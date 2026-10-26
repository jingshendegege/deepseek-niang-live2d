// Shared renderer adapter. No vendor edits; pinned GLSL anchors fail closed.
import {createBowChannel,mountBow} from './bow-color.mjs';
import {createEyeChannel,mountEyes} from './eye-color.mjs';
import {mountAccessoryFollow} from './ai-accessories.mjs';
const clamp = x => Math.max(0, Math.min(1, x));
export function buildLUT(spec) {
  const height = spec.mode === 'lum_y' ? 64 : 1;
  const data = new Uint8Array(256 * height * 4);
  const interp = (stops, x) => {
    let j = 1; while (j < stops.length - 1 && x > stops[j][0]) j++;
    const [a, ca] = stops[j - 1], [b, cb] = stops[j];
    const t = clamp((x - a) / (b - a));
    return ca.map((c, k) => (c + (cb[k] - c) * t) / 255);
  };
  for (let y = 0; y < height; y++) for (let x = 0; x < 256; x++) {
    const u = x / 255;
    let rgb = [0, 0, 0];
    if (!spec.original) {
      if (height === 1) rgb = interp(spec.stops, u);
      else {
        const base = interp(spec.y_stops, y / 63), lo = clamp(u / .55), hi = clamp((u - .55) / .45);
        rgb = base.map(c => u <= .55 ? c * .2 + c * .8 * lo * lo * (3 - 2 * lo) : c + (c * .15 + .85 - c) * hi);
      }
    }
    const i = (y * 256 + x) * 4;
    rgb.forEach((v, k) => data[i + k] = Math.round(clamp(v) * 255)); data[i + 3] = 255;
  }
  return {width: 256, height, data, original: !!spec.original};
}
export function customPalette(hex) {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) throw Error('Invalid hair colour');
  const c = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
  return {mode: 'lum', label: '自定义', chip: c, stops: [[0, c.map(v => v * .2)], [.6, c], [1, c.map(v => v * .15 + 255 * .85)]]};
}

// Direct Core updates only: no motion/physics steps. Restore all exposed mutable
// output arrays too, including dynamic flags, so probing cannot alter frame one.
const headwearIDs = new Set(['ArtMeshHeadwear', 'ArtMeshHeadwearL', 'ArtMeshHeadwearR', 'ArtMeshImage_28', 'ArtMeshImage_29']);
export async function loadHairMasks(baseURL) {
  const response = await fetch(new URL('manifest.json', baseURL));
  if (!response.ok) throw Error('Hair masks: ' + response.status);
  const manifest = await response.json(), headband = new Map(), ids = new Set();
  const roles = {headband, bow:new Map(), neckbow:new Map(),iris:new Map()}, roleIDs = {headband:ids,bow:new Set(),neckbow:new Set(),iris:new Set()};
  // Texel-masked drawables come from the manifest (headwear band, hair strips baked into the basin and the
  // chef hat); the fixed headwear list is only the fallback for an older manifest.
  for (const m of manifest.masks) if (m.role === 'headband') for (const id of m.drawables || headwearIDs) ids.add(id);
  await Promise.all(manifest.masks.filter(m => roles[m.role]).map(async m => {
    for (const id of m.drawables || []) roleIDs[m.role].add(id);
    const image = new Image();
    const ready = new Promise((resolve, reject) => {image.onload = resolve; image.onerror = () => reject(Error('Hair mask: ' + m.file));});
    image.src = new URL(m.file, baseURL).href;
    await ready;
    if (image.naturalWidth !== 4096 || image.naturalHeight !== 4096) throw Error('Hair: unexpected mask size');
    roles[m.role].set(m.page, {image, texels: m.texels});
  }));
  return {...roles, ids, roleIDs,irisSides:manifest.iris_sides||{}};
}

export function probeHair(raw, masks = {headband: new Map()}) {
  const p = raw.parameters, d = raw.drawables, pi = Array.from(p.ids).indexOf('ParamSkinBlack');
  if (pi < 0 || !d.multiplyColors || !d.screenColors) throw Error('Hair: Core 4.2+ colours / ParamSkinBlack missing');
  const saved = [];
  const keep = a => { if (ArrayBuffer.isView(a)) saved.push([a, a.slice()]); else if (Array.isArray(a)) a.forEach(keep); };
  for (const obj of [p, raw.parts, d]) for (const a of Object.values(obj || {})) keep(a);
  try {
    p.values.set(p.defaultValues); p.values[pi] = 0; raw.update();
    const off = d.multiplyColors.slice(), vertices = d.vertexPositions.map(v => v.slice());
    p.values[pi] = 1; raw.update();
    const changed = [], pages = [], indices = [];
    for (let i = 0; i < d.count; i++) {
      const diff = off.subarray(i * 4, i * 4 + 4).some((v, k) => Math.abs(v - d.multiplyColors[i * 4 + k]) > 1e-5);
      const page = [2, 4].includes(d.textureIndices[i]);
      if (diff) changed.push(i); if (page) pages.push(i); if (diff || page) indices.push(i);
    }
    if (!changed.length) throw Error('Hair: black-skin probe found no drawables');
    const tailDrawable = Array.from(d.ids).indexOf('ArtMeshTail');
    if (tailDrawable < 0) throw Error('Hair: ArtMeshTail missing');
    if (!indices.includes(tailDrawable)) indices.push(tailDrawable);
    const maskedIDs = masks.ids || headwearIDs;
    const headband = Array.from(d.ids, (id, i) => maskedIDs.has(id) && masks.headband.has(d.textureIndices[i]) ? i : -1).filter(i => i >= 0);
    // Headwear is ONLY recoloured through its texel mask, even if a future
    // black-skin parameter also happens to affect that drawable.
    for (const i of headband) {const at = indices.indexOf(i); if (at >= 0) indices.splice(at, 1);}
    let top = -Infinity, bottom = Infinity;
    for (const i of indices) if (i !== tailDrawable) for (let j = 1; j < vertices[i].length; j += 2) {top = Math.max(top, vertices[i][j]); bottom = Math.min(bottom, vertices[i][j]);}
    // Rest-pose model-space Y becomes a vertex attribute. It deforms with the
    // mesh, unlike a screen-space gradient or a moving screen-space bounding box.
    const yn = new Map([...indices, ...headband].map(i => [i, Float32Array.from({length: vertices[i].length / 2}, (_, j) => clamp((top - vertices[i][j * 2 + 1]) / (top - bottom)))]));
    // This model's default tail root is at min X, fin tip at max X. Store once
    // per vertex so the full gradient follows tail deformation and rotation.
    const xs = Array.from(vertices[tailDrawable]).filter((_, j) => j % 2 === 0);
    const rootX = Math.min(...xs), tipX = Math.max(...xs);
    if (!(tipX > rootX)) throw Error('Hair: degenerate tail axis');
    yn.set(tailDrawable, Float32Array.from(xs, x => clamp((x - rootX) / (tipX - rootX))));
    return {indices, changed, pages, top, bottom, yn, headband, tailDrawable, tailAxis: {rootX, tipX},
      headbandTexels: [...masks.headband.values()].reduce((n, m) => n + m.texels, 0)};
  } finally {
    for (const [a, b] of saved) a.set(b);
    raw.update();
    for (const [a, b] of saved) a.set(b);
  }
}

const fragment = `
varying mediump float hc_y;
uniform sampler2D hc_oldLUT;
uniform sampler2D hc_newLUT;
uniform sampler2D hc_headbandMask;
uniform float hc_masked;
uniform vec2 hc_rows;
uniform vec2 hc_original;
uniform vec2 hc_lumRange;
uniform float hc_enabled;
uniform float hc_progress;
uniform vec3 hc_multiply;
uniform vec3 hc_screen;
uniform sampler2D bc_oldLUT;
uniform sampler2D bc_newLUT;
uniform sampler2D bc_mask;
uniform vec2 bc_original;
uniform vec2 bc_lumRange;
uniform float bc_progress;
uniform float bc_enabled;
vec3 hc_lookup(sampler2D lut, float rows, float u, float y) {
  // Match promo.Ramp.__call__: floor, clamp and nearest texel, not linear filtering.
  return texture2D(lut, vec2((floor(u*255.0)+0.5)/256.0, (floor(y*(rows-1.0))+0.5)/rows)).rgb;
}
vec4 hc_sample(vec4 tex) {
  vec4 source = tex;
  if (hc_enabled > 0.5 && tex.a > 0.00001) {
    vec3 rgb = tex.rgb / tex.a;
    float u = clamp((dot(rgb, vec3(0.299,0.587,0.114))-hc_lumRange.x)/(hc_lumRange.y-hc_lumRange.x),0.0,1.0);
    float y = clamp(hc_y,0.0,1.0);
    vec3 oldRGB = mix(hc_lookup(hc_oldLUT,hc_rows.x,u,y),rgb,hc_original.x);
    vec3 newRGB = mix(hc_lookup(hc_newLUT,hc_rows.y,u,y),rgb,hc_original.y);
    // Whole-hair dissolve: a top-down wipe showed two hairstyles at once mid-change.
    float k = smoothstep(0.0,1.0,hc_progress);
    float coverage = hc_masked > 0.5 ? texture2D(hc_headbandMask, v_texCoord).r : 1.0;
    tex.rgb = mix(rgb, mix(oldRGB,newRGB,k), coverage) * tex.a;
  }
  if (bc_enabled > 0.5 && source.a > 0.00001) {
    vec3 rgb = source.rgb / source.a;
    float u = clamp((dot(rgb,vec3(0.299,0.587,0.114))-bc_lumRange.x)/(bc_lumRange.y-bc_lumRange.x),0.0,1.0);
    vec3 oldRGB = mix(hc_lookup(bc_oldLUT,1.0,u,0.0),rgb,bc_original.x);
    vec3 newRGB = mix(hc_lookup(bc_newLUT,1.0,u,0.0),rgb,bc_original.y);
    tex.rgb = mix(tex.rgb,mix(oldRGB,newRGB,smoothstep(0.0,1.0,bc_progress))*source.a,texture2D(bc_mask,v_texCoord).r);
  }
  HC_CORE_COLOURS
  return tex;
}
`;
export function patchShader(source, vertex) {
  if (source.includes('hc_sample') || source.includes('hc_y') || source.includes('v_myPos')) return source;
  if (!source.includes('v_texCoord') || !/void\s+main\s*\(\s*\)\s*\{/.test(source)) throw Error('Hair: unsupported Cubism GLSL');
  if (vertex) return 'attribute float hc_restY; varying mediump float hc_y;\n' + source.replace(/void\s+main\s*\(\s*\)\s*\{/, '$& hc_y = hc_restY;');
  const sample = /texture2D\(\s*s_texture0\s*,\s*v_texCoord\s*\)/g;
  if ((source.match(sample) || []).length !== 1) throw Error('Hair: expected one diffuse sampler anchor');
  const nativeColours = source.includes('u_multiplyColor') && source.includes('u_screenColor');
  const code = fragment.replace('HC_CORE_COLOURS', nativeColours ? '' :
    'tex.rgb *= hc_multiply; tex.rgb = tex.rgb + hc_screen * tex.a - tex.rgb * hc_screen;');
  // Insert after precision / declarations, before main; preserve SDK mask + blend logic.
  return source.replace(sample, 'hc_sample($&)').replace(/void\s+main\s*\(\s*\)\s*\{/, code + '\n$&');
}

const attached = new WeakMap();
export function attachHair({raw, renderer, data, masks = {headband: new Map()}, canvas, snapshot, sfx, storageKey = 'deepseek-hair'}) {
  if (attached.has(renderer)) return attached.get(renderer);
  const probe = probeHair(raw, masks), headband = new Set(probe.headband), hair = new Set([...probe.indices, ...probe.headband]), vertexIndex = new Map(raw.drawables.vertexPositions.map((v, i) => [v, i]));
  const specs = {...data.palettes}, luts = new Map();
  const bow = createBowChannel({data,buildLUT,customPalette,sfx,storageKey:storageKey+'-bow'});
  const eyes = createEyeChannel({data,buildLUT,storageKey:storageKey+'-eyes'});
  const irisIDs = new Map(Array.from(raw.drawables.ids,(id,i)=>[i,masks.roleIDs?.iris?.has(id)?masks.irisSides?.[id]||(id.endsWith('R')?'R':'L'):null]).filter(([,side])=>side));
  const bowIDs = new Set(Array.from(raw.drawables.ids,(id,i)=>masks.roleIDs?.bow?.has(id)?i:-1).filter(i=>i>=0));
  const neckIDs = new Set(Array.from(raw.drawables.ids,(id,i)=>masks.roleIDs?.neckbow?.has(id)?i:-1).filter(i=>i>=0));
  let current = 'deepseek', started = -Infinity, pending = null;
  let custom = '#' + data.palettes.deepseek.chip.map(v => v.toString(16).padStart(2,'0')).join('');
  let glCache, changed = () => {}, oldRamp, newRamp;
  const clock = () => performance.now();
  const resolve = name => luts.get(name) || (luts.set(name, buildLUT(specs[name])), luts.get(name));
  const begin = (name, hex, now, sound) => {
    oldRamp = newRamp; current = name;
    if (name === 'custom') {custom = hex || custom; specs.custom = customPalette(custom); luts.delete('custom');}
    newRamp = resolve(current);
    started = now; changed();
    if (sound) sfx?.playSfx(sfx.map?.hair || 'spray');
  };
  // Serialize fast clicks: finish the current 360 ms dissolve, then use its
  // exact result as the old LUT. This avoids snapping back halfway through.
  const advance = now => {if (pending && now - started >= 360) {const p = pending; pending = null; begin(p.name, p.hex, now, true);}};
  const api = {
    probe, bow, eyes, follow:null, get palette() {return pending?.name || current;}, get custom() {return custom;},
    set(name, hex) {
      if (name !== 'custom' && !specs[name]) throw Error('Unknown hair palette: ' + name);
      if (name === 'custom') customPalette(hex || custom);
      const now = clock(); advance(now);
      api.follow?.hair(name);
      eyes.hair(name,hex||custom);
      if (name === current && name !== 'custom' && !pending) return;
      if (now - started < 360) pending = {name, hex}; else begin(name, hex, now, true);
      try {localStorage.setItem(storageKey, JSON.stringify({name, custom: hex || custom}));} catch {}
      changed();
    },
    onChange(fn) {changed = fn;},
    snapshot: () => snapshot ? snapshot() : canvas().toDataURL('image/png'),
  };
  try {
    const v = JSON.parse(localStorage.getItem(storageKey));
    if (v?.name === 'custom') {specs.custom = customPalette(v.custom); custom = v.custom;}
    if (v && specs[v.name]) current = v.name;
  } catch {}
  oldRamp = newRamp = resolve(current);
  eyes.hair(current,custom);
  function resources(gl) {
    if (!glCache || glCache.gl !== gl) glCache = {gl, programs: new Map(), textures: new Map(), maskTextures: new Map(), buffers: new Map()};
    return glCache;
  }
  function bind(gl, index) {
    const cache = resources(gl), program = gl.getParameter(gl.CURRENT_PROGRAM);
    let p = cache.programs.get(program);
    if (!p) {
      p = Object.fromEntries(['oldLUT','newLUT','headbandMask','masked','rows','original','lumRange','enabled','progress','multiply','screen'].map(n => [n, gl.getUniformLocation(program, 'hc_' + n)]));
      p.y = gl.getAttribLocation(program, 'hc_restY'); cache.programs.set(program, p);
      p.bow = Object.fromEntries(['oldLUT','newLUT','mask','original','lumRange','progress','enabled'].map(n=>[n,gl.getUniformLocation(program,'bc_'+n)]));
    }
    if (p.enabled === null) throw Error('Hair shader was compiled before adapter attachment');
    const now = clock(); advance(now);eyes.tick(now);
    gl.uniform1f(p.enabled, hair.has(index) ? 1 : 0);
    gl.uniform1f(p.masked, headband.has(index) ? 1 : 0);
    gl.uniform1f(p.progress, clamp((now - started) / 360));
    gl.uniform2f(p.lumRange, ...data.lum_range);
    gl.uniform3fv(p.multiply, raw.drawables.multiplyColors.subarray(index * 4, index * 4 + 3));
    gl.uniform3fv(p.screen, raw.drawables.screenColors.subarray(index * 4, index * 4 + 3));
    const active = gl.getParameter(gl.ACTIVE_TEXTURE), savedTextures = [];
    const pair = [oldRamp, newRamp];
    for (let j = 0; j < 2; j++) {
      const lut = pair[j]; gl.activeTexture(gl.TEXTURE0 + 2 + j);
      savedTextures.push(gl.getParameter(gl.TEXTURE_BINDING_2D));
      let tex = cache.textures.get(lut);
      if (!tex) {
        tex = gl.createTexture(); cache.textures.set(lut, tex); gl.bindTexture(gl.TEXTURE_2D, tex);
        const flip = gl.getParameter(gl.UNPACK_FLIP_Y_WEBGL), pre = gl.getParameter(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false); gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, lut.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, lut.data);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, flip); gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, pre);
        for (const kind of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_2D, kind, gl.NEAREST);
        for (const kind of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T]) gl.texParameteri(gl.TEXTURE_2D, kind, gl.CLAMP_TO_EDGE);
      } else gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.uniform1i(j ? p.newLUT : p.oldLUT, 2 + j);
    }
    // Unit 4 is separate from the SDK diffuse/clip-mask units (0/1) and LUTs (2/3).
    gl.activeTexture(gl.TEXTURE0 + 4);
    savedTextures.push(gl.getParameter(gl.TEXTURE_BINDING_2D));
    const mask = headband.has(index) ? masks.headband.get(raw.drawables.textureIndices[index]) : null;
    let maskTexture = cache.maskTextures.get(mask);
    if (!maskTexture) {
      maskTexture = gl.createTexture(); cache.maskTextures.set(mask, maskTexture);
      gl.bindTexture(gl.TEXTURE_2D, maskTexture);
      const flip = gl.getParameter(gl.UNPACK_FLIP_Y_WEBGL), pre = gl.getParameter(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false); gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      // SDK v_texCoord already flips Core's UV Y; PNG rows must NOT flip again.
      if (mask) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, mask.image);
      else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0,0,0,255]));
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, flip); gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, pre);
      for (const kind of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_2D, kind, gl.NEAREST);
      for (const kind of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T]) gl.texParameteri(gl.TEXTURE_2D, kind, gl.CLAMP_TO_EDGE);
    } else gl.bindTexture(gl.TEXTURE_2D, maskTexture);
    gl.uniform1i(p.headbandMask, 4);
    gl.uniform2f(p.rows, pair[0].height, pair[1].height); gl.uniform2f(p.original, +pair[0].original, +pair[1].original);
    // WebGL1's guaranteed eight units: SDK 0/1, hair 2/3/4, bow 5/6/7.
    // Iris and bows never share a drawable. Reuse these three samplers so
    // WebGL1 still needs exactly eight texture units, including SDK clipping.
    const irisSide=irisIDs.get(index),bowFrame = irisSide?eyes.frame(irisSide,now):bow.frame(now), bp = p.bow;
    gl.uniform1f(bp.enabled, irisSide || bowIDs.has(index) || (bow.neck && neckIDs.has(index)) ? 1 : 0);
    gl.uniform1f(bp.progress,bowFrame.progress);
    gl.uniform2f(bp.original,...bowFrame.pair.map(lut=>+lut.original));
    // The navy neck/shoe bows sit far darker than the bright head bows: give them their own range so a
    // light colour (gold, pink) reaches its mid tones there instead of the muddy dark end of the ramp.
    const neckOnly = !bowIDs.has(index) && neckIDs.has(index);
    gl.uniform2f(bp.lumRange,...(irisSide?(data.eye_lum_range||[0,.85]):((neckOnly && data.neckbow_lum_range) || data.bow_lum_range || data.lum_range)));
    const bowMask = (irisSide?masks.iris:bowIDs.has(index) ? masks.bow : neckIDs.has(index) ? masks.neckbow : null)?.get(raw.drawables.textureIndices[index]);
    for (let j=0;j<3;j++) {
      gl.activeTexture(gl.TEXTURE0+5+j);savedTextures.push(gl.getParameter(gl.TEXTURE_BINDING_2D));
      const item=j<2?bowFrame.pair[j]:bowMask || null, table=j<2?cache.textures:cache.maskTextures;
      let texture=table.get(item);
      if (!texture) {
        texture=gl.createTexture();table.set(item,texture);gl.bindTexture(gl.TEXTURE_2D,texture);
        const flip=gl.getParameter(gl.UNPACK_FLIP_Y_WEBGL),pre=gl.getParameter(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,false);gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL,false);
        if(j<2)gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,256,1,0,gl.RGBA,gl.UNSIGNED_BYTE,item.data);
        else if(item)gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,item.image);
        else gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,1,1,0,gl.RGBA,gl.UNSIGNED_BYTE,new Uint8Array([0,0,0,255]));
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,flip);gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL,pre);
        for(const kind of [gl.TEXTURE_MIN_FILTER,gl.TEXTURE_MAG_FILTER])gl.texParameteri(gl.TEXTURE_2D,kind,gl.NEAREST);
        for(const kind of [gl.TEXTURE_WRAP_S,gl.TEXTURE_WRAP_T])gl.texParameteri(gl.TEXTURE_2D,kind,gl.CLAMP_TO_EDGE);
      } else gl.bindTexture(gl.TEXTURE_2D,texture);
      gl.uniform1i(j===0?bp.oldLUT:j===1?bp.newLUT:bp.mask,5+j);
    }
    const arrayBuffer = gl.getParameter(gl.ARRAY_BUFFER_BINDING);
    if (p.y >= 0) {
      if (hair.has(index)) {
        let buffer = cache.buffers.get(index);
        if (!buffer) {buffer = gl.createBuffer(); cache.buffers.set(index, buffer); gl.bindBuffer(gl.ARRAY_BUFFER, buffer); gl.bufferData(gl.ARRAY_BUFFER, probe.yn.get(index), gl.STATIC_DRAW);}
        else gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.enableVertexAttribArray(p.y); gl.vertexAttribPointer(p.y, 1, gl.FLOAT, false, 0, 0);
      } else {gl.disableVertexAttribArray(p.y); gl.vertexAttrib1f(p.y, 0);}
    }
    gl.activeTexture(active);
    return () => {
      if (p.y >= 0) gl.disableVertexAttribArray(p.y);
      gl.bindBuffer(gl.ARRAY_BUFFER, arrayBuffer);
      for (let j = 0; j < 6; j++) {gl.activeTexture(gl.TEXTURE0 + 2 + j); gl.bindTexture(gl.TEXTURE_2D, savedTextures[j]);}
      gl.activeTexture(active);
      // Delete superseded custom LUTs; retain only the two live ramps + presets.
      for (const [lut, tex] of cache.textures) if (!pair.includes(lut) && ![...luts.values(),...bow.frame(now).retained,...eyes.retained()].includes(lut)) {gl.deleteTexture(tex); cache.textures.delete(lut);}
    };
  }
  const method = renderer.drawMeshWebGL ? 'drawMeshWebGL' : 'drawMesh';
  const native = renderer[method];
  if (typeof native !== 'function') throw Error('Hair: unsupported Cubism renderer');
  renderer[method] = function (...args) {
    const gl = this.gl, shaderSource = gl.shaderSource, drawElements = gl.drawElements;
    const index = method === 'drawMeshWebGL' ? args[1] : vertexIndex.get(args[4]);
    const mask = this.getClippingContextBufferForMask() != null;
    // Only scoped to this renderer's synchronous draw. No global WebGL prototype patch.
    gl.shaderSource = function (shader, source) {return shaderSource.call(this, shader, patchShader(source, gl.getShaderParameter(shader, gl.SHADER_TYPE) === gl.VERTEX_SHADER));};
    if (!mask) gl.drawElements = function (...drawArgs) {
      if (index === undefined) throw Error('Hair: unknown drawable vertex buffer');
      const restore = bind(gl, index); try {return drawElements.apply(this, drawArgs);} finally {restore();}
    };
    try {return native.apply(this, args);} finally {gl.shaderSource = shaderSource; gl.drawElements = drawElements;}
  };
  const surface = canvas();
  surface?.addEventListener('webglcontextrestored', () => {glCache = null;});
  const releaseMethod = typeof renderer.release === 'function' ? 'release' : null;
  if (releaseMethod) {
    const release = renderer.release;
    renderer.release = function (...args) {
      if (glCache) {for (const t of [...glCache.textures.values(), ...glCache.maskTextures.values()]) glCache.gl.deleteTexture(t); for (const b of glCache.buffers.values()) glCache.gl.deleteBuffer(b); glCache = null;}
      return release.apply(this, args);
    };
  }
  attached.set(renderer, api);
  const qa = Object.freeze({get drawables() {return Object.freeze([...probe.indices, ...probe.headband]);}, get headbandTexels() {return probe.headbandTexels;}, get tailDrawable() {return probe.tailDrawable;}, get palette() {return api.palette;}, set: name => api.set(name), snapshot: api.snapshot});
  Object.defineProperty(window, 'hairQA', {configurable: true, value: qa});
  Object.defineProperty(window, 'bowQA', {configurable:true,value:Object.freeze({get palette(){return bow.palette;},get neck(){return bow.neck;},get drawables(){return Object.freeze([...bowIDs]);},set:(name,hex)=>bow.set(name,hex),setNeck:v=>bow.setNeck(v),snapshot:api.snapshot})});
  Object.defineProperty(window,'eyeQA',{configurable:true,value:eyes});
  return api;
}

export function mountHair(host, api, data) {
  const row = document.createElement('div'); row.className = 'hair-controls';
  row.style.cssText = 'display:flex;align-items:center;flex-wrap:wrap;gap:10px;padding:12px 0';
  const title = document.createElement('span'); title.textContent = '发色'; row.append(title);
  const buttons = new Map();
  const refresh = () => {for (const [name, b] of buttons) {const on = api.palette === name; b.setAttribute('aria-pressed', String(on)); b.style.outline = on ? '2px solid #667bea' : 'none';}};
  for (const name of ['deepseek', ...data.order.filter(n => n !== 'deepseek')]) {
    const spec = data.palettes[name], b = document.createElement('button'); b.type = 'button'; b.title = spec.label;
    b.dataset.hair = name; b.setAttribute('aria-label', spec.label);
    b.style.cssText = 'width:28px;height:28px;min-width:28px;padding:0;border-radius:50%;border:1px solid #b9becb;outline-offset:3px;cursor:pointer';
    b.style.background = spec.chip === 'rainbow' ? `conic-gradient(${[...spec.y_stops.map(([,c])=>`rgb(${c.join(',')})`),`rgb(${spec.y_stops[0][1].join(',')})`].join(',')})` : `rgb(${spec.chip.join(',')})`;
    b.onclick = () => api.set(name); buttons.set(name, b); row.append(b);
  }
  const label = document.createElement('label'), input = document.createElement('input');
  label.textContent = '自定义 '; input.type = 'color'; input.value = api.custom; input.setAttribute('aria-label', '自定义发色'); input.style.cssText = 'width:32px;height:28px;vertical-align:middle';
  input.oninput = () => api.set('custom', input.value); buttons.set('custom', input); label.append(input); row.append(label);
  api.onChange(refresh); refresh(); host.append(row);
  if(api.follow)mountAccessoryFollow(row,api.follow);
  mountEyes(host,api.eyes,data);mountBow(host,api.bow,data); return row;
}
