import assert from 'node:assert/strict';
import fs from 'node:fs';
import {DEFAULTS,ParameterSmoother} from '../mapping.mjs';
const rows=[];
for(const fps of [25,30,60,120]){
 const s=new ParameterSmoother();
 // v5 uses bilateral smile evidence and gives a deliberate wink priority.
 // The 2026-10-22 fixture fed a closed left lid and expected smile to override it;
 // that assertion is incompatible with the later wink fix, not an eye-colour regression.
 const step=(v,tracked=true)=>({...s.step({...DEFAULTS,ParamEyeLSmile:v,ParamEyeRSmile:v},1/fps,tracked)});
 assert.equal(step(.6).ParamEyeLSmile,0);
 let n=Math.ceil(.2*fps),v;
 for(let i=0;i<n;i++)v=step(.61);
 assert(v.ParamEyeLSmile>.98);assert.equal(v.ParamEyeLOpen,1);
 for(let i=0;i<80;i++){v=step(i%2?.36:.59);assert(v.ParamEyeLSmile>.98);assert.equal(v.ParamEyeLOpen,1);assert(v.ParamEyeRSmile>.98);}
 assert(step(.35).ParamEyeLSmile>.98);
 for(let i=0;i<n;i++)v=step(.34);
 assert(v.ParamEyeLSmile<.02);
 for(let i=0;i<n;i++)v=step(.9);
 for(let i=0;i<Math.ceil(.8*fps);i++)v=step(.9,false);
 assert(v.ParamEyeLSmile<.02);
 const wink=new ParameterSmoother();
 for(let i=0;i<n;i++)v=wink.step({...DEFAULTS,ParamEyeLSmile:.9,ParamEyeRSmile:.9,ParamEyeLOpen:0},1/fps,true);
 assert(v.ParamEyeLSmile<.02);assert(v.ParamEyeLOpen<.1);
 rows.push({fps,settlingBoundMs:n/fps*1000,hysteresis:true,bilateralSmile:true,winkPriority:true,trackingLossExit:true});
}
fs.writeFileSync(new URL('../../renders/qa/'+(process.env.COLOR_QA||'eyes')+'/mapping_test.json',import.meta.url),JSON.stringify(rows,null,2));console.log(rows);
