# Implementation Evidence: Canvas Workbench Redesign

## Repository baseline

- Repository: `NEIHE-AI` (`/Users/neihe/NEIHE-AI`)
- Branch: `main`
- Local baseline commit: `cdbb9ea08c5cb33d2dc723b1a28b0558e13569a7`
- Baseline commit purpose: honest local import of the reviewed extracted project; no upstream history was fabricated and nothing was pushed.
- Baseline staged-file audit: 317 files; forbidden runtime/secret paths: 0; credential-pattern hits: 0; `git diff --cached --check`: pass.
- GitNexus index: commit-bound PDG index, 24,502 nodes, 57,168 edges, 290 clusters, 810 reported flows.
- GitNexus baseline change check: `detect-changes --scope all --repo NEIHE-AI` returned `No changes detected`.
- GitNexus limitation: process extraction reported bounded/truncated discovery during indexing; impact results remain lower bounds and HIGH/CRITICAL/UNKNOWN handling follows `AGENTS.md`.

## Safety accounting

- Production deployment authorized by this feature: no.
- Production data access authorized: no.
- Real or paid AI requests authorized: no.
- Cumulative real/paid provider request count during implementation: `0`.
- Test provider policy: isolated PostgreSQL, temporary `DATA_DIR`, dummy/stub provider only.

## Per-task evidence template

For every completed task, append a row or subsection containing:

| Field | Required evidence |
|---|---|
| Task | Task id and short outcome |
| Impact | Repository/index identity, target symbol, upstream risk, direct/total dependants and affected processes; resolve UNKNOWN with source search |
| Failing test | Exact command, intended failure and confirmation that it preceded implementation |
| Passing test | Exact focused command and observed result |
| Safety | Provider request count and confirmation that no production data/credentials were used |
| Files | Exact files changed |
| Notes | Unavailable/degraded gates, follow-up risks or dependency decisions |

## Task log

### T001 — Implementation evidence ledger

- Status: complete.
- Impact: documentation-only task; no function, class, method, route contract or shared type edited.
- Validation: baseline commit, GitNexus status and clean baseline change detection recorded above.
- Safety: real/paid provider request count `0`; no production data accessed.
- Files: `specs/001-canvas-workbench-redesign/implementation-evidence.md`, task checkbox in `tasks.md`.

### T002 — Pre-redesign node-height baseline

- Status: complete.
- Measurement method: temporary Playwright fixture rendered through the production workbench component tree; heights read from each `.react-flow__node` with `getBoundingClientRect().height`. The temporary test was removed after recording this evidence.
- Environment: Chromium `149.0.7827.55`; theme `current` (经典暗金); device scale inherited from Playwright `Desktop Chrome`; reduced motion enabled by the test configuration.
- First-round fixture: `id=t002-scene-stabilize`, label `第一轮 · Gemini 场景化定版`, `status=idle`, `workflowStage=scene-stabilize`, prompt `只描述最终效果，不要重定义参考图角色或编号`, model `gemini-3.1-flash-image-preview`, model options `{ aspectRatio: "3:4", imageSize: "2K" }`, output tier `2K`, no output images and no incoming edges.
- Second-round fixture: `id=t002-garment-refine`, label `第二轮 · GPT 服装精修`, `status=idle`, `workflowStage=garment-refine`, same prompt, model `gpt-image-2`, model options `{ quality: "medium" }`, output tier `2K`, category `knit`, material `70%羊毛、30%羊绒，双股纱，中等厚度，低光泽`, construction `12GG，衣身平针，1×1罗纹领口，全成型收针`, no approved baseline, no output images and no incoming edges.

| CSS viewport | First-round height | Second-round height | SC-004 maximum (70%) |
|---:|---:|---:|---:|
| `1024 × 768` | `601.25 px` | `910.625 px` | `420.875 px` / `637.4375 px` |
| `1280 × 720` | `601.25 px` | `910.625 px` | `420.875 px` / `637.4375 px` |
| `1440 × 900` | `601.25 px` | `910.625 px` | `420.875 px` / `637.4375 px` |

- Validation: `pnpm run test:e2e` completed `33 passed (1.7m)` with the temporary measurement test included for each desktop viewport. The isolated runner used a disposable PostgreSQL container, temporary `DATA_DIR`, `APIYI_API_KEY=e2e-disabled`, and a request guard that rejects generation POSTs.
- Safety: real/paid provider request count `0`; no production credentials or data were used.
- Files retained: this evidence entry and the T002 checkbox only; temporary E2E fixture code was removed.

