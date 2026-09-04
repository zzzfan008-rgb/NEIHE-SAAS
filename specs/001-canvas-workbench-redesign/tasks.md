---

description: "Dependency-ordered implementation tasks for the canvas workbench redesign"
---

# Tasks: 画布工作台 UI 整改

**Input**: Design documents from `/specs/001-canvas-workbench-redesign/`

**Prerequisites**: `plan.md`, `spec.md`, `research.md`, `data-model.md`, `contracts/`, `quickstart.md`

**Tests**: Required. The feature specification defines independent acceptance tests, and the constitution requires test-first delivery for schema, persistence, authorization and desktop UI behavior.

**Organization**: Tasks are grouped by user story and follow the explicit dependency graph below. A story is independently validated after its declared prerequisites rather than being assumed to depend on Foundation alone.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel after its listed prerequisites because it edits different files.
- **[Story]**: Maps the task to a user story from `spec.md`.
- Every source-edit task must first run GitNexus upstream impact analysis for the named symbols and record the result in `specs/001-canvas-workbench-redesign/implementation-evidence.md`; HIGH/CRITICAL must be reported before editing and UNKNOWN must be resolved with source search.
- Every test task must be written first and observed failing for the intended reason before the matching implementation task begins.
- No task authorizes production deployment, production data access or real/paid AI calls.

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Establish implementation evidence and immutable pre-redesign measurement baselines without changing product behavior.

- [X] T001 Create the implementation evidence ledger with current GitNexus repository status, per-task impact fields, test evidence fields and paid-request accounting in `specs/001-canvas-workbench-redesign/implementation-evidence.md`
- [X] T002 Before any node compaction, capture fixed first/second-round fixture content plus `getBoundingClientRect().height` baselines at 1024/1280/1440 CSS px in the current theme, including browser version and viewport evidence, in `specs/001-canvas-workbench-redesign/implementation-evidence.md`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Establish workflow schema v5, typed ports and canonical persistence boundaries required by every story.

**CRITICAL**: No user-story implementation starts until this phase passes its focused tests.

### Foundational tests

- [X] T003 [P] Add failing v5 migration, new NodeKind, typed port, legal-role and future-version rejection cases in `tests/workflow-schema.test.ts`
- [X] T004 [P] Add failing whitelist round-trip tests for text, drawing-board, color-palette, stage-approval, basis revision and typed edge roles in `tests/document-snapshot.test.ts`
- [X] T005 [P] Add failing browser-session recovery tests for all v5 node fields and exclusion of UI/editor draft state in `tests/project-tabs-session.test.ts`
- [X] T006 [P] Add failing canonical document-boundary assertions for ConnectionDraft, Dock/flyout state and drawing recovery state in `tests/active-document-boundary.test.ts`

### Foundational implementation

- [X] T007 Define schema v5 NodeKind unions, typed `NodePortSpec`, `WorkflowInputRole`, new node data types and derived NODE_SPECS limits in `src/types/workflow.ts`, and create the story-neutral value-kind compatibility/payload foundation in `src/lib/workflowPorts.ts`
- [X] T008 [P] Extend the explicit document whitelist and v5 persisted conversion for all new node/edge fields in `src/lib/documentSnapshot.ts` after T007
- [X] T009 [P] Implement generic v4-to-v5 node/edge migration, typed-port structural validation and future-version fail-closed behavior in `server/lib/workflowSchema.ts` after T007
- [X] T010 Update node defaults, session normalization and recovery for v5 while excluding transient UI/editor state in `src/store/flowStore.ts` after T007–T009
- [X] T011 Define non-persisted `ToolGroup`, `ToolItem`, `CanvasCreationIntent`, `ConnectionDraft` and DocumentTarget-scoped command types in `src/types/workbench.ts`
- [X] T012 Run the foundational tests T003–T006 and record passing commands, migration fixtures and zero paid requests in `specs/001-canvas-workbench-redesign/implementation-evidence.md`

