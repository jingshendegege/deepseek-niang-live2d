import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {matrixToEuler,mapFace,ParameterSmoother,DEFAULTS} from '../mapping.mjs';
const dir=path.dirname(fileURLToPath(import.meta.url)),root=path.resolve(dir,'..'),exportRoot=process.env.FACETRACK_MODEL_DIR||path.resolve(root,'../export/DeepSeekNiang_v4');
const settings=JSON.parse(fs.readFileSync(path.join(exportRoot,'DeepSeekNiang.model3.json'),'utf8'));
const refs=settings.FileReferences;
function rotation(yaw=0,pitch=0,roll=0){
 const y=yaw*Math.PI/180,p=pitch*Math.PI/180,r=roll*Math.PI/180,cy=Math.cos(y),sy=Math.sin(y),cp=Math.cos(p),sp=Math.sin(p),cr=Math.cos(r),sr=Math.sin(r);
 return {data:[cr*cy,sr*cy,-sy,0,cr*sy*sp-sr*cp,sr*sy*sp+cr*cp,cy*sp,0,cr*sy*cp+sr*sp,sr*sy*cp-cr*sp,cy*cp,0,0,0,0,1]};
}
assert(Object.values(matrixToEuler(rotation())).every(v=>v===0));
// qa_turn now measures the projected upright axis. With this Euler fixture its
// screen lean includes yaw/pitch coupling, rather than returning Euler roll.
const projectedRoll=-6-Math.atan(Math.sin(12*Math.PI/180)*Math.tan(9*Math.PI/180))*180/Math.PI;
for(const axis of ['x','y','z'])assert(Math.abs(matrixToEuler(rotation(12,9,-6))[axis]-({x:-12,y:-9,z:projectedRoll}[axis]))<1e-8);
const result=(shapes={},matrix=rotation())=>({faceLandmarks:[[{x:.5,y:.5}]],facialTransformationMatrixes:[matrix],faceBlendshapes:[{categories:Object.entries(shapes).map(([categoryName,score])=>({categoryName,score}))}]});
assert.equal(mapFace(result({eyeBlinkRight:1})).values.ParamEyeLOpen,0);
assert.equal(mapFace(result({eyeBlinkRight:1})).values.ParamEyeROpen,1);
assert(mapFace(result({jawOpen:.2})).values.ParamMouthOpenY>.3);
assert(mapFace(result({mouthPucker:1})).values.ParamMouthForm<-.9);
assert.equal(mapFace(result({cheekSquintRight:1})).values.ParamEyeLSmile,1);
const calibrated=mapFace(result({},rotation(12,9,-6)),{x:-12,y:-9,z:projectedRoll});
for(const id of ['ParamAngleX','ParamAngleY','ParamAngleZ'])assert(Math.abs(calibrated.values[id])<1e-8);
// Current OneEuro front-end needs consecutive acquisition samples on startup;
// assess closing at four input frames (133 ms), not the first raw sample.
const smooth=new ParameterSmoother();for(let i=0;i<4;i++)smooth.step({...DEFAULTS,ParamAngleX:30,ParamBodyAngleX:9,ParamEyeLOpen:0},1/30,true);
assert(smooth.values.ParamEyeLOpen<.2);assert(smooth.values.ParamAngleX/30>smooth.values.ParamBodyAngleX/9);
for(let i=0;i<150;i++)smooth.step(DEFAULTS,1/30,false);
assert(Math.abs(smooth.values.ParamAngleX)<.01);
console.log('PASS mapping: axes, blink, mouth, calibration, smoothing and return');
