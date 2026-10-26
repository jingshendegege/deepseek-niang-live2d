// Independent palette state; renderer binding lives beside hair in hair-color.mjs.
export function createBowChannel({data, buildLUT, customPalette, sfx, storageKey}) {
  const specs = {...data.bows}, luts = new Map(), listeners = new Set();
  let current = 'original', custom = '#0099f4', neck = false, started = -Infinity, pending;
  const resolve = name => luts.get(name) || (luts.set(name, buildLUT(specs[name])), luts.get(name));
  const notify = () => listeners.forEach(fn => fn());
  const save = () => {try {localStorage.setItem(storageKey, JSON.stringify({name:pending?.name || current, custom:pending?.hex || custom, neck}));} catch {}};
  try {
    const value = JSON.parse(localStorage.getItem(storageKey));
    if (value?.name === 'custom') {specs.custom = customPalette(value.custom); custom = value.custom;}
    if (specs[value?.name]) current = value.name;
    neck = value?.neck === true;
  } catch {}
  let oldRamp = resolve(current), newRamp = oldRamp;
  const begin = (name, hex, now) => {
    oldRamp = newRamp; current = name;
    if (name === 'custom') {custom = hex || custom; specs.custom = customPalette(custom); luts.delete('custom');}
    newRamp = resolve(name); started = now; notify();
    sfx?.playSfx(sfx.map?.bow || 'clip_snap');
  };
  const advance = now => {if (pending && now - started >= 300) {const p = pending; pending = null; begin(p.name, p.hex, now);}};
  return {
    get palette() {return pending?.name || current;}, get custom() {return custom;},
    get neck() {return neck;}, setNeck(value) {neck = !!value; save(); notify();},
    set(name, hex) {
      if (name !== 'custom' && !specs[name]) throw Error('Unknown bow palette: ' + name);
      if (name === 'custom') customPalette(hex || custom);
      const now = performance.now(); advance(now);
      if (name === current && name !== 'custom' && !pending) return;
      if (now - started < 300) pending = {name, hex}; else begin(name, hex, now);
      save(); notify();
    },
    onChange(fn) {listeners.add(fn);},
    frame(now) {advance(now); return {pair:[oldRamp,newRamp], progress:Math.min(1,Math.max(0,(now-started)/300)), retained:[...luts.values(),oldRamp,newRamp]};},
  };
}

export function mountBow(host, api, data) {
  const row = document.createElement('div'); row.className = 'bow-controls';
  row.style.cssText = 'display:flex;align-items:center;flex-wrap:wrap;gap:10px;padding:12px 0;max-width:620px';
  const title = document.createElement('span'); title.textContent = '蝴蝶结'; row.append(title);
  const buttons = new Map();
  for (const name of data.bow_order || Object.keys(data.bows)) {
    const spec = data.bows[name], b = document.createElement('button'); b.type = 'button'; b.title = spec.label;
    b.dataset.bow = name; b.setAttribute('aria-label', '蝴蝶结 · ' + spec.label);
    b.style.cssText = 'width:28px;height:28px;min-width:28px;padding:0;border-radius:50%;border:1px solid #b9becb;outline-offset:3px;cursor:pointer';
    b.style.background = `rgb(${spec.chip.join(',')})`; b.onclick = () => api.set(name);
    buttons.set(name,b); row.append(b);
  }
  const label = document.createElement('label'), input = document.createElement('input');
  label.textContent = '自定义 '; input.type = 'color'; input.value = api.custom;
  input.setAttribute('aria-label','自定义蝴蝶结颜色'); input.oninput = () => api.set('custom',input.value);
  buttons.set('custom',input); label.append(input); row.append(label);
  const checkLabel = document.createElement('label'), check = document.createElement('input');
  check.type = 'checkbox'; check.checked = api.neck; check.onchange = () => api.setNeck(check.checked);
  checkLabel.append(check,document.createTextNode('领结也一起换')); row.append(checkLabel);
  const refresh = () => {for (const [n,b] of buttons) {b.setAttribute('aria-pressed',String(api.palette===n));b.style.outline=api.palette===n?'2px solid #667bea':'none';} check.checked=api.neck;};
  api.onChange(refresh); refresh(); host.append(row); return row;
}
