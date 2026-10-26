# 面捕页

从仓库根目录运行 `python facetrack/setup_vendor.py` 安装开源依赖，手动安装 Cubism Core 和完整模型后，运行 `python facetrack/launcher.py`。

完整说明见 [仓库 README](../README.md)，固定版本及许可见 [依赖说明](../docs/DEPENDENCIES.md)。页面不会上传摄像头或本地测试素材。

运行 `node facetrack/run-tests.mjs` 执行可独立复现的测试。缺 Core 时会明确跳过三个模型运行测试。旧的视频渲染、历史快照和外部主播项目回归脚本不属于这个发布包。