**Checkpoint**: v5 documents round-trip deterministically, legacy flows migrate without guessing roles, and transient workbench/editor state cannot enter ProjectTab snapshots.

---

## Phase 3: User Story 1 — 通过五组工具快速添加能力 (Priority: P1) MVP

**Goal**: Provide exactly five discoverable tool groups with stable hover/click/keyboard flyouts, safe click/drag creation and explicit unavailable states.

**Independent Test**: In an empty project, open all five groups with mouse and keyboard, create every available item once, and verify unavailable items create no node, revision, network request or usage record.

### Tests for User Story 1

- [X] T013 [P] [US1] Add failing catalog tests for exactly five groups, 19 ordered items, availability reasons and creation intents in `tests/tool-catalog.test.ts`
- [X] T014 [P] [US1] Replace old two-left-Dock reducer assertions with failing hover, delayed close, pin, Escape and focus-restoration state cases in `tests/workbench-shell.test.ts`
- [X] T015 [P] [US1] Add failing safe-position, drag-position, read-only, stale DocumentTarget and one-history-entry cases in `tests/canvas-creation.test.ts`
- [X] T016 [P] [US1] Add failing mouse/keyboard flyout, rapid traversal, disabled-item, click/drag creation and navigation/preview zero-provider-request journeys in `e2e/workbench.spec.ts`

### Implementation for User Story 1

- [X] T017 [P] [US1] Implement the five-group data catalog, stable item ids, capability descriptions, initial availability and creation presets in `src/lib/toolCatalog.ts`
- [X] T018 [P] [US1] Add the project-local Base UI/shadcn Popover primitive with collision-aware positioning and semantic tokens in `src/components/ui/popover.tsx`
- [X] T019 [P] [US1] Implement pure hover/open/pinned/right-Dock reducer transitions and focus-return metadata in `src/components/workbench/workbenchState.ts`
- [X] T020 [US1] Implement the anchored rich tool flyout, unavailable reason behavior and click/drag item actions in `src/components/workbench/ToolFlyout.tsx` after T017–T019
- [X] T021 [US1] Implement the five-trigger vertical toolbar with roving tabindex, Arrow/Home/End navigation and Enter/Space/Escape behavior in `src/components/workbench/ToolRail.tsx` after T020
- [X] T022 [P] [US1] Implement the DocumentTarget-scoped canvas creation event bridge and serialized drag payload in `src/lib/canvasCreation.ts`
- [X] T023 [US1] Resolve creation intents, calculate the nearest visible non-overlapping click position and preserve exact drop positions in `src/components/CanvasFlow.tsx` after T022
- [X] T024 [P] [US1] Implement the editable, non-running text node with concise canvas presentation in `src/components/nodes/TextInputNode.tsx`
- [X] T025 [US1] Register `text-input`, add its default data and keep creation atomic/read-only-safe in `src/components/nodes/index.ts` and `src/store/flowStore.ts` after T024
- [X] T026 [US1] Replace the old node-library rail entry with ToolRail/ToolFlyout while keeping Canvas and context subtrees single-mounted in `src/components/workbench/WorkbenchShell.tsx` after T020–T025
- [X] T027 [US1] Wire the catalog to CanvasFlow, the existing lazy AssetPicker and the advanced staged-try-on template launcher in `src/App.tsx` and `src/lib/templateLaunch.ts`
- [X] T028 [US1] Run T013–T016 plus `tests/project-tabs.test.ts` and record the independently passing US1 evidence in `specs/001-canvas-workbench-redesign/implementation-evidence.md`

**Checkpoint**: US1 is deployable as a UI-only MVP with five groups, safe creation and zero-side-effect disabled items.

---

## Phase 4: User Story 2 — 清晰完成双模型分步换装 (Priority: P2)

**Goal**: Make semantic roles explicit, expose a separate approval gate, invalidate stale approval immediately and block every invalid paid run before provider access.

**Independent Test**: Connect person, scene, outfit and optional role references, generate a stub first round, confirm it in a separate node, unlock refinement, then change/re-run the first round and verify immediate relock with provider request count zero for invalid attempts.

