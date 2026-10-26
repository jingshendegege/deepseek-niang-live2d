// Load optional local dependencies in order and explain incomplete installations.
const resources = [
  ['./vendor/cubism/live2dcubismcore.min.js', 'Live2D Cubism Core：请从 Live2D 官网下载 Cubism SDK for Web，把 Core/live2dcubismcore.min.js 放到 facetrack/vendor/cubism/live2dcubismcore.min.js。'],
  ['./vendor/pixi/dist/browser/pixi.min.js', '缺少 pixi.js：请运行 python facetrack/setup_vendor.py。'],
  ['./vendor/live2d/dist/cubism4.min.js', '缺少 pixi-live2d-display：请运行 python facetrack/setup_vendor.py。'],
  ['./vendor/mediapipe/vision_bundle.mjs', '缺少 MediaPipe：请运行 python facetrack/setup_vendor.py。'],
  ['./vendor/mediapipe/face_landmarker.task', '缺少人脸检测模型：请运行 python facetrack/setup_vendor.py。'],
  ['../export/DeepSeekNiang_v4/DeepSeekNiang.moc3', '缺少完整模型：请从仓库 Releases 下载模型 ZIP，解压到 export/DeepSeekNiang_v4/。尚未发布时请联系项目维护者取得完整包。'],
];
function failure(message) {
  const loading = document.getElementById('loading');
  loading.replaceChildren();
  const title = document.createElement('strong');
  title.textContent = '需要补齐本地运行文件';
  const detail = document.createElement('span');
  detail.textContent = message;
  detail.style.maxWidth = '38rem';
  detail.style.padding = '1rem';
  const help = document.createElement('a');
  help.href = '../README.md'; help.textContent = '查看安装与运行说明（README）';
  loading.append(title, detail, help);
  document.getElementById('model-status').textContent = '依赖未安装';
  document.getElementById('notice').textContent = message;
  document.querySelectorAll('button, input').forEach(element => { element.disabled = true; });
}
async function loadScript(src) {
  await new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src; script.onload = resolve;
    script.onerror = () => reject(new Error('脚本加载失败：' + src));
    document.head.append(script);
  });
}
try {
  for (const [path, message] of resources) {
    const response = await fetch(path, {method: 'HEAD', cache: 'no-store'});
    if (!response.ok) throw new Error(message);
  }
  await loadScript(resources[0][0]);
  if (!window.Live2DCubismCore) throw new Error(resources[0][1]);
  await loadScript(resources[1][0]);
  await loadScript(resources[2][0]);
  await import('./app.mjs');
} catch (error) {
  failure(error.message);
}