### T003–T006 — Foundational failing contracts

- Status: complete; each test was written before the matching implementation and observed failing for the intended missing v5 behavior.
- Impact: `tests/workflow-schema.test.ts:main` is LOW (1 direct/1 total, exact). The other three files expose top-level test programs rather than an indexed `main`; GitNexus returned UNKNOWN, resolved by source search confirming the edits are isolated test assertions with no production callers.
- Failing tests:
  - `./node_modules/.bin/tsx tests/workflow-schema.test.ts` — failed at the new migration assertion with `4 !== 5`.
  - `./node_modules/.bin/tsx tests/document-snapshot.test.ts` — failed at the new wire assertion with `4 !== 5`.
  - `./node_modules/.bin/tsx tests/project-tabs-session.test.ts` — failed because the four new node kinds were dropped during recovery.
  - `./node_modules/.bin/tsx tests/active-document-boundary.test.ts` — failed because `src/types/workbench.ts` does not yet exist.
- Safety: real/paid provider request count `0`; no network/provider adapter or production data was used.
- Files: the four test files above plus task checkboxes in `tasks.md`.

### T007–T011 — Foundational implementation impact gate

- Status: complete.
- Impact: `NodeKind` MEDIUM (4 direct/81 total, exact); `VirtualTryOnNodeData`, `FabricRecolorNodeData` and `PersistedWorkflowEdge` CRITICAL (49 direct/80 total; node interfaces are lower bounds). `NODE_SPECS` and `WORKFLOW_SCHEMA_VERSION` returned UNKNOWN; source search resolved broad live use across store, DAG, runner, schema, routes, templates, Inspector, node library and E2E. These files must ship as one compatibility slice.
- Additional impact: `createDocumentNodeData`, `cloneDocumentNodeData` and `documentSnapshotToPersistedWorkflow` were CRITICAL across project/template/session save flows; `validateAndMigrateFlow`, `migrateNodeData` and `validateData` were HIGH across project/template load flows; `defaultNodeData` was CRITICAL (5 direct/15 total, 10 processes); `normalizeSessionNode`, `extractOutputImages`, `extractParams` and `builtinTemplates` were LOW; `executeStep` was HIGH (2 direct/6 total, 3 execution/queue processes). Newly added `connectionCompatibilityError` was not yet indexed, so UNKNOWN was resolved by source search to the server schema call and its focused tests.
- Outcome: schema v5 adds typed value ports/roles plus text, drawing-board, color-palette and independent stage-approval nodes. The document boundary uses an explicit whitelist, maps unrecognized legacy handles to null instead of guessing, normalizes runtime state, and excludes editor/flyout/recovery transients. v0–v4 migrate deterministically; future versions fail closed. Session recovery preserves all v5 durable fields. Historical 8-reference mask documents remain readable at the persistence boundary while interactive ports and execution retain the 7-reference limit.
- Files: `src/types/workflow.ts`, `src/types/workbench.ts`, `src/lib/workflowPorts.ts`, `src/lib/documentSnapshot.ts`, `server/lib/workflowSchema.ts`, `src/store/flowStore.ts`, and exhaustive compatibility branches in `server/engine/dag.ts`, `server/engine/runner.ts`, `server/routes/templates.ts`, `src/components/panels/InspectorPanel.tsx`, `src/components/panels/WorkflowMini.tsx`.
- Safety: real/paid provider request count `0`.

### T012 — Foundational green gate

- Status: complete.
- Passing tests:
  - `./node_modules/.bin/tsx tests/workflow-schema.test.ts` — 29/29 passed, including v4→v5 deterministic migration, typed-port legality, future-version rejection, historical mask compatibility and built-in template migration.
  - `./node_modules/.bin/tsx tests/document-snapshot.test.ts` — 1/1 passed with all new node/edge fields round-tripping through the explicit whitelist.
  - `./node_modules/.bin/tsx tests/project-tabs-session.test.ts` — 28/28 passed, including v5 recovery and transient exclusion.
  - `./node_modules/.bin/tsx tests/active-document-boundary.test.ts` — passed all canonical selector and non-persisted workbench-contract assertions.
  - `./node_modules/.bin/tsc --noEmit --pretty false` — passed with zero diagnostics.
- Migration fixtures: unversioned v0, v2 mask/project/template, v4 staged try-on and native v5 typed-port workflows.
- Safety: real/paid provider request count `0`; tests used no provider call, production credential or production data.