### Tests for User Story 2

- [X] T029 [P] [US2] Add failing role-confirmation, duplicate/mismatch/total-limit, tab-switch invalidation and atomic-edge history cases in `tests/project-tabs.test.ts`
- [X] T030 [P] [US2] Add failing stage-approval pass-through, stale basis, material requirements, role ordering and zero-provider-request cases in `tests/dag.test.ts`; add final provider-payload regressions for person/outfit sole-source rules, scene-analysis-only composition, raw scene-image exclusion and absent-accessory no-filler behavior in `tests/scene-analysis.test.ts` and `tests/provider-contract.test.ts`
- [X] T031 [P] [US2] Add failing idempotent migration cases that insert one deterministic stage-approval node for valid v4 confirmed refinements in `tests/workflow-schema.test.ts`
- [X] T032 [P] [US2] Add failing compact role-row, connected-source, independent approval and Chinese business-error UI contracts in `tests/staged-try-on-ui.test.ts`
- [X] T033 [P] [US2] Add failing end-to-end role confirmation, first-round approval, stale relock and invalid-input request-count scenarios in `e2e/workbench.spec.ts`

### Implementation for User Story 2

- [X] T034 [P] [US2] Extend the foundational `src/lib/workflowPorts.ts` contract with staged role labels/cardinality, single-role rules and staged source payload helpers
- [X] T035 [US2] Add pending ConnectionDraft lifecycle, role-aware `isDocumentConnectionValid` checks and one-edge confirmation action in `src/store/flowStore.ts` after T034
- [X] T036 [P] [US2] Implement the role confirmation dialog with compatible unused roles, mismatch errors, cancel no-op and focus restoration in `src/components/workbench/ConnectionRoleDialog.tsx`
- [X] T037 [US2] Implement atomic `basisRevision` increments for first-round input/parameter/output changes and every re-run in `src/store/flowStore.ts` after T035
- [X] T038 [P] [US2] Implement the independent stage-approval node, derived waiting/confirmable/confirmed/stale states and approved-image pass-through UI in `src/components/nodes/StageApprovalNode.tsx`
- [X] T039 [US2] Add the first-round detail handle, all required/optional role rows, connected-source summaries and concise stage actions in `src/components/nodes/VirtualTryOnNode.tsx` after T034–T038
- [X] T040 [US2] Move full staged model, size, approval review, material and construction controls into the fixed property editor in `src/components/panels/InspectorPanel.tsx`
- [X] T041 [P] [US2] Enforce staged allowed roles, single-role cardinality, 14-reference total and deterministic approval-node migration in `server/lib/workflowSchema.ts`
- [X] T042 [P] [US2] Resolve stage-approval output, preserve targetHandle role ordering and reject stale/unconfirmed/material-invalid plans before provider access in `server/engine/dag.ts`
- [X] T043 [P] [US2] Preserve person/outfit/scene isolation, omit absent-accessory filler text and add low-weight category-specific accessory constraints in `server/engine/runner.ts`
- [X] T044 [US2] Sanitize approval facts and real references in saved templates and preserve advanced-template launch semantics in `server/routes/templates.ts` and `src/lib/templateLaunch.ts`
- [X] T045 [US2] Register stage-approval and complete T029–T033 plus provider-retry regression evidence in `src/components/nodes/index.ts` and `specs/001-canvas-workbench-redesign/implementation-evidence.md`

**Checkpoint**: US2 runs independently with explicit roles and a visible approval gate; invalid/stale attempts produce zero paid requests and never switch models or delete inputs.

---

## Phase 5: User Story 3 — 在低噪音画布中理解复杂流程 (Priority: P3)

**Goal**: Deliver compact nodes, semantic path emphasis, a fixed collapsible right Inspector/Results Dock and deterministic selected-workflow auto layout.

**Independent Test**: Open a representative two-stage workflow at 1024/1280/1440 in all three themes, verify compact summaries and path recognition, edit full parameters in the right Dock, auto-layout one connected component, and confirm Results is unchanged.

