// Iris LUT state. Rendered through the per-drawable auxiliary channel (units 5/6/7).
const clamp=(x,a,b)=>Math.min(b,Math.max(a,x));
export function irisPalette(hex,brightness=1){
  if(!/^#[0-9a-f]{6}$/i.test(hex)||!Number.isFinite(brightness)||brightness<.4||brightness>1.6)throw Error('Invalid eye colour');
  const c=[1,3,5].map(i=>clamp(parseInt(hex.slice(i,i+2),16)*brightness,0,255));
  return {mode:'lum',chip:c,stops:[[0,c.map(v=>v*.045)],[.16,c.map(v=>v*.16)],[.45,c.map(v=>v*.62)],[.72,c],[1,c.map(v=>v*.24+255*.76)]]};
}
export function createEyeChannel({data,buildLUT,storageKey='deepseek-eyes'}){
  const presets=data.eyes||{deepseek:{original:true}},listeners=new Set();
  let follow=true,split=false,hairName='deepseek',hairHex='#4d6bfe';
  const initial=()=>({name:'deepseek',hex:'#4d6bfe',brightness:1});
  let values={L:initial(),R:initial()};
  try{
    const v=JSON.parse(localStorage.getItem(storageKey));
    if(v){
      const checked={};
      for(const s of ['L','R']){
        const x=v.values?.[s];if(!x||(!Object.hasOwn(presets,x.name)&&x.name!=='custom'))throw Error('invalid saved eye state');
        irisPalette(x.hex,x.brightness);if(x.brightness<.4||x.brightness>1.6)throw Error('invalid brightness');checked[s]={...x};
      }
      values=checked;follow=v.follow!==false;split=v.split===true;
    }
  }catch{}
  const lut=v=>buildLUT(v.name==='custom'?irisPalette(v.hex,v.brightness):presets[v.name]);
  const tracks=Object.fromEntries(['L','R'].map(s=>{const ramp=lut(values[s]);return [s,{old:ramp,next:ramp,start:-Infinity,pending:null}];}));
  const notify=()=>listeners.forEach(fn=>fn());
  const save=()=>{try{localStorage.setItem(storageKey,JSON.stringify({follow,split,values}));}catch{}notify();};
  function begin(s,v,now){const t=tracks[s];t.old=t.next;t.next=lut(v);t.start=now;}
  // Use the scheduled boundary, not the next visible iris draw. A queue that
  // finishes during a long blink/smile must already be at its new colour on reopen.
  function advance(s,now){const t=tracks[s];if(t.pending&&now-t.start>=360){const v=t.pending,at=t.start+360;t.pending=null;begin(s,v,at);}}
  function change(s,v){
    const now=performance.now();advance(s,now);
    if(JSON.stringify(values[s])===JSON.stringify(v))return;
    values[s]={...v};const t=tracks[s];if(now-t.start<360)t.pending={...v};else begin(s,v,now);
  }
  function followHair(){if(!follow)return;const v={name:Object.hasOwn(presets,hairName)?hairName:'custom',hex:hairHex,brightness:1};for(const s of ['L','R'])change(s,v);save();}
  const api={
    get follow(){return follow;},get split(){return split;},get values(){return structuredClone(values);},
    hair(name,hex){hairName=name;hairHex=hex||hairHex;followHair();},
    setFollow(v){follow=!!v;if(follow){split=false;followHair();}save();},
    setSplit(v){split=!!v;if(split)follow=false;else change('R',values.L);save();},
    set(name,hex,side='L',brightness=1){
      if(!['L','R'].includes(side)||(!Object.hasOwn(presets,name)&&name!=='custom'))throw Error('Unknown eye palette');
      const v={name,hex:name==='custom'?(hex||values[side].hex):'#'+(presets[name].chip||[77,107,254]).map(c=>Math.round(c).toString(16).padStart(2,'0')).join(''),brightness:name==='custom'?brightness:1};irisPalette(v.hex,v.brightness);
      follow=false;change(side,v);if(!split)change(side==='L'?'R':'L',v);save();
    },
    reset(){follow=false;split=false;for(const s of ['L','R'])change(s,initial());save();},
    onChange(fn){listeners.add(fn);},
    tick(now){for(const s of ['L','R'])advance(s,now);},
    frame(side,now){advance(side,now);const t=tracks[side];return {pair:[t.old,t.next],progress:clamp((now-t.start)/360,0,1)};},
    retained(){return Object.values(tracks).flatMap(t=>[t.old,t.next]);},
  };
  return api;
}

export function mountEyes(host,api,data){
  const row=document.createElement('div');row.className='eye-controls';
  row.style.cssText='display:flex;align-items:center;flex-wrap:wrap;gap:10px;padding:12px 0;max-width:680px';
  const title=document.createElement('strong');title.textContent='眼睛';row.append(title);
  const checkbox=(text,fn)=>{const l=document.createElement('label'),c=document.createElement('input');c.type='checkbox';c.onchange=()=>fn(c.checked);l.append(c,document.createTextNode(text));row.append(l);return c;};
  const follow=checkbox('跟随发色',v=>api.setFollow(v)),split=checkbox('左右眼分别设置',v=>api.setSplit(v));
  const side=document.createElement('select');side.setAttribute('aria-label','选择左眼或右眼');
  for(const [s,t]of [['L','角色左眼（画面右）'],['R','角色右眼（画面左）']]){const o=document.createElement('option');o.value=s;o.textContent=t;side.append(o);}row.append(side);
  const select=document.createElement('select');select.setAttribute('aria-label','眼色预设');
  for(const n of data.eye_order||Object.keys(data.eyes||{})){const o=document.createElement('option');o.value=n;o.textContent=data.eyes[n].label;select.append(o);}
  const custom=document.createElement('option');custom.value='custom';custom.textContent='自定义';select.append(custom);row.append(select);
  const color=document.createElement('input');color.type='color';color.setAttribute('aria-label','自定义眼睛颜色');row.append(color);
  const label=document.createElement('label');label.textContent='明暗 ';const light=document.createElement('input');light.type='range';light.min='.4';light.max='1.6';light.step='.01';light.setAttribute('aria-label','眼睛明暗');label.append(light);row.append(label);
  const setCustom=()=>api.set('custom',color.value,side.value,Number(light.value));color.oninput=light.oninput=setCustom;
  select.onchange=()=>api.set(select.value,color.value,side.value,Number(light.value));
  const reset=document.createElement('button');reset.textContent='恢复默认';reset.type='button';reset.onclick=()=>api.reset();row.append(reset);
  const refresh=()=>{follow.checked=api.follow;split.checked=api.split;side.hidden=!api.split;if(!api.split)side.value='L';const v=api.values[side.value];select.value=v.name;color.value=v.name==='custom'?v.hex:'#'+(data.eyes?.[v.name]?.chip||[77,107,254]).map(x=>Math.round(x).toString(16).padStart(2,'0')).join('');light.value=v.brightness;};
  side.onchange=refresh;api.onChange(refresh);refresh();host.append(row);return row;
}
