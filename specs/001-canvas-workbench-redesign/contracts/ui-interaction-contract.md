# UI Interaction Contract

## Scope

This contract defines observable workbench behavior. It does not define provider or video generation behavior.

## 1. Workbench geometry

- The desktop shell renders exactly one left ToolRail, one center CanvasFlow and one right ContextPanel Dock.
- The ToolRail and its flyout overlay local canvas space; they do not reserve a second business Dock.
- The right Dock reserves layout width while open and has width 0, `hidden`/inert semantics and no hit box while closed.
- ContextPanel Properties and Results remain mounted across tab switches and Dock collapse.
- CanvasFlow remains mounted across every tool flyout and Dock transition.
- Opening/closing the Dock must preserve the world coordinate at the visible canvas center; it must not call fitView automatically.
- At 1024, 1280 and 1440 CSS px there is no page-level horizontal scroll and all core controls remain reachable.

## 2. Tool groups and items

The ToolRail exposes exactly five triggers in this order:

1. 添加节点
2. 服装设计
3. 模特换装
4. 视频制作
5. 创作工具

Each item exposes name, icon, one-line purpose and availability. Unavailable items expose a readable reason and satisfy all of the following on activation:

- no node is created;
- no project revision/history entry is written;
- no fetch/provider request is sent;
- no usage record is created.

Initial availability:

| Group | Item | Behavior |
| --- | --- | --- |
| 添加节点 | 文本节点 | Creates `text-input`. |
| 添加节点 | 本地上传图片 | Creates `image-input` and opens its picker. |
| 添加节点 | 本地上传视频 | Unavailable until a video input/storage contract is approved. |
| 添加节点 | 从资产库中选择 | Opens the existing owner-scoped AssetPicker; selecting creates one image-input. |
| 服装设计 | 草图到效果图 | Creates `sketch-to-render`. |
| 服装设计 | AI 改款 | Creates `ai-modify`. |
| 服装设计 | 面料替换 | Creates `fabric-recolor` preset to `operationMode=fabric`. |
| 服装设计 | 配色替换 | Creates `fabric-recolor` preset to `operationMode=color`. |
| 服装设计 | 印花提取 | Creates `print-extract`. |
| 服装设计 | 印花裂变 | Creates `print-mutate`. |
| 模特换装 | 白底图制作 | Unavailable until its image role/prompt/output acceptance contract is approved. |
| 模特换装 | 一键换装 | Creates standard `virtual-try-on`; advanced entry launches the staged template. |
| 模特换装 | 风格迁移 | Unavailable until its reference-role contract is approved. |
| 视频制作 | all four items | Visible and unavailable until separate specifications and release acceptance exist. |
| 创作工具 | 绘画工具 | Creates `drawing-board`. |
| 创作工具 | 色彩工具 | Opens color selection; completion creates `color-palette`. |

## 3. Flyout state and focus

- Stable pointer hover opens the matching flyout within 250ms.
- Moving from trigger to its flyout does not close or flicker it.
- Rapidly traversing triggers may show only the last stable group.
- Clicking a trigger pins that group; clicking it again closes it.
- Pointer leave never closes a pinned flyout.
- The vertical toolbar uses roving tabindex with ArrowUp/ArrowDown/Home/End.
- Enter or Space opens the focused group and focuses its first available item.
- Escape closes the flyout and restores focus to the originating trigger.
- A disabled item remains focusable, announces `aria-disabled` and its reason, and has zero side effects.
- A boundary-collided flyout repositions and uses internal scrolling; content never becomes unreachable.
- Reduced-motion mode removes motion-dependent transitions without removing state feedback.

## 4. Node creation

- Click creation selects the new node and places it at the nearest safe, visible, non-overlapping position.
- Drag creation places it at the release position converted with `screenToFlowPosition`.
- A single user action creates exactly one node and one global history entry.
- Asset selection creates exactly one image-input and one history entry.
- Read-only projects reject all creation intents.
- A pending creation intent is scoped to its originating `DocumentTarget`; a tab/project/epoch change invalidates it.