### Tests for User Story 3

- [X] T046 [P] [US3] Add failing connected-component, upstream/downstream set, deterministic rank, cycle refusal, no-overlap, center preservation and untouched-component tests in `tests/graph-layout.test.ts`
- [X] T047 [P] [US3] Add failing exhaustive precedence/current-basis cases for all ten derived `NodeDisplayState` values in `tests/node-display-state.test.ts`, plus right-Dock geometry, width-zero/inert collapse, single-mount Canvas/ContextPanel and focus-return contracts in `tests/workbench-shell.test.ts`
- [X] T048 [P] [US3] Add failing Results keepMounted, selection switching and cross-project record-preservation assertions in `tests/recent-results.test.ts`
- [X] T049 [P] [US3] Add failing three-width/three-theme compact-node, path emphasis, reduced-motion, Dock and auto-layout geometry journeys in `e2e/workbench.spec.ts`, including exact same-fixture assertions that first/second-round node heights are no more than 70% of the T002 baseline

### Implementation for User Story 3

- [X] T050 [P] [US3] Implement pure connected-component, directed path and deterministic measured-node layout algorithms in `src/lib/graphLayout.ts`
- [X] T051 [US3] Add a primary-selection-scoped atomic auto-layout action with no-selection/cycle errors and one undo entry in `src/store/flowStore.ts` after T050
- [X] T052 [US3] Compute path-emphasis metadata, expose the auto-layout control and preserve viewport during component moves in `src/components/CanvasFlow.tsx` after T050–T051
- [X] T053 [P] [US3] Render selected upstream/downstream emphasis, unrelated-edge quiet state and reduced-motion-safe run feedback in `src/components/edges/PulseEdge.tsx`
- [X] T054 [P] [US3] Implement the pure ten-state derivation and Chinese label/icon mapping in `src/lib/nodeDisplayState.ts`, then refactor the shared node shell into compact header, summary, primary action, latest output and concise error slots in `src/components/nodes/NodeFrame.tsx`
- [X] T055 [P] [US3] Convert generation nodes to the compact NodeFrame contract in `src/components/nodes/SketchToRenderNode.tsx`, `src/components/nodes/AiModifyNode.tsx`, `src/components/nodes/FabricRecolorNode.tsx`, `src/components/nodes/PrintExtractNode.tsx` and `src/components/nodes/PrintMutateNode.tsx` after T054
- [X] T056 [P] [US3] Convert input/output/edit nodes to the compact NodeFrame contract in `src/components/nodes/ImageInputNode.tsx`, `src/components/nodes/UpscaleNode.tsx`, `src/components/nodes/MaskRedrawNode.tsx`, `src/components/nodes/ResultNode.tsx`, `src/components/nodes/VirtualTryOnNode.tsx` and `src/components/nodes/StageApprovalNode.tsx` after T054
- [X] T057 [US3] Keep complete properties and Results details mounted while updating the selected node in place in `src/components/panels/ContextPanel.tsx`, `src/components/panels/InspectorPanel.tsx` and `src/components/panels/ResultsPanel.tsx`
- [X] T058 [US3] Move ContextPanel to a real right-side collapsible layout slot and eliminate the old left business Dock without remounting children in `src/components/workbench/WorkbenchShell.tsx`
- [X] T059 [US3] Add right-Dock toggle/focus behavior and keep Results/Canvas composition stable in `src/App.tsx` after T057–T058
- [X] T060 [P] [US3] Replace hard-coded workbench/node/edge colors with existing `--gc-*` semantic tokens and add three-theme/reduced-motion styles in `src/index.css`
- [X] T061 [US3] Run T046–T049 plus selection, flow-history, theme and Results regressions and record US3 evidence in `specs/001-canvas-workbench-redesign/implementation-evidence.md`

**Checkpoint**: After US1 and US2 prerequisites, US3 proves low-noise comprehension, right-side detailed editing, one-component layout and full Results preservation.

---

## Phase 6: User Story 4 — 在画板中创作并快速复用颜色 (Priority: P4)