### T013–T016 — US1 failing contracts

- Status: complete; tests were added before the five-group implementation and observed failing for the intended missing behavior.
- Failing tests:
  - `pnpm exec tsx tests/tool-catalog.test.ts` — failed because `src/lib/toolCatalog.ts` did not exist.
  - `pnpm exec tsx tests/canvas-creation.test.ts` — failed because `src/lib/canvasCreation.ts` did not exist.
  - `pnpm exec tsx tests/workbench-shell.test.ts` — failed because the old two-left-Dock state did not implement hover, pin, delayed close, Escape or focus-return transitions.
  - `pnpm run test:e2e` — the new five-group journey failed at all three desktop widths because none of the five triggers existed.
- Safety: real/paid provider request count `0`; the E2E provider boundary used the isolated request guard.
- Files: `tests/tool-catalog.test.ts`, `tests/canvas-creation.test.ts`, `tests/workbench-shell.test.ts`, `e2e/workbench.spec.ts`.

### T017–T027 — US1 implementation and impact gate

- Status: complete.
- Impact: `workbenchUiReducer` returned UNKNOWN and source search resolved its callers to `WorkbenchShell` and its focused test. `WorkbenchShell`, `CanvasFlow` and `Workspace` were LOW with direct application-level callers. `ToolRail` was not yet present in the index and returned UNKNOWN; source search resolved one production mount in `WorkbenchShell` plus source-contract tests. `defaultNodeData`/`addNode` remain covered by the previously reported CRITICAL shared-store warning, so creation changes were kept as one compatibility slice and exercised through project history regressions.
- Outcome: the retired node-library Dock is replaced by exactly five anchored tool groups and 19 ordered items. Available items create typed intents by click or serialized drag; disabled items remain focusable with reasons and have no mutation handler. Click placement searches visible non-overlapping space, drag placement preserves the transformed drop coordinate, and every request is scoped to the current `DocumentTarget`. The Canvas and right context tree remain single-mounted. Base UI's default trigger handler is explicitly suppressed after the app-owned pin transition so pointer hover plus click cannot double-toggle the flyout.
- Files: `src/lib/toolCatalog.ts`, `src/lib/canvasCreation.ts`, `src/types/workbench.ts`, `src/components/ui/popover.tsx`, `src/components/workbench/ToolFlyout.tsx`, `src/components/workbench/ToolRail.tsx`, `src/components/workbench/workbenchState.ts`, `src/components/workbench/WorkbenchShell.tsx`, `src/components/CanvasFlow.tsx`, `src/components/nodes/TextInputNode.tsx`, `src/components/nodes/index.ts`, `src/store/flowStore.ts`, `src/App.tsx`, `e2e/golden-path.spec.ts`, and compatible project/source tests.
- Safety: real/paid provider request count `0`; no production data or credential was used.

### T028 — US1 green gate

- Status: complete.
- Passing tests:
  - `pnpm exec tsx tests/tool-catalog.test.ts` — 1/1 passed, covering exactly five groups, 19 ordered items, stable ids, descriptions, availability reasons and creation presets.
  - `pnpm exec tsx tests/canvas-creation.test.ts` — 1/1 passed, covering safe click placement, exact drag payloads, stale/read-only rejection and one-action creation.
  - `pnpm exec tsx tests/workbench-shell.test.ts` — 4/4 passed, including hover/pin/Escape/focus state and single-mounted workbench structure.
  - `pnpm exec tsx tests/project-tabs.test.ts` — 42/42 passed, including atomic history, read-only gates and updated ToolRail/right-Dock contracts.
  - `pnpm exec tsc --noEmit --pretty false` — passed with zero diagnostics.
  - `pnpm run test:e2e` — 33/33 passed in 1.7 minutes across 1024, 1280 and 1440 CSS-pixel desktop projects, including mouse/keyboard flyouts, disabled no-op, click/drag creation, right-Dock geometry, golden path and initial-draft recovery.
- Safety: real/paid provider request count `0`; Playwright used disposable PostgreSQL, temporary `DATA_DIR`, `APIYI_API_KEY=e2e-disabled`, loopback-only endpoints and a generation request guard.

### T029–T033 — US2 failing contracts

