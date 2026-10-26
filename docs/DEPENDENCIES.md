# 依赖获取与许可记录

为了减小仓库体积，所有第三方运行库都由使用者自行安装，不随 Git 或模型 ZIP 分发。本项目自己的代码按 MIT（LICENSE）、模型与美术按 CC BY-NC-SA 4.0（LICENSE-ART.md）发布；第三方依赖保留各自许可，不在本项目许可范围内。

| 组件 | 检查版本 | 上游标注许可 | 发布处理 |
| --- | --- | --- | --- |
| Live2D Cubism Core | 本地原版 Core | Live2D 专有许可 | 不上传；从 [Live2D 官网](https://www.live2d.com/en/sdk/download/web/) 获取并自行阅读条款 |
| pixi.js | 6.5.10 | MIT，本地包内含许可文本 | 安装脚本从 npm 固定版本下载，保留许可文本 |
| pixi-live2d-display | 0.4.0 | MIT，本地包内含许可文本 | 安装脚本从 npm 固定版本下载，保留许可文本；此适配库不包含 Core |
| @mediapipe/tasks-vision | 0.10.21 | package.json 标注 Apache-2.0，源码有版权声明 | 安装脚本从 npm 获取，保留随包声明；本地未提供独立许可文件，不自行授予许可 |
| Face Landmarker float16 模型 | 1 | 模型许可请查上游模型说明 | 不分发，按 [官方模型地址](https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task) 获取 |
| vendor/testing 内的测试依赖 | Playwright | Apache-2.0，随包含许可与第三方声明 | 不复制、不安装；基础 Node 测试不依赖 Playwright |

安装器使用 `facetrack/dependencies.json` 中固定版本 URL 和逐文件 SHA-256 校验，只写 `facetrack/vendor/`。它不会下载官方样本模型，也不会下载 Cubism Core。

安装后主要路径：

```text
facetrack/vendor/cubism/live2dcubismcore.min.js       手动安装
facetrack/vendor/pixi/dist/browser/pixi.min.js       pixi.js
facetrack/vendor/live2d/dist/cubism4.min.js           显示适配库
facetrack/vendor/live2d/dist/cubism4.js               着色器回归测试所需
facetrack/vendor/mediapipe/vision_bundle.mjs         面捕运行库
facetrack/vendor/mediapipe/wasm/                     SIMD 与非 SIMD 运行文件
facetrack/vendor/mediapipe/face_landmarker.task       面部识别模型
```

参考： [pixi.js 6.5.10 元数据](https://registry.npmjs.org/pixi.js/6.5.10)、[pixi-live2d-display 0.4.0 元数据](https://registry.npmjs.org/pixi-live2d-display/0.4.0)、[MediaPipe 0.10.21 元数据](https://registry.npmjs.org/@mediapipe/tasks-vision/0.10.21)。
