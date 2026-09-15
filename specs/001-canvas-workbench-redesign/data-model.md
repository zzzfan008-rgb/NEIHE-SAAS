# Data Model: 画布工作台 UI 整改

## 1. Persisted document boundary

`ProjectTab` remains the in-memory document authority. `DocumentSnapshot` remains the only boundary used to save projects, create templates, build run plans, and serialize browser tab recovery. Only the fields listed below cross that boundary.

Excluded from persisted project data:

- open/hovered/pinned tool group and right Dock state;
- node and result selection, viewer, measurement, focus and current viewport;
- pending connection role dialog;
- drawing editor selection, zoom, local undo/redo stack and IndexedDB recovery draft;
- transient run status, error display and automatic retry countdown.

The shared workflow schema advances from v4 to v5.

## 2. Port and edge model

### PortValueKind

```ts
type PortValueKind = "image" | "text" | "colors" | "video" | "none";
```

`scene` remains an `image` input port. After owner authorization and image validation, the server derives bounded scene/composition/light/pose/expression text for prompt composition and excludes the raw scene image from the generation-provider request. `image-derived analysis` is a processing result, not a persisted `PortValueKind`.

### NodePortSpec

| Field | Type | Rules |
| --- | --- | --- |
| `id` | `string` | Stable semantic id; for input ports this is the persisted edge `targetHandle`. |
| `label` | `string` | User-facing business name. Internal enum names are never used as the only error. |
| `direction` | `"input" \| "output"` | Immutable per spec. |
| `valueKind` | `PortValueKind` | Source and target kinds must match. |
| `required` | `boolean` | Required ports block runs before any paid request. |
| `maxSources` | `number` | Positive integer; role-specific cardinality. |
| `accepts` | `PortValueKind[]` | Optional explicit compatibility override; empty means exact `valueKind`. |

### PersistedWorkflowEdge v5

| Field | Type | Rules |
| --- | --- | --- |
| `id` | `string` | Unique within a workflow. |
| `source` | `string` | Existing node id. |
| `target` | `string` | Existing node id and not equal to source. |
| `sourceHandle` | `string \| null` | Optional output port id. |
| `targetHandle` | `WorkflowInputRole \| null` | Sole persisted semantic role. No duplicate `data.role`. |

`WorkflowInputRole` includes current staged try-on roles plus new typed roles:

```ts
type WorkflowInputRole =
  | "person" | "scene" | "outfit" | "bag" | "shoes" | "hat"
  | "ring" | "earrings" | "bracelet" | "detail" | "material"
  | "baseline-candidate" | "baseline" | "palette" | "prompt";
```

Validation is derived from the target node's `NodePortSpec`; the union prevents unknown roles from being silently saved. Legacy standard image edges may keep a null handle. New staged edges may not.

## 3. Tool discovery model (non-persisted)

### ToolGroup

| Field | Type | Rules |
| --- | --- | --- |
| `id` | five-id union | Exactly: add, apparel, try-on, video, create. |
| `label` | `string` | Exactly the five approved Chinese group labels. |
| `icon` | icon reference | Decorative icon; label remains accessible text. |
| `items` | `ToolItem[]` | Stable order from the feature specification. |

### ToolItem

| Field | Type | Rules |
| --- | --- | --- |
| `id` | `string` | Stable analytics/test identifier. |
| `name` | `string` | User-facing capability name. |
| `description` | `string` | One concise purpose sentence. |
| `availability` | `"available" \| "unavailable"` | Computed without network or provider invocation. |
| `disabledReason` | `string?` | Required when unavailable. |
| `creationIntent` | `CanvasCreationIntent?` | Present only for available items. |

### CanvasCreationIntent

```ts
type CanvasCreationIntent =
  | { type: "node"; kind: NodeKind; preset?: Record<string, unknown> }
  | { type: "asset-picker" }
  | { type: "advanced-try-on-template" }
  | { type: "drawing-board" }
  | { type: "color-palette"; swatches: ColorSwatch[] };
```

The intent is transient. It is resolved inside CanvasFlow and the resulting node/document mutation is persisted.

## 4. Workbench UI state (non-persisted)

```ts
interface WorkbenchUiState {
  hoveredToolGroupId: ToolGroupId | null;
  openToolGroupId: ToolGroupId | null;
  pinnedToolGroupId: ToolGroupId | null;
  rightDockOpen: boolean;
}
```

Rules:

- At most one group is open.
- Pointer leave closes only a hover-open group after the close delay; it never closes a pinned group.
- Clicking the active trigger toggles pinning.
- Escape clears all three group fields and returns focus to the trigger.
- Dock state does not enter Zustand document history or DocumentSnapshot.

### ConnectionDraft

