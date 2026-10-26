// Classic worker deliberately: tasks-vision 0.10.21 loads WASM via importScripts.
// Its ESM bundle can be dynamically imported inside a classic worker.
let detector, files, FaceLandmarker, delegate, mode = 'VIDEO', lastTimestamp = -1;
const asset = path => new URL(path, self.location.href).href;
async function create(cpu = false) {
  detector?.close();
  detector = null;
  const make = d => FaceLandmarker.createFromOptions(files, {
    baseOptions: {modelAssetPath: asset('./vendor/mediapipe/face_landmarker.task'), delegate: d},
    canvas: new OffscreenCanvas(1, 1), runningMode: mode, numFaces: 1,
    outputFaceBlendshapes: true, outputFacialTransformationMatrixes: true,
    minFaceDetectionConfidence: .5, minFacePresenceConfidence: .5, minTrackingConfidence: .5,
  });
  if (!cpu) {
    try { detector = await make('GPU'); delegate = 'GPU'; return; }
    catch { /* WebGL unavailable in worker: keep recognition off the main thread. */ }
  }
  detector = await make('CPU'); delegate = 'CPU';
}
self.onmessage = async ({data}) => {
  if (data.type === 'init') {
    try {
      const vision = await import('./vendor/mediapipe/vision_bundle.mjs');
      FaceLandmarker = vision.FaceLandmarker;
      files = await vision.FilesetResolver.forVisionTasks(asset('./vendor/mediapipe/wasm'));
      await create(data.cpu);
      self.postMessage({type: 'ready', delegate});
    } catch (error) { self.postMessage({type: 'error', message: String(error)}); }
    return;
  }
  if (data.type !== 'frame') return;
  const {bitmap, ...meta} = data;
  try {
    const nextMode = data.imageMode ? 'IMAGE' : 'VIDEO';
    if (nextMode !== mode) { await detector.setOptions({runningMode: nextMode}); mode = nextMode; }
    // Acquisition timestamps are monotonic even when a file loops/seeks.
    const timestamp = Math.max(data.capturedAt, lastTimestamp + .001);
    lastTimestamp = timestamp;
    const run = () => data.imageMode ? detector.detect(bitmap) : detector.detectForVideo(bitmap, timestamp);
    let result, started = performance.now();
    try { result = run(); }
    catch (error) {
      if (delegate !== 'GPU') throw error;
      await create(true); started = performance.now(); result = run();
    }
    const duration = performance.now() - started;
    self.postMessage({...meta, type: 'result', result, duration, delegate});
  } catch (error) { self.postMessage({...meta, type: 'error', message: String(error)}); }
  finally { bitmap.close(); }
};
