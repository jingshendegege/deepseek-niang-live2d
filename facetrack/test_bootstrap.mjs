import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('./bootstrap.mjs', import.meta.url), 'utf8');
const failures = [
  ['cubism/live2dcubismcore.min.js', /Live2D Cubism Core.*facetrack\/vendor\/cubism/],
  ['pixi/dist/browser/pixi.min.js', /pixi.js.*setup_vendor/],
  ['live2d/dist/cubism4.min.js', /pixi-live2d-display.*setup_vendor/],
  ['mediapipe/vision_bundle.mjs', /MediaPipe.*setup_vendor/],
  ['mediapipe/face_landmarker.task', /人脸检测模型.*setup_vendor/],
  ['DeepSeekNiang.moc3', /Releases.*export\/DeepSeekNiang_v4/],
];
for (const [missing, expected] of failures) {
  const elements = new Map();
  const element = () => ({style: {}, children: [], textContent: '', replaceChildren() {this.children=[];}, append(...items) {this.children.push(...items);}});
  const controls = [{disabled: false}, {disabled: false}];
  const document = {
    getElementById(id) {if (!elements.has(id)) elements.set(id, element()); return elements.get(id);},
    createElement: element, querySelectorAll: () => controls,
    head: {append() {assert.fail('No scripts should load when installation is incomplete');}},
  };
  await vm.runInNewContext('(async () => {' + source + '\n})()', {
    document, window: {}, fetch: async url => ({ok: !url.includes(missing)}),
  });
  assert.equal(elements.get('model-status').textContent, '依赖未安装');
  assert.match(elements.get('notice').textContent, expected);
  assert.equal(elements.get('loading').children[0].textContent, '需要补齐本地运行文件');
  assert(controls.every(control => control.disabled));
}
console.log('PASS six missing-dependency states: visible guidance, no script load, controls disabled (DOM simulation)');