```ts
interface ConnectionDraft {
  target: DocumentTarget;
  sourceNodeId: string;
  targetNodeId: string;
  sourceHandle: string | null;
  proposedTargetHandle: WorkflowInputRole | null;
}
```

The draft is never persisted. Confirmation creates one edge only if the exact DocumentTarget is still active and compatibility remains valid.

## 5. New and changed node entities

All persisted node data include the existing `label`. Runtime `status` and `error` are normalized to idle/absent at the document boundary.

### Derived NodeDisplayState

`NodeDisplayState` is UI-only and MUST NOT be persisted:

```ts
type NodeDisplayState =
  | "idle"
  | "missing-input"
  | "ready"
  | "queued"
  | "running"
  | "retrying"
  | "success"
  | "failed"
  | "unknown-outcome"
  | "needs-reconfirmation";
```

Derivation uses this precedence: active durable job (`queued`/`running`/`retrying`), stale approval (`needs-reconfirmation`), invalid current-basis prerequisites (`missing-input`), current-basis terminal job (`success`/`failed`/`unknown-outcome`), valid executable node without a current-basis terminal job (`ready`), then non-running input/edit/result nodes (`idle`). A terminal result from an older basis remains visible as the latest-result summary but does not override the current basis state. Each value has one stable Chinese label and icon; color is supplemental and never the sole signal.

### TextInputNodeData

```ts
interface TextInputNodeData {
  kind: "text-input";
  label: string;
  text: string;
}
```

- First release is an editable canvas note with a typed `text` output.
- No paid node accepts this output until an explicit prompt-composition contract is approved.
- Empty text is valid for saving but cannot satisfy a future required text port.

### DrawingBoardNodeData

```ts
interface DrawingBoardNodeData {
  kind: "drawing-board";
  label: string;
  boardVersion: 1;
  width: number;
  height: number;
  background: string;
  contentRef?: string;
  previewImageRef?: string;
  exportImageRef?: string;
}
```

Rules:

- Width and height are bounded positive integers; accepted bounds are defined once in the board contract.
- `contentRef` points to an immutable authorized DrawingDocumentVersion.
- `previewImageRef` is the current connection/output image. Without it, image connections and export are blocked.
- A committed `previewImageRef` exposes a typed `image` output directly from the board; consumers resolve the validated owner-scoped file reference, never the DrawingDocument JSON.
- Export is an explicit optional action that creates a separate image-input node; the drawing board remains editable.

### ColorSwatch and ColorPaletteNodeData

```ts
interface ColorSwatch {
  id: string;
  value: `#${string}`;
  name?: string;
  source: "quick" | "custom" | "recent" | "favorite" | "eyedropper";
}

interface ColorPaletteNodeData {
  kind: "color-palette";
  label: string;
  paletteVersion: 1;
  swatches: ColorSwatch[];
}
```

Rules:

- 1–32 unique colors after canonical uppercase `#RRGGBB` normalization.
- Alpha is not persisted in v1.
- Text parsing accepts exactly `#RGB`, `#RRGGBB`, integer-channel `rgb(r,g,b)` and `hsl(h,s%,l%)`; whitespace and function-name case are ignored, hue is normalized, and output is canonical uppercase `#RRGGBB`.
- Alpha-bearing, malformed, non-finite and out-of-range values fail validation without clamping or approximation.
- Choosing a color creates a palette node and never patches an existing node.
- Recent/favorite collections are user preference state, not part of this node.

### StageApprovalNodeData

```ts
interface StageApprovalNodeData {
  kind: "stage-approval";
  label: string;
  approvalKind: "scene-baseline";
  approvedSourceNodeId?: string;
  approvedBaselineRef?: string;
  approvedBasisRevision?: number;
  approvedAt?: string;
}
```

Derived state:

```ts
type ApprovalState = "waiting" | "confirmable" | "confirmed" | "stale";
```

The node has one required `image` input role `baseline-candidate` and one `image` output. It emits the approved image only in confirmed state.

### VirtualTryOnNodeData changes

For `workflowStage: "scene-stabilize"`:

- Add `basisRevision: number`, initialized to 0.
- Add optional multi-source `detail` input role.
- Required roles remain person, scene and outfit.
- bag, shoes, hat, ring, earrings and bracelet each accept at most one source.
- Total model reference limit remains 14.

For `workflowStage: "garment-refine"`:

- Remove confirmation ownership from the second-stage node after v5 migration.
- Required baseline must come from a confirmed stage-approval node via role `baseline`.
- Existing garment category, material and construction validation remains unchanged.

### FabricRecolorNodeData change

```ts
operationMode: "combined" | "fabric" | "color";
```

- v4 nodes migrate to `combined` and preserve behavior.
- “面料配色替换” creation intent uses `fabric`; 配色通过同一节点的 `color` 或 `combined` 模式完成，不再提供独立的配色替换创建意图。
- A connected palette is the execution-time colors source; without a palette, the node's own colors remain the fallback.

