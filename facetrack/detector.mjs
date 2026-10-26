// One running inference + one replaceable latest bitmap, never a FIFO.
export class DetectorBridge {
  constructor({requested = 'worker', cpu = false, width = 640, onResult, onStatus, onWork}) {
    Object.assign(this, {requested, cpu, width, onResult, onStatus, onWork});
    this.backend = null; this.delegate = null; this.generation = 0; this.sequence = 0;
    this.pending = null; this.inflight = null; this.capturing = false; this.closed = false;
    this.dropped = 0; this.slow = 0; this.mode = 'VIDEO'; this.lastTimestamp = -1;
  }
  status() { return {backend: this.backend, delegate: this.delegate, fallback: this.fallback || null,
    inputWidth: this.inputWidth || 0, inputHeight: this.inputHeight || 0, dropped: this.dropped,
    pending: Number(!!this.pending), inflight: Number(!!this.inflight), adaptiveWidth: this.width}; }
  announce() { this.onStatus?.(this.status()); }
  async init() {
    if (this.requested !== 'main') {
      try {
        if (typeof Worker === 'undefined' || typeof createImageBitmap === 'undefined' || typeof OffscreenCanvas === 'undefined')
          throw new Error('浏览器缺少 Worker / ImageBitmap / OffscreenCanvas');
        await new Promise((resolve, reject) => {
          // No type:module: the local WASM loader needs importScripts.
          this.worker = new Worker(new URL('./detector-worker.js', import.meta.url));
          const timer = setTimeout(() => reject(new Error('Worker 初始化超时')), 20000);
          this.worker.onerror = e => { clearTimeout(timer); reject(new Error(e.message)); };
          this.worker.onmessageerror = () => { clearTimeout(timer); reject(new Error('Worker 初始化消息无法解码')); };
          this.worker.onmessage = ({data}) => {
            clearTimeout(timer);
            if (data.type !== 'ready') return reject(new Error(data.message || 'Worker 初始化失败'));
            this.backend = 'worker'; this.delegate = data.delegate;
            this.worker.onmessage = e => this.receive(e.data);
            this.worker.onerror = e => { void this.fallbackMain(e.message); };
            this.worker.onmessageerror = () => { void this.fallbackMain('Worker 消息无法解码'); };
            resolve();
          };
          this.worker.postMessage({type:'init',cpu:this.cpu});
        });
        this.announce(); return this;
      } catch (error) { await this.fallbackMain(String(error)); if(this.backend==='failed')throw new Error(this.fallback); return this; }
    }
    await this.initMain(); return this;
  }
  async initMain(forceCPU = this.cpu) {
    const {FaceLandmarker, FilesetResolver} = await import('./vendor/mediapipe/vision_bundle.mjs');
    const files = await FilesetResolver.forVisionTasks(new URL('./vendor/mediapipe/wasm', import.meta.url).href);
    const make = delegate => FaceLandmarker.createFromOptions(files, {
      baseOptions: {modelAssetPath: new URL('./vendor/mediapipe/face_landmarker.task', import.meta.url).href, delegate},
      runningMode: this.mode, numFaces: 1, outputFaceBlendshapes: true, outputFacialTransformationMatrixes: true,
      minFaceDetectionConfidence: .5, minFacePresenceConfidence: .5, minTrackingConfidence: .5,
    });
    this.detector?.close(); this.detector = null;
    if (!forceCPU) { try { this.detector = await make('GPU'); this.delegate = 'GPU'; } catch {} }
    if (!this.detector) { this.detector = await make('CPU'); this.delegate = 'CPU'; }
    if (this.closed) { this.detector.close(); return; }
    this.backend = 'main'; this.announce();
  }
  async fallbackMain(reason) {
    if (this.closed || this.fallingBack) return;
    this.fallingBack = true; this.fallback = reason; this.backend = 'loading';
    clearTimeout(this.watchdog); this.worker?.terminate(); this.worker = null;
    this.reset(); this.inflight = null; this.announce();
    try { await this.initMain(); }
    catch (error) { this.backend = 'failed'; this.fallback += '; ' + error; this.announce(); }
    finally { this.fallingBack = false; }
  }
  reset() {
    this.generation++; this.pending?.bitmap.close(); this.pending = null;
    // Transferred in-flight bitmap belongs to worker, which always closes it.
  }
  async submit(source, metadata) {
    if (this.closed || !['worker', 'main'].includes(this.backend)) return;
    const generation = this.generation;
    const meta = {...metadata, generation, id: ++this.sequence};
    if (this.backend === 'main') {
      if (this.inflight) { this.dropped++; return; }
      this.inflight = meta;
      try {
        const nextMode = meta.imageMode ? 'IMAGE' : 'VIDEO';
        if (nextMode !== this.mode) { await this.detector.setOptions({runningMode: nextMode}); this.mode = nextMode; }
        if (generation !== this.generation) return;
        this.inputWidth = source.videoWidth || source.naturalWidth; this.inputHeight = source.videoHeight || source.naturalHeight;
        const timestamp = Math.max(meta.capturedAt, this.lastTimestamp + .001); this.lastTimestamp = timestamp;
        const started = performance.now();
        const result = meta.imageMode ? this.detector.detect(source) : this.detector.detectForVideo(source, timestamp);
        const duration = performance.now() - started; this.onWork?.('mainDetection', duration);
        if (generation === this.generation) this.onResult({...meta, result, duration, delegate: this.delegate,
          width: this.inputWidth, height: this.inputHeight, backend: 'main'});
      } catch (error) {
        if (this.delegate === 'GPU') {
          try { await this.initMain(true); } catch (e) { this.backend = 'failed'; this.fallback = String(e); this.announce(); }
        } else { this.backend = 'failed'; this.fallback = String(error); this.announce(); }
      } finally { this.inflight = null; }
      return;
    }
    if (this.capturing) { this.dropped++; return; }
    this.capturing = true;
    try {
      const sw = source.videoWidth || source.naturalWidth, sh = source.videoHeight || source.naturalHeight;
      const width = Math.min(sw, this.width), height = Math.max(1, Math.round(sh * width / sw));
      const started = performance.now();
      const promise = createImageBitmap(source, {resizeWidth: width, resizeHeight: height, resizeQuality: 'low'});
      this.onWork?.('bitmapSubmit', performance.now() - started);
      const bitmap = await promise;
      if (generation !== this.generation || this.closed || this.backend !== 'worker') { bitmap.close(); return; }
      if (this.pending) { this.pending.bitmap.close(); this.dropped++; }
      this.pending = {...meta, bitmap, width, height}; this.pump();
    } catch (error) { await this.fallbackMain('帧传输失败：' + error); }
    finally { this.capturing = false; }
  }
  pump() {
    if (this.inflight || !this.pending || !this.worker) return;
    const frame = this.pending; this.pending = null; this.inflight = frame;
    this.inputWidth = frame.width; this.inputHeight = frame.height;
    try {
      this.worker.postMessage({...frame, type: 'frame'}, [frame.bitmap]);
      this.watchdog = setTimeout(() => { void this.fallbackMain('Worker 识别超时'); }, 5000);
    } catch (error) { frame.bitmap.close(); void this.fallbackMain(String(error)); }
  }
  receive(data) {
    if (data.id !== this.inflight?.id) return;
    clearTimeout(this.watchdog); this.inflight = null;
    if (data.type === 'error') { void this.fallbackMain(data.message); return; }
    if (data.generation === this.generation) {
      this.delegate = data.delegate;
      // Start at 640; sustained >30ms inference selects 480, without changing preview.
      this.slow = data.duration > 30 ? this.slow + 1 : Math.max(0, this.slow - 1);
      if (this.slow >= 20) this.width = 480;
      this.onResult({...data, backend: 'worker'});
    }
    this.pump();
  }
  close() {
    this.closed = true; this.reset(); clearTimeout(this.watchdog);
    this.worker?.terminate(); this.detector?.close();
  }
}
