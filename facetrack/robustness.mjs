// Acquisition-clock guards. FaceLandmarker does not expose per-face presence
// scores in its public result; these are geometric reliability heuristics.
const median=a=>[...a].sort((a,b)=>a-b)[Math.floor(a.length/2)];
export function faceGeometry(points,aspect=1){
  const d=(a,b)=>{const p=points?.[a],q=points?.[b];return p&&q?Math.hypot((p.x-q.x)*aspect,p.y-q.y):NaN;};
  const width=d(33,263),mouth=d(61,291);
  return {left:d(386,374)/d(362,263),right:d(159,145)/d(33,133),
    chin:d(1,152)/width,width:mouth/width,aperture:d(13,14)/mouth,
    asymmetry:(d(1,61)-d(1,291))/width};
}
export class FaceReliabilityGuard{
  constructor(){this.reset();}
  reset(){this.previous=null;this.reference=null;this.trustedMouth=null;this.time=null;this.badUntil=-Infinity;this.wink={Left:0,Right:0};this.stats={unreliable:0,winkSuppressed:0};}
  step(mapped,result,time,aspect=1){
    if(!mapped){this.reset();return null;}
    if(this.time!==null&&(time<=this.time||time-this.time>.15))this.reset();
    const dt=this.time===null?1/30:time-this.time;this.time=time;
    const g=faceGeometry(result.faceLandmarks[0],aspect),p=this.previous,s=mapped.shapes;
    this.reference??={...g};
    const finite=Object.values(g).every(Number.isFinite);
    const jump=p?Math.max(Math.abs(g.chin-p.chin)/.10,Math.abs(g.width-p.width)/.12,Math.abs(g.asymmetry-p.asymmetry)/.10):0;
    // A nod alone foreshortens the chin: require independent mouth collapse.
    const compressed=g.chin<this.reference.chin*.82&&g.width<this.reference.width*.86;
    const disagreement=(s.mouthSmileLeft+s.mouthSmileRight)<.10&&Math.max(s.eyeSquintLeft,s.eyeSquintRight)>.35&&compressed;
    if(!finite||jump>1||disagreement)this.badUntil=time+.10;
    const unreliable=!finite||compressed||time<this.badUntil;
    const weight=unreliable?.18:1,values={...mapped.values};
    if(unreliable)this.stats.unreliable++;
    else for(const k of ['chin','width','asymmetry'])this.reference[k]+=(1-Math.exp(-dt/(k==='chin'&&g[k]>this.reference[k]?.15:2)))*(g[k]-this.reference[k]);
    // Hold the last reliable mouth. Recovery is deliberately gradual; neither
    // hidden teeth nor a collapsing chin can instantly replace the smile.
    const mouths=Object.keys(values).filter(k=>k.startsWith('ParamMouth'));
    this.trustedMouth??=Object.fromEntries(mouths.map(k=>[k,values[k]]));
    for(const k of mouths){
      if(!unreliable)this.trustedMouth[k]+=(1-Math.exp(-dt/.045))*(values[k]-this.trustedMouth[k]);
      values[k]=this.trustedMouth[k];
    }
    // Bilateral blinks bypass temporal confirmation, including one-frame blinks.
    // A unilateral closure requires an actually narrow lid, an open opposite
    // eye, matching detector evidence, and 2 (unreliable: 3) consecutive frames.
    const closures={Left:1-values.ParamEyeROpen,Right:1-values.ParamEyeLOpen};
    const bilateral=s.eyeBlinkLeft>.25&&s.eyeBlinkRight>.25&&g.left<.22&&g.right<.22;
    for(const side of ['Left','Right']){
      const other=side==='Left'?'Right':'Left',lid=g[side.toLowerCase()],opposite=g[other.toLowerCase()];
      const unilateral=closures[side]>.25&&closures[side]-closures[other]>.20;
      const evidence=lid<.20&&opposite>.22&&opposite-lid>.06&&
        (s['eyeBlink'+side]>.18||(s['eyeSquint'+side]>.25&&s['eyeSquint'+side]-s['eyeSquint'+other]>.08));
      this.wink[side]=!bilateral&&unilateral&&evidence?this.wink[side]+1:0;
      if(!bilateral&&unilateral&&this.wink[side]<(unreliable?3:2)){
        values[side==='Left'?'ParamEyeROpen':'ParamEyeLOpen']=1-closures[other];this.stats.winkSuppressed++;
      }
    }
    // This model's smile-eye parameter selects a CLOSED drawing even when
    // Open=1. Unconfirmed asymmetry must not bypass the wink guard through
    // that drawing. Shared minimum preserves bilateral smile hysteresis.
    const confirmed=Object.values(this.wink).some(n=>n>=(unreliable?3:2));
    if(!confirmed){
      const smile=Math.min(values.ParamEyeLSmile,values.ParamEyeRSmile);
      values.ParamEyeLSmile=values.ParamEyeRSmile=smile;
    }
    this.previous=g;
    return {...mapped,values,reliability:{weight,unreliable,geometry:g,jump,compressed,disagreement,bilateral,wink:{...this.wink}}};
  }
}

// Three-sample causal median: rejects an isolated impulse with <=1 source frame
// of delay. Eyelids are intentionally excluded by the caller.
export class Median3{
  constructor(){this.history=new Map();}
  reset(){this.history.clear();}
  step(key,value,trend=false){
    const h=this.history.get(key)??[value,value];h.push(value);if(h.length>3)h.shift();this.history.set(key,h);
    const middle=median(h),a=h[1]-h[0],b=h[2]-h[1];
    // Two coherent increments confirm a sustained turn. Recover most of the
    // one-frame median delay without predicting beyond the newest measurement.
    // A spike from rest, and its reversal, never take this path.
    const coherent=a*b>0&&Math.abs(b)<=2*Math.abs(a)&&Math.abs(a)<=2*Math.abs(b);
    return trend&&coherent?middle+.65*(value-middle):middle;
  }
}
