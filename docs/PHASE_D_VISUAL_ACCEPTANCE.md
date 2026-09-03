# Phase D 桌面视觉与交互验收证据

验收日期：2026-08-30

代码基线：`main@3dc6a1dc8b54b4ee2596f5f484471328380edafc`

本地地址：`http://localhost:5173/`

就绪状态：`GET /api/ready` 返回 `ok: true`，`mode: full`，数据库、数据目录、前端、AI 配置和用户配置检查均通过。

本次验收仅覆盖桌面端，不包含移动端或触控专用布局。浏览器使用已登录管理员会话，未修改密码、账号、权限或安全设置，未发送真实 AI 请求。

## 三主题 × 三宽度

| 主题 | 1024 × 768 | 1280 × 720 | 1440 × 900 |
| --- | --- | --- | --- |
| 经典暗金 (`current`) | [截图](evidence/phase-d/current-1024x768.png) | [截图](evidence/phase-d/current-1280x720.png) | [截图](evidence/phase-d/current-1440x900.png) |
| 简白 (`white`) | [截图](evidence/phase-d/white-1024x768.png) | [截图](evidence/phase-d/white-1280x720.png) | [截图](evidence/phase-d/white-1440x900.png) |
| 护眼绿 (`eye`) | [截图](evidence/phase-d/eye-1024x768.png) | [截图](evidence/phase-d/eye-1280x720.png) | [截图](evidence/phase-d/eye-1440x900.png) |

逐张检查结果：顶栏、项目页签、画布、节点、连接线、MiniMap、右侧 Results 与桌面 Dock 均保持在视口内；三主题的节点、画布、控件和状态文字具有可辨识对比度。1024 宽度下左右 Dock 互斥，切换后另一侧关闭；1280 与 1440 保持完整桌面工作区。

## Results 状态与动作

- 当前历史中可见 2 条“结果未知”和 6 条“失败”记录；状态使用独立文案和颜色，不与成功结果混淆。
- 成功结果继续提供查看、对比、下载和设为输入/继续处理动作。
- 查看器首次点击打开，Escape 后卸载；双图加入对比后首次点击打开对比 Dialog，Escape 后卸载。
- 失败状态证据：[失败记录](evidence/phase-d/results-failure-unknown-1024x768.png)。
- 未知状态证据：[结果未知记录](evidence/phase-d/results-unknown-1024x768.png)。

## 键盘、焦点与弹层

| 场景 | 结果 |
| --- | --- |
| 主题菜单 | 打开后 Escape 关闭，焦点回到主题按钮 |
| 快捷键说明 | 打开后 Escape 关闭，焦点保持/回到快捷键按钮 |
| 项目中心 Dialog | 初始焦点位于 Dialog 内；连续 10 次 Tab 未逃逸；Escape 关闭并恢复到触发按钮 |
| 图片查看器 | 首次查看动作打开；Escape 关闭 |
| 结果对比 | 两项加入对比后首次动作打开；Escape 关闭并卸载 Dialog |
| 1024 Dock | 左侧“节点 / 素材”和右侧“属性 / 结果”互斥，切回 Results 后内容恢复 |

React Flow 快捷键隔离、生产构建和三宽度行为由完整 Playwright 回归继续作为发布门禁；最终结果记录在发布候选 PR 中。

## 处置结论

本轮只读验收未发现必须修改的 UI 或交互问题，因此未产生新的 UI 方案或代码改动。用户对发布候选版本的最终视觉确认仍是推送/合并门禁。
