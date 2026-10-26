import {Worker} from 'node:worker_threads';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const reportDir = path.join(root, 'renders/qa/publish');
fs.mkdirSync(reportDir, {recursive: true});
const entries = [
  ['_test/verify.mjs', false], ['_test/eyes_hysteresis.mjs', false],
  ['_test/worker_test.mjs', false], ['test_mouse.mjs', false],
  ['test_body_bob.mjs', false], ['test_package.mjs', false], ['test_bootstrap.mjs', false],
  ['test_eyes.mjs', true], ['test_bow_packages.mjs', true], ['test_hair.mjs', true],
];
const complete = fs.existsSync(path.join(root, 'facetrack/vendor/cubism/live2dcubismcore.min.js')) &&
  fs.existsSync(path.join(root, 'facetrack/vendor/live2d/dist/cubism4.js')) &&
  fs.existsSync(path.join(root, 'export/DeepSeekNiang_v4/DeepSeekNiang.moc3'));
const report = [];
for (const [file, needsCore] of entries) {
  if (needsCore && !complete) {
    console.log('SKIP ' + file + '：需要自行安装 Cubism Core、显示库及完整模型。');
    report.push({file, status: 'skipped', reason: 'Core/display library/full model not installed'});
    continue;
  }
  const result = await new Promise(resolve => {
    const worker = new Worker(new URL(file, import.meta.url), {
      env: {...process.env, COLOR_QA: 'publish', COLOR_TMP: 'publish'},
    });
    worker.once('error', error => resolve({code: 1, error}));
    worker.once('exit', code => resolve({code}));
  });
  const status = result.code === 0 ? 'passed' : 'failed';
  report.push({file, status});
  console.log(status.toUpperCase() + ' ' + file);
  if (status === 'failed') console.error(result.error?.stack || 'Test exited with code ' + result.code);
}
fs.writeFileSync(path.join(reportDir, 'suite.json'), JSON.stringify(report, null, 2));
if (report.some(item => item.status === 'failed')) process.exitCode = 1;