- Status: complete; all five test slices were written before the corresponding production implementation and observed failing for the intended missing behavior.
- Failing tests:
  - `pnpm exec tsx tests/project-tabs.test.ts` — failed because a staged connection was committed immediately instead of creating a non-persisted `ConnectionDraft`.
  - `pnpm exec tsx tests/dag.test.ts` — failed because the first-stage `detail` role was rejected before approval-node and material gates could be evaluated.
  - `pnpm exec tsx tests/workflow-schema.test.ts` — failed because v4 `approvedAt` was not transferred to the deterministic v5 stage-approval node.
  - `pnpm exec tsx tests/staged-try-on-ui.test.ts` — failed because the role confirmation dialog and independent stage-approval node did not exist.
  - `pnpm run test:e2e` — the isolated staged journey failed before any provider request because the current canvas had no usable semantic-role confirmation interaction; the run was stopped after the intended failure was captured rather than repeating it at every desktop width.
- Existing provider-contract coverage retained: person/outfit unique-source constraints, scene-analysis-only composition and raw scene-image exclusion, omitted accessory filler, category-specific low-weight accessory constraints, transient retry limit and zero-call invalid-input gates.
- Safety: real/paid provider request count `0`; Playwright used disposable PostgreSQL, temporary `DATA_DIR`, `APIYI_API_KEY=e2e-disabled`, loopback-only endpoints and a generation POST guard.
- Files: `tests/project-tabs.test.ts`, `tests/dag.test.ts`, `tests/workflow-schema.test.ts`, `tests/staged-try-on-ui.test.ts`, `e2e/workbench.spec.ts`.

### T034–T045 — US2 implementation and green gate

- Status: complete.
- Impact: repository `/Users/neihe/NEIHE-AI`, worktree `main`, index commit `cdbb9ea` (current commit matched; index marked stale because of the intended worktree edits). `FlowState` was CRITICAL with 156 impacted symbols and 69 affected flows as a lower bound; `InspectorPanel` was HIGH through `ContextPanel → Workspace → App`. `isDocumentConnectionValid`, `StageHandles`, `buildExecutionPlan`, `assertPlanInputs`, `extractOutputImages` and `extractParams` were LOW. New and object-property symbols returned UNKNOWN; source search resolved their concrete mounts/callers in CanvasFlow, WorkbenchShell, schema validation, template POST handling and focused tests.
- Outcome: staged drops create an in-memory `ConnectionDraft`; role confirmation writes exactly one edge/history entry, enforces explicit-role mismatch, per-role cardinality and a 14-image total, and is cleared on document changes. The first stage now supports the optional five-image `detail` role and increments `basisRevision` for semantic input, parameter, output and run changes. A dedicated approval node binds source id, baseline ref, basis revision and timestamp; refine validation derives current approval validity and blocks stale/unconfirmed/material-invalid requests before the provider boundary. Full model/size/material/construction settings live in the right inspector. Scene/person/outfit isolation and category-specific low-weight accessory prompts remain intact; absent accessory categories emit no filler. Saved/launched templates strip real images, outputs and approval facts.
- Passing tests:
  - `pnpm exec tsx tests/project-tabs.test.ts` — 45/45.
  - `pnpm exec tsx tests/dag.test.ts` — 29/29.
  - `pnpm exec tsx tests/workflow-schema.test.ts` — 29/29.
  - `pnpm exec tsx tests/staged-try-on-ui.test.ts` — passed.
  - `pnpm exec tsx tests/document-snapshot.test.ts` — passed.
  - `pnpm exec tsx tests/project-tabs-session.test.ts` — 28/28.
  - `pnpm exec tsx tests/scene-analysis.test.ts` — passed.
  - `pnpm exec tsx tests/provider-contract.test.ts` — 21/21.
  - `pnpm exec tsx tests/provider-retry.test.ts` — passed.
  - `pnpm exec tsx tests/exact-generation.test.ts` — 19/19, including transient retry and deterministic no-retry cases.
  - `pnpm exec tsc --noEmit --pretty false` — passed with zero diagnostics.
  - `pnpm run test:e2e` — 36/36 passed in 1.8 minutes across 1024, 1280 and 1440 desktop projects; the staged journey confirmed role-before-edge, approval binding and immediate stale relock.
- Safety: real/paid provider request count `0`; all browser tests used disposable PostgreSQL, temporary data, `APIYI_API_KEY=e2e-disabled`, loopback endpoints and a generation POST guard.
- Files: `src/lib/workflowPorts.ts`, `src/store/flowStore.ts`, `src/components/workbench/ConnectionRoleDialog.tsx`, `src/components/workbench/WorkbenchShell.tsx`, `src/components/nodes/StageApprovalNode.tsx`, `src/components/nodes/VirtualTryOnNode.tsx`, `src/components/nodes/index.ts`, `src/components/panels/InspectorPanel.tsx`, `src/types/workflow.ts`, `src/lib/documentSnapshot.ts`, `server/lib/workflowSchema.ts`, `server/engine/dag.ts`, `server/engine/runner.ts`, `server/routes/templates.ts`, `src/lib/templateLaunch.ts`, and the US2 tests.