**Goal**: Provide a recoverable layered drawing board and explicit palette-node color flow without polluting global history or silently mutating selected nodes.

**Independent Test**: Draw, erase, edit shapes/text/layers, recover an interrupted draft, save once, export an image, create a three-color palette and connect it to color replacement; refresh and verify all committed content with zero AI calls before an explicit valid run.

### Tests for User Story 4

- [x] T062 [P] [US4] Add failing DrawingDocument validation, limits, point simplification, local command-history and deterministic keyboard-command tests in `tests/drawing-board.test.ts`
- [x] T063 [P] [US4] Add failing first-apply, idempotent reapply, table/index/constraint and transaction-rollback migration cases in `tests/schema-migrations.test.ts`, plus board-version idempotency, ownership, non-disclosing read and project/node/base mismatch cases in `tests/authorization.test.ts`
- [x] T064 [P] [US4] Add failing board-session one-global-history, failed-save retention, owner-keyed IndexedDB recovery, epoch mismatch, draft exclusion, logout cleanup and A→logout→B→A account-switch isolation cases in `tests/flow-history.test.ts`, `tests/project-tabs-session.test.ts` and `tests/auth-client.test.ts`
- [x] T065 [P] [US4] Add failing palette normalization, exact HEX/RGB/HSL parsing and rejection rules, create-only behavior, authenticated recent/custom/favorite isolation across logout/account switch, typed colors edge, committed drawing-board image output and DAG parameter/reference-snapshot cases in `tests/palette-flow.test.ts`, `tests/custom-colors.test.ts` and `tests/dag.test.ts`
- [x] T066 [P] [US4] Add failing keyboard-only drawing/layer/text/color paths, visible-focus restoration, edit/recover/save/direct-board-connect/export and palette/no-direct-mutation journeys in `e2e/workbench.spec.ts`

### Implementation for User Story 4

- [x] T067 [US4] Add PostgreSQL drawing-document version and idempotency tables, indexes and rollback-safe migration checks in `server/lib/database.ts`
- [x] T068 [P] [US4] Implement canonical DrawingDocument validation, size/layer/object/point/text/export limits and SHA-256 hashing in `server/lib/drawingBoard.ts`
- [x] T069 [US4] Implement authenticated POST/GET board-version routes with owner/project/node/base checks and non-disclosing failures in `server/routes/drawingBoards.ts` and register them in `server/index.ts` after T067–T068
- [x] T070 [P] [US4] Implement typed board version load/save client calls and bounded error mapping in `src/lib/drawingBoardClient.ts`
- [x] T071 [P] [US4] Implement owner/tab/project/documentEpoch/node/base-ref-keyed IndexedDB draft save, recovery, discard, quota handling and logout cleanup in `src/lib/drawingDraftStore.ts`
- [x] T072 [P] [US4] Implement the application-owned DrawingDocument DTO, immutable edit commands, point simplification and board-local undo/redo in `src/components/drawing/drawingModel.ts` and `src/components/drawing/drawingHistory.ts`
- [x] T073 [US4] Add compatible `konva` and `react-konva` dependencies and preserve exact lockfile changes in `package.json` and `package-lock.json`
- [x] T074 [US4] Implement the dynamically loaded accessible Konva board surface, keyboard-reachable brush/eraser/shapes/text overlay, selection transformer and five-layer controls in `src/components/drawing/DrawingEditor.tsx` after T070–T073
- [x] T075 [US4] Implement board open/recover/save failure handling, DocumentTarget revalidation, preview display and edit action in `src/components/nodes/DrawingBoardNode.tsx` after T069–T074
- [x] T076 [P] [US4] Implement keyboard-accessible quick/custom/recent/favorite/eyedropper selection plus exact `#RGB`/`#RRGGBB`/`rgb()`/`hsl()` parsing that returns canonical uppercase swatches or a bounded Chinese validation error without mutating existing nodes in `src/components/workbench/ColorToolPanel.tsx`
- [x] T077 [P] [US4] Scope recent/custom/favorite color preferences to the authenticated account and preserve safe logout/account-switch behavior in `src/store/customColors.ts`
- [x] T078 [US4] Implement atomic drawing-board commit, preview/export image-node creation and color-palette creation actions with DocumentTarget guards in `src/store/flowStore.ts` after T070–T077
- [x] T079 [P] [US4] Implement concise swatch summaries and typed colors output in `src/components/nodes/ColorPaletteNode.tsx`
- [x] T080 [US4] Resolve a committed drawing-board preview as a reauthorized ordinary `image` reference and connected palette payloads as execution parameters rather than reference images, enforcing compatible board-output and `palette` target ports in `server/engine/dag.ts` and `src/lib/workflowPorts.ts`
- [x] T081 [US4] Add `operationMode` behavior and connected-palette precedence to the color/fabric consumer UI and runner in `src/components/nodes/FabricRecolorNode.tsx`, `src/components/panels/InspectorPanel.tsx` and `server/engine/runner.ts`
- [x] T082 [US4] Verify and transact board content/preview ownership during project save/copy/delete recovery, and strip owner refs from templates in `server/routes/projects.ts` and `server/routes/templates.ts`
- [x] T083 [US4] Render same-origin PNG previews, reuse validated file upload, export one separate image-input node and keep the board editable in `src/components/drawing/DrawingEditor.tsx` and `src/store/flowStore.ts`
- [x] T084 [US4] Register drawing-board and color-palette renderers/defaults and expose complete board/palette properties in `src/components/nodes/index.ts`, `src/store/flowStore.ts` and `src/components/panels/InspectorPanel.tsx`
- [x] T085 [US4] Run T062–T066 plus bundle, authorization, project-save and template regressions and record US4 evidence in `specs/001-canvas-workbench-redesign/implementation-evidence.md`