## 6. Drawing resources

### DrawingDocumentVersion (PostgreSQL authoritative structured data)

| Field | Type | Rules |
| --- | --- | --- |
| `id` | UUID/string id | Immutable content reference. |
| `ownerId` | user id | Required; authorization checked on every read/write/reference. |
| `projectId` | project id | Must belong to owner. |
| `nodeId` | node id | Must identify a drawing-board in that project save. |
| `version` | `1` | DTO schema version. |
| `content` | `DrawingDocument` JSON | Validated size, layer, object and coordinate limits. |
| `sha256` | hex string | Hash of canonical content for integrity/base matching. |
| `createdAt` | timestamp | Server generated. |

Versions are append-only. Project undo/redo changes the node reference; it does not mutate an old DrawingDocumentVersion. Unreferenced versions use the project's existing recovery/retention policy and are never deleted during a normal deployment.

### DrawingDocument

```ts
interface DrawingDocument {
  version: 1;
  canvas: { width: number; height: number; background: string };
  layers: DrawingLayer[];
}

interface DrawingLayer {
  id: string;
  name: string;
  visible: boolean;
  locked: boolean;
  opacity: number;
  objects: DrawingObject[];
}

type DrawingObject = DrawingStroke | DrawingShape | DrawingText;
```

`DrawingStroke` stores simplified point arrays, color, width and composite mode (`source-over` or `destination-out`). `DrawingShape` supports line, rectangle, ellipse and arrow. `DrawingText` stores text, position, width, font size, family, alignment and color. Unknown object kinds fail validation.

### DrawingRecoveryDraft (IndexedDB, non-authoritative)

```ts
interface DrawingRecoveryDraft {
  ownerId: string;
  tabId: string;
  projectId: string;
  documentEpoch: number;
  nodeId: string;
  baseContentRef: string | null;
  baseContentHash: string | null;
  draftRevision: number;
  document: DrawingDocument;
  updatedAt: string;
}
```

Recovery is offered only when owner, project, node, epoch and base reference still match. A mismatch may be opened as a copy or discarded; it never silently overwrites committed data.

## 7. Relationships

```text
ToolGroup 1 ──* ToolItem ──0..1 CanvasCreationIntent
ProjectTab 1 ──1 DocumentSnapshot
DocumentSnapshot 1 ──* PersistedWorkflowNode
DocumentSnapshot 1 ──* PersistedWorkflowEdge
PersistedWorkflowEdge * ──1 source NodePortSpec
PersistedWorkflowEdge * ──1 target NodePortSpec / targetHandle role
DrawingBoardNode 1 ──0..1 DrawingDocumentVersion
DrawingBoardNode 1 ──0..1 preview file in DATA_DIR
Stage-1 Try-On 1 ──1 StageApproval ──1 Stage-2 Try-On
ColorPalette 1 ──* compatible color consumers
```

## 8. State transitions

### Tool flyout

```text
closed → hover-pending → hover-open → closed
closed → pinned-open → closed
hover-open → pinned-open
any-open → closed (Escape + focus restore)
```

### Stage approval

```text
waiting --candidate available--> confirmable
confirmable --user confirms--> confirmed
confirmed --input/parameter/output/re-run change--> stale
stale --user confirms current basis--> confirmed
any --candidate removed--> waiting
```

### Drawing editor

```text
closed → editing → committing → closed
editing → editing (local undo/redo + throttled draft save)
committing --upload/save/DocumentTarget failure--> editing with draft retained
closed --matching draft found--> editing (recovery, no global history entry)
editing --discard--> closed + draft deleted
```

### Auto layout

```text
disabled(no primary selection)
ready(selection has component)
ready --acyclic--> one atomic position commit
ready --cycle or missing measurements--> unchanged + business error
```

## 9. Migration v4 → v5

1. Validate all existing v4 nodes and edges using v4 rules first.
2. Add defaults: `basisRevision=0` for scene-stabilize and `operationMode="combined"` for fabric-recolor.
3. Keep valid existing target handles unchanged; do not infer ambiguous missing staged roles.
4. For an existing garment-refine node with a valid `approvedBaselineRef`, deterministically insert one stage-approval node between its current baseline source and refine node, transfer the approval reference, and rewrite the two edges to `baseline-candidate` and `baseline`.
5. Use deterministic inserted node/edge ids derived from the refine node id; repeated migration must not duplicate them.
6. Preserve standard virtual-try-on and all existing image workflows without semantic changes.
7. Templates must not carry owner-specific DrawingDocumentVersion or real image references; a drawing board in a template becomes an empty board with dimensions/background only.
8. Invalid v5 typed roles, cross-owner content refs or duplicate single-source roles fail closed. No migration guesses or deletes user content.