### T046–T049 — US3 failing contracts

- Status: complete; pure layout, ten-state derivation and Results contracts first failed because `graphLayout.ts`/`nodeDisplayState.ts` did not exist and Results had no cross-project tab switch. The browser journey then exposed two real compatibility defects before turning green: the shared state dot had lost its legacy `title` and staged output edges declared `sourceHandle=image` while the source Handle had no matching id.
- Failing tests:
  - `node ./node_modules/tsx/dist/cli.mjs tests/graph-layout.test.ts` — module not found for `src/lib/graphLayout`.
  - `node ./node_modules/tsx/dist/cli.mjs tests/node-display-state.test.ts` — module not found for `src/lib/nodeDisplayState`.
  - `node ./node_modules/tsx/dist/cli.mjs tests/recent-results.test.ts` — Results source lacked project switching.
  - `pnpm run test:e2e` — first failed on the legacy success title, then on an unrenderable staged `sourceHandle=image`; both were fixed without provider calls.
- Safety: real/paid provider request count `0`; all E2E runs used disposable PostgreSQL, temporary `DATA_DIR`, `APIYI_API_KEY=e2e-disabled` and the generation POST guard.

### T050–T061 — US3 implementation and green gate

- Status: complete.
- Impact: `CanvasFlow` and `PulseEdge` were LOW; `CanvasZoomControls` and `ResultsPanel` were HIGH through Canvas/Workspace/App; `NodeFrame` was CRITICAL because ten node renderers call it directly. `VirtualTryOnNode` returned UNKNOWN and source search resolved its live registration plus approval-node consumption. Shared changes therefore remained additive/backward-compatible and were gated by full browser and history regressions.
- Outcome: deterministic topological layout refuses cycles and unmeasured nodes atomically, moves only the primary selection's undirected connected component, preserves the component center and writes one undo entry. CanvasFlow annotates controlled edges as upstream/downstream/unrelated/quiet and explicitly routes loaded edges through `PulseEdge`; only active runs animate and reduced-motion renders static feedback. NodeFrame derives exactly ten product states with Chinese labels while retaining legacy title semantics. Staged cards use compact role grids and stay below 70% of the T002 height baseline. Results remain globally preserved and switch to an already-open owning project before selection.
- Passing tests:
  - `node ./node_modules/tsx/dist/cli.mjs tests/graph-layout.test.ts` — all component/path/rank/cycle/size/no-overlap/center/untouched assertions passed.
  - `node ./node_modules/tsx/dist/cli.mjs tests/node-display-state.test.ts` — all ten states, precedence and unique Chinese labels passed.
  - `node ./node_modules/tsx/dist/cli.mjs tests/recent-results.test.ts` — 19/19.
  - `node ./node_modules/tsx/dist/cli.mjs tests/flow-history.test.ts` — 22/22, including one-entry auto-layout undo.
  - `node ./node_modules/tsx/dist/cli.mjs tests/workbench-shell.test.ts` — passed.
  - `node ./node_modules/tsx/dist/cli.mjs tests/selection-consistency.test.ts` — 11/11.
  - `node ./node_modules/typescript/bin/tsc --noEmit` — zero diagnostics.
  - `pnpm run test:e2e` — 36/36 passed in 1.8 minutes across 1024, 1280 and 1440 desktop projects. The same staged fixture stayed at or below `420.875 px` first-round and `637.4375 px` second-round in all three themes; path emphasis, reduced motion, component center, untouched component, viewport preservation, semantic role confirmation and stale approval were all asserted.
- Safety: real/paid provider request count `0`; no production data, credential, provider request, deployment or push occurred.
- Files: `src/lib/graphLayout.ts`, `src/lib/nodeDisplayState.ts`, `src/store/flowStore.ts`, `src/components/CanvasFlow.tsx`, `src/components/CanvasZoomControls.tsx`, `src/components/edges/PulseEdge.tsx`, `src/components/nodes/NodeFrame.tsx`, `src/components/nodes/VirtualTryOnNode.tsx`, `src/components/nodes/StageApprovalNode.tsx`, `src/components/panels/ResultsPanel.tsx`, `src/index.css`, `tests/graph-layout.test.ts`, `tests/node-display-state.test.ts`, `tests/recent-results.test.ts`, `tests/flow-history.test.ts`, `e2e/workbench.spec.ts`.

