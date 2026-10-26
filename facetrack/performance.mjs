export const percentile = (sorted, p) => sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] : 0;
export class PerformanceWindow {
  constructor() { this.frames = []; this.detections = []; this.work = []; this.lastFrame = null; }
  frame(now) {
    if (this.lastFrame !== null) this.frames.push({time: now, duration: now - this.lastFrame});
    this.lastFrame = now;
  }
  detection(data, now) { const row={time: now, duration: data.duration, capturedAt: data.capturedAt,
    latency: now - data.capturedAt, width: data.width, height: data.height, backend:data.backend, delegate:data.delegate};
    this.detections.push(row);this.recording?.detections.push(row); }
  sync(name, duration, time = performance.now()) { const row={time, name, duration};this.work.push(row);this.recording?.work.push(row); }
  begin(now=performance.now()){this.recording={started:now,detections:[],work:[]};}
  end(now=performance.now()){const result=this.recording;this.recording=null;return {...result,ended:now};}
  snapshot(now) {
    const cutoff = now - 10000;
    this.frames = this.frames.filter(x => x.time >= cutoff);
    this.detections = this.detections.filter(x => x.time >= cutoff);
    this.work = this.work.filter(x => x.time >= cutoff);
    const intervals = this.frames.map(x => x.duration).sort((a,b) => a-b);
    const d = this.detections, timings = d.map(x => x.duration).sort((a,b) => a-b);
    const span = this.frames.reduce((sum,x) => sum + x.duration, 0);
    const last = d.at(-1);
    return {windowSeconds: 10, renderFPS: span ? intervals.length * 1000 / span : 0,
      intervalP50: percentile(intervals,.5), intervalP95: percentile(intervals,.95), intervalMax: intervals.at(-1) || 0,
      over25ms: intervals.filter(x => x > 25).length, over40ms: intervals.filter(x => x > 40).length,
      detectionMs: last?.duration || 0, detectionP95: percentile(timings,.95),
      detectionFPS: d.length > 1 ? (d.length-1)*1000/(last.time-d[0].time) : 0,
      inputWidth: last?.width || 0, inputHeight: last?.height || 0, latencyMs: last?.latency || 0,
      syncMax: Math.max(0,...this.work.map(x => x.duration)), syncOver8ms: this.work.filter(x => x.duration > 8).length};
  }
}