**Checkpoint**: US4 independently provides recoverable local creation, one project commit per edit session, explicit palette flow and zero implicit AI activity.

---

## Phase 7: User Story 5 — 安全发现视频制作入口 (Priority: P5)

**Goal**: Show the four requested video workflows with accurate unavailable reasons and a fail-closed capability gate that cannot create or run unapproved nodes.

**Independent Test**: Open the video group, inspect all four items, activate each by mouse and keyboard, and verify node/edge/revision/network/usage counts remain unchanged.

### Tests for User Story 5

- [x] T086 [P] [US5] Add failing all-disabled, reason-required and unapproved-capability fail-closed tests in `tests/video-capabilities.test.ts`
- [x] T087 [P] [US5] Add failing mouse/keyboard activation and zero-mutation/network/usage video-group journey in `e2e/workbench.spec.ts`

### Implementation for User Story 5

- [x] T088 [P] [US5] Implement the four explicit unavailable capability descriptors and an approval-gated future enablement interface in `src/lib/videoCapabilities.ts`
- [x] T089 [US5] Feed video capability descriptors into the Video ToolFlyout without defining enabled video NodeKinds in `src/lib/toolCatalog.ts` and `src/components/workbench/ToolFlyout.tsx`
- [x] T090 [US5] Run T086–T087 and record zero-node, zero-network and zero-paid-request evidence in `specs/001-canvas-workbench-redesign/implementation-evidence.md`

**Checkpoint**: US5 is independently testable as a safe discovery surface; no video execution capability is implied or enabled.

---

## Phase 8: Polish & Cross-Cutting Concerns

**Purpose**: Complete cross-story accessibility, regression, bundle, migration and graph gates without expanding scope.