### T062–T085 — US4 recoverable drawing and typed palette flow

- Status: complete.
- Impact: fresh GitNexus worktree index contained 6,961 nodes, 18,842 edges, 306 clusters and 609 flows. `FlowState` was CRITICAL (178 upstream, 69 processes), `executeStep` and `InspectorPanel` were HIGH, `buildExecutionPlan` and `initializeDatabase` LOW. New router/component symbols returned UNKNOWN because they postdated the index; source search resolved `drawingBoardsRouter` to `server/index.ts` plus authorization tests and `DrawingBoardNode` to the node registry only. The user was warned before shared-store/runner/inspector edits.
- Outcome: DrawingDocument v1 is application-owned JSON with strict canvas/layer/object/point/text/document/export bounds, immutable local commands and point simplification. Konva/react-konva are exact pnpm dependencies and the editor is dynamically split. Owner/tab/project/documentEpoch/node/base-keyed IndexedDB drafts throttle at 500ms, recover only against a matching base and survive failed saves. Version POST/GET is owner-only, project/node/base bound, SHA-256-addressed by metadata and idempotent by client request id. Project saves transact board version and preview ownership; templates strip content, preview and export refs.
- UI: the fifth “创作工具” group now exposes drawing and color tools. The board supports brush, eraser, rectangle, ellipse, line, arrow, text, selection transformer and five layers with visibility/lock/opacity/order controls. Unsaved boards cannot connect. Save produces a same-origin PNG preview; export creates one separate image-input while retaining the editable board. The color tool supports quick/custom/recent/favorite/eyedropper selection and exact HEX/RGB/HSL parsing, always creates a new palette node and never mutates a selected node.
- Execution: palette edges carry typed colors, never reference images, and override recolor-node fallback colors. Fabric, color and combined modes have distinct prompts and pre-provider input gates. Committed board previews enter the normal owner-reauthorized image path.
- Focused tests: DrawingDocument 6/6; palette flow 5/5; draft-store 3/3; custom-color isolation 2/2; DAG 29/29; flow history 23/23; workflow schema 29/29; authorization 37/37; schema migration 15/15; project tab 45/45; project session 28/28; auth client and snapshot regressions passed.
- Build: TypeScript zero diagnostics; Vite transformed 2,480 modules. `DrawingEditor` is a separate 101.78 kB gzip chunk. Initial JS gzip is 158,222/210,000 bytes; CSS and single-chunk limits passed; server bundle completed at 448.6 kB.
- Browser validation: final isolated `pnpm run test:e2e` passed 39/39 in 2.0 minutes. At 1024, 1280 and 1440 CSS-pixel widths, the journey created a board by keyboard, added text and a layer, wrote/recovered an IndexedDB draft, saved an authenticated immutable version and PNG preview, exported one image node and created a new palette. The E2E request guard rejected any generation POST.
- Defects caught by the browser gate: generic `sm:max-w-sm` initially collapsed the two-column editor and was explicitly overridden; board saving initially trusted stale `hasBeenPersisted` state and now always saves the current project snapshot before version creation.
- Safety: cumulative real/paid provider request count `0`; no production credential, data, deployment, commit or push was used.
- Files: `server/lib/database.ts`, `server/lib/drawingBoard.ts`, `server/routes/drawingBoards.ts`, `server/routes/projects.ts`, `server/routes/templates.ts`, `server/engine/dag.ts`, `server/engine/runner.ts`, `src/components/drawing/*`, `src/components/nodes/DrawingBoardNode.tsx`, `src/components/nodes/ColorPaletteNode.tsx`, `src/components/nodes/FabricRecolorNode.tsx`, `src/components/panels/InspectorPanel.tsx`, `src/components/workbench/ColorToolPanel.tsx`, `src/components/workbench/ToolRail.tsx`, `src/components/workbench/WorkbenchShell.tsx`, `src/lib/colorPalette.ts`, `src/lib/colorTool.ts`, `src/lib/drawingBoardClient.ts`, `src/lib/drawingDraftStore.ts`, `src/store/customColors.ts`, `src/store/flowStore.ts`, `package.json`, `pnpm-lock.yaml`, focused tests and `e2e/workbench.spec.ts`.

### T086–T090 — US5 approval-gated video discovery

