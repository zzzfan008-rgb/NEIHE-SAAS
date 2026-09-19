# 本地 DWPose 姿势参考

一键换装的骨骼图使用本地人体检测 + 全身关键点估计 + 确定性绘制，不使用 Gemini 或 SD1.5 OpenPose ControlNet 权重。第一轮仍由原有图像模型生成成图，但仅使用用户手动连接的姿势图片，不再触发骨骼分析 API。

## 安装与启动

需要 Python 3.11、uv。运行 `sh scripts/pose/setup.sh`，约下载 335 MiB 模型；运行时目录在 `tmp/`，不提交 Git。网络需要代理时显式设置 `HTTPS_PROXY`。脚本下载官方固定版本源码及许可证，服务启动时校验源码和权重 SHA-256，校验不通过立即停止。

模型来源：[作者 Hugging Face 仓库](https://huggingface.co/yzd-v/DWPose/tree/1a7144101628d69ee7a3768d1ee3a094070dc388)，文件 `yolox_l.onnx` 和 `dw-ll_ucoco_384.onnx`。推理函数来源：[官方 ONNX 分支固定提交](https://github.com/IDEA-Research/DWPose/tree/3dca5db79d9f9ffdd378753ddf6ec66535aace88)，仓库许可证 Apache-2.0；发行或商用仍需核对所使用权重及其训练数据的适用条件。骨骼绘制代码由本项目实现。

在私有环境中设置至少 32 字符随机 ASCII 令牌，不放入前端、命令日志或 Git：

```sh
export POSE_SOURCE_DIR="$PWD/tmp/dwpose-source"
export POSE_MODELS_DIR="$PWD/tmp/dwpose-models"
export POSE_SERVICE_PORT=8767
# 私有环境已设置 POSE_SERVICE_TOKEN
tmp/dwpose-venv/bin/python scripts/pose/service.py
```

Node 后端配置 `POSE_SERVICE_URL=http://127.0.0.1:8767` 和相同 `POSE_SERVICE_TOKEN` 后重启。运行设备为 ONNX Runtime CPU（不是 MPS）；模型驻留内存，单任务串行，不自动回退到外部 API。

Mac 原生 Node 可直连；Docker 内的 127.0.0.1 是容器自身，**不能直接指向 Mac 服务**。部署需要显式配置到宿主机的 HTTPS 代理，或容器侧 loopback SSH 隧道；不通过放宽网络校验或公网暴露未加密服务解决。服务配置不全时前端显示失败并允许手动重试，不调用付费模型。

## 交互及限制

- 姿势原图上传后不自动连线；断线也可打开三图对比。旧项目已有连线不会被删除。
- 三图分别支持放大、下载、添加到画布；新增独立图片节点，不自动接入第一轮。生成图片经现有受鉴权文件接口存储，支持保存、撤销/恢复及后续使用。
- 将选中的一个节点手动连接到第一轮的“姿势”输入。原图、骨骼图和深度图都可用；系统不替换为另一种图。
- 旧 Gemini 骨骼结果仍可查看、下载及使用，同时可生成本地 DWPose 结果。配置切换或重试失败时保留最近成功图。
- DWPose 不能保证被宽松衣物、帽子遮挡的关节准确；低置信度关键点不绘制，不补画隐藏关节。无人图报错，不生成假骨架。最多处理 8 人；建议上传单人完整图。
- 深度沿用 Depth Anything V2 Large，亮近暗远，仅表示可见表面，且其非商业许可限制不因本次更改而改变。

验证不需要付费 AI：适配器测试、本地 Python 单测、真实图片 ONNX 推理、桌面 1024/1280/1440 三图交互回归。
