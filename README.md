# DeepSeek娘 Live2D · v4z7

DeepSeek娘是一位以蓝色系、鲸尾和荷叶头饰为特征的 Live2D 角色。**角色设计与美术：donkyi，未经许可请勿二次分发或商用。** 本仓库未授予开源许可。

English: DeepSeek-niang Live2D v4z7 includes a local face-tracking web app, model configuration, expressions, and hair/eye colour presets. Character design and artwork by donkyi. Redistribution and commercial use require permission.

## 下载完整模型

**完整模型请到 [Releases](../../releases) 下载。** Git 仓库只保存轻量运行文件；单独克隆仓库不能显示模型。若 Releases 尚无 v4z7，请联系维护者取得完整模型包。

完整附件命名为 `DeepSeekNiang-v4z7.zip`，解压得到 `DeepSeekNiang_v4/`。其中包含 `DeepSeekNiang.moc3` 和唯一一份 `DeepSeekNiang.cmo3`；`Cubism/` 仅保留动画工程 `.can3`。这两个大文件不进入 Git，也不使用 LFS。Release ZIP 不包含 Cubism Core 或第三方前端依赖。

## 功能

- 摄像头面捕、本地图片/视频输入、正面校准、眨眼和嘴形跟随；画面由本地浏览器处理。
- 页面内跟随鼠标，眼睛、头部和身体平滑响应；开始面捕时自动让位。
- 模型包含 38 个表情条目（含饰品、手势和皮肤）；网页隐藏部分旧入口，显示按钮数不等于文件总数。
- AI 主题发色与眼色预设、自定义颜色、异色瞳、眼色跟随发色，以及蝴蝶结/领结配色。
- 饰品切换、动作试播、上半身/全身取景、缩放和平移。
- 原生裙子 Q 弹物理和尾巴摆动；网页附加尾巴待机提供关/轻/中。身体小跳驱动按现有设计保持关闭。

发色、眼色和部分交互由网页着色器实现，VTube Studio 不会执行这些网页功能。发布包不含音频，网页音效默认关闭。

## 文件结构

```text
export/DeepSeekNiang_v4/   模型配置、14 页贴图、物理、动作、38 个表情、VTS 配置
facetrack/                面捕页面、源码、启动器与 Node 测试
facetrack/vendor/         依赖安装位置（运行库不入库）
hair_palettes.json        发色、眼色、蝴蝶结配色数据
hair_masks/               与正式包匹配的 manifest 和 PNG 遮罩
docs/CHANGELOG.md         精简版本说明
docs/DEPENDENCIES.md      依赖版本、许可与获取位置
```

## 在 VTube Studio 使用

1. 下载完整模型 ZIP，将解压出的 `DeepSeekNiang_v4` 文件夹放入 VTube Studio 的 `Live2DModels` 目录。可从 VTube Studio 的模型管理界面定位该目录。
2. 在 VTube Studio 重新扫描并选择 DeepSeekNiang，使用随包的 `.vtube.json`、物理和表情配置。
3. 打开跟踪并校准，按设备调整灵敏度；需要时自行配置表情快捷键。工程 `.cmo3`、`.can3` 不属于运行必需文件。

本轮整理未进行 VTube Studio 实机验收；网页自由换色不能直接复制到 VTube Studio。

## 在网页使用

需要 Python 3，以及支持 WebGL、摄像头权限的现代桌面浏览器。

1. 把完整 ZIP 的 `DeepSeekNiang_v4` 文件夹放到仓库 `export/` 下，合并轻量文件，确保 `export/DeepSeekNiang_v4/DeepSeekNiang.moc3` 存在。
2. 从 [Live2D 官方下载页](https://www.live2d.com/en/sdk/download/web/) 获取 Cubism SDK for Web，并自行阅读适用许可。把 SDK 中的 `Core/live2dcubismcore.min.js` 复制到 `facetrack/vendor/cubism/live2dcubismcore.min.js`。**本仓库不分发 Core，也不自动下载或接受它的许可。**
3. 在仓库根目录运行以下命令，安装固定版本的开源依赖并启动：

```powershell
python facetrack/setup_vendor.py
python facetrack/launcher.py
```

浏览器入口是 `http://localhost:8765/facetrack/index.html`。也可双击 `facetrack/启动面捕测试.bat`。缺 Core、前端依赖或完整模型时，页面会显示具体缺失项与安装路径。

首次安装开源依赖需要联网；安装完成后，摄像头、视频和图片仅在本地处理。不要直接双击 HTML 使用 `file://` 打开。

使用其他静态服务器时，以**仓库根目录**作为服务根目录，例如：

```powershell
python -m http.server 8765 --bind 127.0.0.1
```

默认模型固定为 `../export/DeepSeekNiang_v4/DeepSeekNiang.model3.json`；旧预览和内部快照入口已移除。开启摄像头后正视镜头校准；关闭输入恢复待机/鼠标跟随。

## 测试

安装 Node.js 后，在仓库根目录执行：

```powershell
node facetrack/run-tests.mjs
```

基础测试不需要 Core，覆盖映射、眼部迟滞、检测 Worker、鼠标、身体驱动、模型文件引用和缺依赖提示的 DOM 模拟。三个 Core 测试在缺 Core、显示库或完整模型时明确跳过；安装后自动运行。测试输出写入已忽略的 `renders/qa/publish/` 与 `_tmp/`。

没有摄像头或完整运行依赖时，基础测试通过不代表真实面捕、WebGL 画质或 VTube Studio 已验收。