- Status: complete.
- Failing contract: `node node_modules/tsx/dist/cli.mjs tests/video-capabilities.test.ts` failed with `ERR_MODULE_NOT_FOUND` for the not-yet-created `src/lib/videoCapabilities` module.
- Impact: `ToolFlyout` was HIGH (1 direct/3 total, 2 affected processes through ToolRail, WorkbenchShell and Workspace). `TOOL_GROUPS` was UNKNOWN; source search resolved its production reads to ToolRail and its tests. The user was warned before edits. Integration only added descriptor-derived data attributes and left click, drag, hover, pin, Escape and focus-return behavior unchanged.
- Outcome: four stable descriptors expose individual Chinese purposes and distinct blocked reasons. The generic future resolver returns available only when independent specification id, generation-contract id, acceptance-record id, approval timestamp and a registered implementation intent are all present. Current catalog passes no approval or implementation, so every item is blocked with no creation intent. No video NodeKind, provider, route, upload, playback or export behavior was introduced.
- Passing tests: video capability contract passed; tool catalog remained 5 groups/19 items; workbench shell source contracts passed; TypeScript returned zero diagnostics. Final isolated Playwright matrix passed 42/42 in 2.1 minutes; at 1024/1280/1440 each of four items was activated alternately by forced mouse click and keyboard Enter while node count and observed POST requests stayed unchanged.
- Safety: video node creations `0`; video network requests `0`; real/paid provider requests `0`; E2E used a disposable database, temporary data directory, dummy provider key and generation POST guard.
- Files: `src/lib/videoCapabilities.ts`, `src/lib/toolCatalog.ts`, `src/types/workbench.ts`, `src/components/workbench/ToolFlyout.tsx`, `tests/video-capabilities.test.ts`, `e2e/workbench.spec.ts`, `package.json`.

### T091–T094 — Cross-story regression and registration gates

- Status: complete.
- Results: `tests/recent-results.test.ts` now explicitly pins right-Dock single mounting plus restore, cross-project selection, viewer, compare, download and set-as-input contracts; it passed 19/19. `tests/result-export.test.ts` passed 6/6, including stable names, retryable write failures and query/fragment stripping. The browser journey exercised view, compare, a real browser download event and creation of one new input node.
- Geometry/accessibility: every one of the five anchored menus is asserted inside the browser viewport at 1024, 1280 and 1440 CSS px. Long Chinese project/template/Results names, three themes, 3/4-column project grids, fixed two-column Results, right-Dock non-overlay geometry and reduced-motion suppression are asserted. `tests/e2e-safety.test.mjs` now requires named journeys per width and no longer depends on a fixed Playwright file count.
- Bundle: source boundaries assert that `DrawingEditor` is dynamically imported by `DrawingBoardNode` and absent from the static node registry. Budget constants are fixed at 210,000 initial gzip bytes and 500,000 bytes per JS chunk. Production output passed at 158,222 initial gzip bytes; `DrawingEditor` remained a separate 328.67 kB / 101.78 kB gzip chunk.
- Registration: all `tests/*.test.ts` files are present in `package.json#test:suite`; the isolation test scans the directory and fails closed if a future TypeScript contract test is omitted. Previously missing `tool-catalog`, `canvas-creation` and `staged-try-on-ui` entries were added.
- Safety: real/paid provider request count `0`.

### T095 — Complete isolated unit/integration command

- Status: command executed; repository baseline blocker remains.
- Command: `pnpm test` (equivalent package-manager entry for `npm run test` in this host) provisioned a dedicated PostgreSQL 18 Compose project, passed test-runner isolation, bundle-budget, bundle-boundary and E2E-safety gates, then stopped at `tests/claude-guardrail-hook.test.mjs` with exact error `ENOENT: no such file or directory, open '/Users/neihe/NEIHE-AI/.claude/settings.json'`.
- Cleanup: the runner stopped and removed its disposable database container, network and volume after the failure.
- Assessment: `.claude/settings.json` and `.claude/hooks/require-linked-worktree.mjs` are absent from the checked-out baseline and were not fabricated as product files. Tests after this guard were not reached by the aggregate command; their focused story gates and browser matrix are recorded separately above and below.
- Safety: real/paid provider request count `0`.

### T096–T097 — Static, build and browser gates