## 5. Connection role confirmation

- Dragging to a role-specific target handle proposes that handle's business role.
- Dropping through a generic entry prompts the user to select one compatible unused role.
- Confirmation occurs before the edge enters ProjectTab.
- If the selected role differs from an explicitly targeted handle, is already occupied, is type-incompatible, or would exceed the total input limit, confirmation is blocked with a business-name error.
- Switching/replacing the originating document while the dialog is open invalidates the draft.
- Canceling the dialog produces no edge and no history entry.
- Confirming creates exactly one edge and one history entry.

## 6. Compact nodes and Inspector

An unselected operational node shows only:

- title and run state;
- role/input summary;
- one primary action when applicable;
- latest result summary;
- concise business error.

Long guidance, model controls and advanced fields live in the right Inspector. Selecting a different node updates the Inspector in place. Results remains a sibling tab and retains existing recovery, detail, compare, download and set-as-input behaviors.

The first-round staged node lists person, scene, outfit, bag, shoes, hat, ring, earrings, bracelet and detail with required/optional state and connected source name. The stage-approval node is visible between rounds. The second round remains locked until approval is confirmed and material/construction requirements are satisfied.

Every operational node derives exactly one visible state using this order: active durable job (`排队中`/`运行中`/`自动重试`), stale approval (`需要重新确认`), invalid current-basis prerequisites (`缺少输入`), current-basis terminal job (`成功`/`失败`/`结果未知`), valid executable node without a current-basis terminal job (`可运行`), then non-running input/edit/result content (`空闲`). An older result remains in the result summary after inputs change but cannot mask the new current-basis state. State is communicated by text and icon, with color only as a secondary cue.

## 7. Path emphasis and auto layout

- With one primary selected node, every directly reachable upstream and downstream edge is emphasized; unrelated edges remain visible at reduced contrast.
- Without selection, edges use the quiet default style.
- Running animation remains limited to running/retrying paths and is disabled or replaced with static state under reduced-motion.
- Auto layout is disabled with a prompt when there is no primary selection.
- Auto layout changes only the selected node's complete undirected connected component.
- It produces no overlap, preserves every node's content/status/role/edge, preserves other component coordinates exactly, and writes one history entry.
- A cycle or unavailable measurements causes an all-or-nothing refusal with no coordinate changes.

## 8. Drawing and color

- Opening a board editor dynamically loads the drawing chunk and never changes the infinite canvas background.
- Board-local operations undo/redo independently; no stroke creates global project history.
- Closing/saving one edit session creates one global project history entry after content and preview persistence succeed.
- A failed commit retains the editor and recovery draft.
- Recovering a matching draft creates no global history entry.
- After a successful save, the board exposes its committed preview through an image output; before that point the handle is visibly unavailable and explains that the board must be saved.
- Export creates a separate image-input while preserving the board; direct board connection does not require export.
- Every color selection creates a color-palette node. It never mutates any selected node or field.
- Typed color entry accepts only `#RGB`, `#RRGGBB`, `rgb(r,g,b)` and `hsl(h,s%,l%)`, normalizes successful input to uppercase `#RRGGBB`, and retains invalid text with an inline Chinese error instead of clamping it.
- Colors affect a compatible consumer only after the user creates an explicit palette edge.
- Brush, eraser, shape, text, layer and color controls are reachable in a deterministic keyboard order, expose visible focus and names, and return focus to the originating control when their popover/editor closes.

## 9. Acceptance instrumentation

E2E must record node/edge counts, active project revision, provider request count and geometry before and after risky interactions. All acceptance runs use dummy AI and isolated PostgreSQL. Provider request count must remain 0 for invalid connection, unavailable capability, auto layout, drawing, color selection and unconfirmed staged generation scenarios.