- [x] T091 [P] Add explicit full Results restore/view/compare/download/set-as-input regression coverage for the new right Dock in `tests/recent-results.test.ts`, `tests/result-export.test.ts` and `e2e/workbench.spec.ts`
- [x] T092 Add long-Chinese-label, boundary collision, 1024/1280/1440 geometry, three-theme and reduced-motion assertions in `tests/workbench-shell.test.ts`, `tests/theme-contract.test.ts` and `e2e/workbench.spec.ts`, then update `tests/e2e-safety.test.mjs` to require the named safety journeys without relying on a brittle fixed Playwright file count, after T091
- [x] T093 [P] Add lazy drawing-chunk, 210KB initial gzip and 500KB single-chunk regression assertions in `tests/bundle-boundaries.test.mjs` and `tests/bundle-budget.test.mjs`
- [x] T094 Register every new TypeScript contract test in the explicit `test:suite` script in `package.json`—including tool-catalog, canvas-creation, staged-try-on-ui, node-display-state, graph-layout, drawing-board, palette-flow, custom-colors and video-capabilities—and update `tests/test-runner-isolation.test.mjs` so a newly added but unregistered test fails the gate
- [x] T095 Run the complete isolated unit/integration suite with `npm run test` and record exact failures/passes and paid request count in `specs/001-canvas-workbench-redesign/implementation-evidence.md` after T094
- [x] T096 Run `npm run lint`, `npm run build` and `git diff --check`, then record TypeScript, bundle-budget and whitespace results in `specs/001-canvas-workbench-redesign/implementation-evidence.md`
- [x] T097 Run the 1024/1280/1440 Playwright matrix with `npm run test:e2e` and the safe production smoke with `npm run test:e2e:production`, recording geometry and zero-real-AI evidence in `specs/001-canvas-workbench-redesign/implementation-evidence.md`
- [ ] T098 Execute every automated/manual scenario and the defined at-least-20-participant first-use study in `specs/001-canvas-workbench-redesign/quickstart.md`, recording anonymized aggregate results and any unmet SC-001/SC-002/SC-005/SC-008 thresholds in `specs/001-canvas-workbench-redesign/implementation-evidence.md` without converting missing human evidence into a pass
- [x] T099 Run complete GitNexus change analysis with `node .gitnexus/run.cjs detect-changes --scope all --repo .`, resolve partial/truncated/UNKNOWN results, and record affected processes in `specs/001-canvas-workbench-redesign/implementation-evidence.md`
- [x] T100 Review migration backup/rollback requirements, confirm no production deploy or paid request occurred, and finalize release limitations in `specs/001-canvas-workbench-redesign/implementation-evidence.md`

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 Setup**: Starts immediately.
- **Phase 2 Foundation**: Depends on Phase 1 and blocks every user story.
- **US1 (Phase 3)**: Starts after Foundation; it is the suggested UI-only MVP.
- **US2 (Phase 4)**: Starts after Foundation. Its ToolFlyout entry uses US1, but the staged workflow remains independently testable through fixtures/templates.
- **US3 (Phase 5)**: Starts after US1 and US2. It compacts `StageApprovalNode` and shares WorkbenchShell/CanvasFlow integration with US1, so it is not independently executable before those stories.
- **US4 (Phase 6)**: Starts after Foundation. Core board/palette behavior is independently testable; catalog discoverability integration follows US1.
- **US5 (Phase 7)**: Starts after US1 catalog/flyout infrastructure.
- **Polish (Phase 8)**: Starts after every story selected for release is complete.

### User Story Dependency Graph

```text
Setup → Foundation ┬→ US1 (MVP) ─────────────→ US5
                   ├→ US2 ───────┐
                   └→ US4        │
US1 + US2 ──────────────────────→ US3

US4 core behavior starts after Foundation; only its catalog-discoverability integration waits for US1.

US1 + US2 + US3 + US4 + US5 → Polish
```

### Within Each User Story

1. Add the listed failing tests and confirm failure reason.
2. Run/record GitNexus upstream impact before each named symbol edit.
3. Implement types/models before store/services, store/services before UI/routes, and core behavior before integration.
4. Run the story's focused test checkpoint before beginning the next priority.
5. Never use real provider credentials; invalid and non-AI flows must record provider request count 0.

### Parallel Opportunities