- TypeScript: `pnpm run lint` passed with zero diagnostics. The aggregate `pnpm run build` was attempted and stopped because this Codex runtime has no `npm` executable (`sh: npm: command not found`).
- Equivalent production build: `tsc -b`, Vite build, built-CSS verification, bundle-budget verification and server esbuild were run directly and all passed. Vite transformed 2,481 modules; initial JS gzip was 158,222/210,000 bytes; no JS chunk exceeded 500,000 bytes; server bundle was 448.5 kB.
- Whitespace: `git diff --check` passed.
- Desktop E2E: isolated Playwright passed 42/42 in 2.1 minutes across 1024, 1280 and 1440 projects. It covered long labels, all five tool menus within viewport bounds, three themes, reduced motion, compact staged nodes, role/approval flow, path/layout, right Dock, Results actions, drawing/palette and approval-gated video no-ops.
- Production smoke: the aggregate package command first stopped at the missing `npm` executable. After the already successful equivalent production build, the script's documented `--skip-build` path was run with pnpm supplied as `npm_execpath`; the isolated production server smoke passed 3/3 in 5.9 seconds and removed its temporary database/data afterward.
- Safety: Playwright used loopback-only endpoints, temporary `DATA_DIR`, disposable PostgreSQL and `APIYI_API_KEY=e2e-disabled`; real/paid provider request count `0`.

### T098 — Quickstart execution status and human evidence

- Status: automated and code-verifiable scenarios complete; T098 remains unchecked because the required moderated first-use study has no real participant evidence.
- Automated coverage: scenarios A–F are represented by the 42/42 desktop matrix and focused contracts: tool discovery/no-op, creation/right Dock, staged try-on, path/auto-layout, drawing/color and full Results regression. Persistence/migration, ownership, template sanitization and interrupted-draft recovery passed their focused integration/browser tests.
- Manual limitations: no production container restart, production database migration, real image generation or paid provider call was authorized or performed. Automated geometry and timing do not replace moderated observation.
- Human thresholds: SC-001 tool discovery `NOT VERIFIED` (0/20 participants); SC-002 role connection `NOT VERIFIED` (0/20); SC-005 path recognition `NOT VERIFIED` (0/20); SC-008 drawing workflow `NOT VERIFIED` (0/20). No participant result is inferred or fabricated.

### T099 — GitNexus final change analysis

- Status: complete. `node .gitnexus/run.cjs detect-changes --scope all --repo .` exited 0 and reported 48 changed indexed files, 423 changed symbols, 285 affected execution flows and overall `critical` risk. The output did not report `partial`, `truncated` or `UNKNOWN`.
- Representative affected flows: `Workspace → DocumentEdgeValue`, `Workspace → SameDocumentNode`, `CanvasFlow → DocumentMutationChanged`, `CanvasFlow → FlushActiveTextEdit`, `CanvasFlow → ReplaceTab`, `CanvasFlow → SelectActiveDocument`, `CanvasFlow → DocumentForTab`, `CanvasFlow → MatchesDocumentTarget`, `FinishOnBlur → ClearTextEditTimer` and `FinishOnBlur → DocumentForTarget`; 275 additional flows were reported.
- Resolution: critical shared-store, DAG/runner and workbench surfaces were already disclosed before edits and are covered by focused store/schema/DAG tests plus the 42/42 browser matrix. This final analysis is a release risk signal, not an all-clear or a substitute for review.

### T100 — Backup, rollback and release limitations

- Status: review complete; no deployment was performed.
- Migration boundary: this candidate adds drawing-board PostgreSQL schema migration 13. Before any production rebuild, both PostgreSQL 18 and `DATA_DIR` must be captured at one stopped-app restore point, with non-empty artifacts and SHA-256 verification. Code rollback alone is insufficient after migration; database rollback must restore the matching pre-upgrade PostgreSQL dump and `DATA_DIR` archive together.
- Rollback verification: after restoring the prior code/data pair, verify `/api/ready`, login, project reopen, Results, file download, drawing-board references and active-run reconciliation. Do not run `docker compose down -v` against the production project.
- Current host: the existing long-running `garment-canvas-app-1` and `garment-canvas-postgres-1` containers were observed healthy and were not rebuilt, restarted or modified by this implementation pass.
- Release limitations: T098 human study is `NOT VERIFIED`; the aggregate full suite is blocked by missing baseline `.claude` guard files; the aggregate build/smoke entry requires an `npm` executable although equivalent build and smoke paths passed. No commit, push, PR, tag, production backup/restore, database migration, production deployment, credential rotation or real/paid AI request occurred.
- Cumulative real/paid provider request count for this implementation: `0`.