- T003–T006 can run in parallel; T008 and T009 can run in parallel after T007.
- US1 test tasks T013–T016 and implementation tasks T017–T019/T022/T024 can run in parallel within their dependency boundaries.
- US2 tests T029–T033 can run in parallel; UI components T036/T038 and server tasks T041–T043 can run in parallel after shared role types exist.
- After US2, US3 tests T046–T049 can run in parallel; T053/T054/T060 can run in parallel, followed by parallel node conversions T055/T056.
- US4 tests T062–T066 can run in parallel; T068/T070–T073/T076–T077 can run in parallel, followed by the integration chain.
- US5 tests T086–T087 and descriptor implementation T088 can be prepared in parallel after US1.
- T091 and T093 can run in parallel; T092 follows T091 because both edit `e2e/workbench.spec.ts`. T094 then registers every new contract test before final gates T095–T100.

---

## Parallel Example: User Story 1

```text
Task T013: tests/tool-catalog.test.ts
Task T014: tests/workbench-shell.test.ts
Task T015: tests/canvas-creation.test.ts
Task T016: e2e/workbench.spec.ts

After tests fail and shared types exist:
Task T017: src/lib/toolCatalog.ts
Task T018: src/components/ui/popover.tsx
Task T019: src/components/workbench/workbenchState.ts
Task T022: src/lib/canvasCreation.ts
Task T024: src/components/nodes/TextInputNode.tsx
```

## Parallel Example: User Story 2

```text
Task T036: src/components/workbench/ConnectionRoleDialog.tsx
Task T038: src/components/nodes/StageApprovalNode.tsx
Task T041: server/lib/workflowSchema.ts
Task T042: server/engine/dag.ts
Task T043: server/engine/runner.ts
```

## Parallel Example: User Story 3

```text
Task T053: src/components/edges/PulseEdge.tsx
Task T054: src/components/nodes/NodeFrame.tsx
Task T060: src/index.css

After T054:
Task T055: generation node components
Task T056: input/output/edit node components
```

## Parallel Example: User Story 4

```text
Task T068: server/lib/drawingBoard.ts
Task T070: src/lib/drawingBoardClient.ts
Task T071: src/lib/drawingDraftStore.ts
Task T072: src/components/drawing/drawingModel.ts and drawingHistory.ts
Task T073: package.json and package-lock.json
Task T076: src/components/workbench/ColorToolPanel.tsx
Task T077: src/store/customColors.ts
```

## Parallel Example: User Story 5

```text
Task T086: tests/video-capabilities.test.ts
Task T087: e2e/workbench.spec.ts
Task T088: src/lib/videoCapabilities.ts
```

---

## Implementation Strategy

### MVP First — User Story 1

1. Complete Setup and Foundation.
2. Complete US1 tests and five-group tool infrastructure.
3. Stop and validate the US1 independent test with dummy providers.
4. Demo locally without production deployment.

### Incremental Delivery

1. **US1**: tool discovery, safe creation and disabled states.
2. **US2**: semantic staged try-on and independent approval.
3. **US3**: compact nodes, path/layout and right Dock.
4. **US4**: drawing and palette creation.
5. **US5**: explicit video discovery safety.
6. **Polish**: full matrix, migration, Results, bundle and graph gates.

Each checkpoint must remain independently runnable; a later story may integrate with earlier UI infrastructure but may not silently weaken its contracts.

### Scope Control

- Do not implement video upload/generation, white-background generation or style-transfer execution in this feature.
- Do not add a second persisted role field beside `targetHandle`.
- Do not inline Konva Stage JSON or recovery drafts into ProjectTab/DocumentSnapshot.
- Do not directly mutate a selected node when choosing colors.
- Do not change provider retry limits, model switching rules or production deployment configuration.

## Notes

- `[P]` means files and incomplete dependencies do not conflict; it does not waive impact analysis or focused tests.
- Existing user data/templates must be migrated or sanitized through code; do not edit files under `data/templates/user/` directly.
- Commit only after focused tests and GitNexus detect-changes are clean; this task list itself does not authorize a commit.
- Stop at any checkpoint if a HIGH/CRITICAL graph risk, authorization ambiguity, migration data-loss risk or real-provider configuration is discovered.
