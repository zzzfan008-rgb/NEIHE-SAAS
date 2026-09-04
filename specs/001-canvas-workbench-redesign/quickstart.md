# Quickstart Validation Guide

This guide is for validating the implemented feature. It does not authorize production deployment or real AI generation.

## 1. Prerequisites

- Run from `/Users/neihe/NEIHE-AI`.
- Node.js 22.20 or newer and the repository lockfile dependencies installed.
- Docker Desktop running for the isolated PostgreSQL test database.
- No production database URL, production DATA_DIR or real APIYI key in the test shell.
- Review [UI interaction contract](./contracts/ui-interaction-contract.md), [workflow document contract](./contracts/workflow-document-contract.md), [drawing board contract](./contracts/drawing-board-contract.md) and [data model](./data-model.md).

Before implementation edits, run the required GitNexus upstream impact check for each touched symbol. HIGH/CRITICAL results must be reported before editing; UNKNOWN must be resolved with source verification.

## 2. Install and static gates

```bash
pnpm install --frozen-lockfile
pnpm run lint
pnpm run build
```

Expected:

- TypeScript and both web/server builds succeed.
- Initial JavaScript gzip remains at or below 210,000 bytes.
- No JavaScript chunk exceeds 500,000 bytes.
- Konva/react-konva are loaded only in the drawing editor chunk, not in the initial workbench entry.

## 3. Focused contract tests

Run the focused pure and contract tests first:

```bash
npx tsx tests/tool-catalog.test.ts
npx tsx tests/canvas-creation.test.ts
npx tsx tests/workbench-shell.test.ts
npx tsx tests/staged-try-on-ui.test.ts
npx tsx tests/node-display-state.test.ts
npx tsx tests/graph-layout.test.ts
npx tsx tests/drawing-board.test.ts
npx tsx tests/palette-flow.test.ts
npx tsx tests/custom-colors.test.ts
npx tsx tests/video-capabilities.test.ts
npx tsx tests/document-snapshot.test.ts
npx tsx tests/workflow-schema.test.ts
npx tsx tests/dag.test.ts
npx tsx tests/scene-analysis.test.ts
npx tsx tests/provider-contract.test.ts
npx tsx tests/schema-migrations.test.ts
npx tsx tests/auth-client.test.ts
npx tsx tests/flow-history.test.ts
npx tsx tests/project-tabs-session.test.ts
npx tsx tests/selection-consistency.test.ts
```

Expected evidence:

- exactly five tool groups and every unavailable item has zero mutation/network side effects;
- hover/pin/Escape/focus state is deterministic;
- v4 documents migrate idempotently to v5 and new fields survive save/reload;
- invalid roles, duplicate roles, stale approval and palette/image type mismatch are rejected before a paid plan;
- the final staged provider payload uses person/outfit as sole sources, contains only bounded scene analysis rather than the raw scene image, and emits no filler for absent accessory roles;
- drawing-board PostgreSQL migrations pass first-apply, idempotent reapply, schema/index/constraint and rollback tests;
- automatic layout changes one connected component only and creates one history item;
- board strokes stay out of project history and one successful editing session creates one item;
- recovery drafts stay out of DocumentSnapshot and browser ProjectTab shards, and neither board drafts nor color preferences cross authenticated accounts;
- every new contract test is registered in `package.json#test:suite`; the test-runner isolation gate fails when a test is added but omitted.

## 4. Full isolated test suites

```bash
pnpm run test
pnpm run test:e2e
```

The repository runners must provision isolated PostgreSQL and temporary file storage and must use dummy/stub providers. Expected: all existing Results, authorization, run queue, retry, schema, project tab and export regressions pass. No request reaches a real AI service.

## 5. Desktop UI matrix

Playwright configuration already provides desktop acceptance widths. Validate each scenario at 1024, 1280 and 1440 CSS px, then repeat the core visual/interaction assertions in current, white and eye themes.

### Scenario A — Tool discovery

1. Open an empty project.
2. Hover each of the five group triggers and move the pointer into its flyout.
3. Rapidly cross several triggers; only the last stable group may remain visible.
4. Click to pin, move away, click again to close.
5. Use ArrowUp/ArrowDown/Home/End, Enter/Space and Escape without a mouse.
6. Activate every unavailable item and compare node count, project revision, network log and usage count before/after.

Pass conditions: visible feedback within 250ms, no flicker, Escape restores focus, and unavailable items change nothing.

### Scenario B — Creation and right Dock

1. Create text and image nodes by click; create another item by drag/drop.
2. Verify click-created nodes land in the visible safe area without overlap.
3. Select different nodes and switch Properties/Results.
4. Collapse and reopen the right Dock.

Pass conditions: each action creates one correct node; the Dock never overlays the canvas, closed width is zero with no hit box, the canvas world center does not jump, and Results/Properties retain state without React Flow remount.

### Scenario C — Staged try-on

1. Connect person, scene and outfit images, confirming each role.
2. Add selected accessory roles and multiple detail references within the 14-image total.
3. Attempt a duplicate role, mismatched explicit handle and a fifteenth image.
4. Generate with the stub provider and inspect the captured request: person and outfit are the sole identity/garment sources, the raw scene image is absent, bounded scene analysis is present, and no text exists for unconnected accessory roles; then confirm in the independent stage-approval node.
5. Verify the second stage unlocks only after category/material/construction are valid.
6. Change a first-round input and start a re-run.

Pass conditions: invalid edges/runs yield business errors and provider request count 0; approval becomes stale immediately; no model switching or input deletion occurs.

### Scenario D — Path and automatic layout

1. Build two disconnected workflows with overlapping nodes inside only one workflow.
2. Select a node in the first workflow and verify upstream/downstream emphasis.
3. Run auto layout and then undo/redo.
4. Repeat with no selection and with a deliberately cyclic test fixture.

Pass conditions: only the selected component moves, it has no overlaps, other coordinates and viewport remain exact, one undo restores all moved positions, and no-selection/cycle are no-ops with readable feedback.

### Scenario E — Drawing and color

1. Create a drawing board and draw/erase shapes and text across several layers.
2. Use local undo/redo, simulate an interrupted session, recover the draft, then save.
3. Save, connect the board's committed preview directly to an image-compatible node, then separately export it as an image node.
4. Choose quick, custom and eyedropper colors while other nodes are selected; enter valid `#RGB`, `#RRGGBB`, `rgb()` and `hsl()` values plus invalid alpha, malformed and out-of-range values.
5. Connect the resulting palette node to a compatible color-replacement node.
6. Repeat the brush, shape, text, layer and color-format path with keyboard only and verify visible focus and focus restoration.

Pass conditions: local edits create zero project history until save, recovery creates no duplicate entry, the unsaved board cannot connect, direct committed-preview connection and export both preserve the board, valid formats normalize to uppercase `#RRGGBB`, invalid formats are not clamped, every color choice creates a palette node only, keyboard operation remains complete, and provider request count stays 0 until the user explicitly runs a valid paid node.

### Scenario F — Results regression

1. Restore success, failure, retrying and unknown-outcome records across projects.
2. View, compare, download and set a result as input.
3. Collapse/reopen the right Dock and switch projects.

Pass conditions: all existing Results behaviors remain available and context does not reset unexpectedly.

## 6. Persistence and recovery

1. Save a project containing text, board, palette, stage-approval and staged try-on nodes.
2. Refresh, reopen and verify every v5 field and typed role.
3. Restart the local application containers without deleting volumes and reopen.
4. Instantiate a template and verify it contains no real images, approval facts, board owner refs or historical generation results.

Expected: committed data survives; transient UI/editor state does not enter project JSON; templates start clean; PostgreSQL and DATA_DIR remain untouched by routine restart.

## 7. Quantitative acceptance

### 7.1 Compact-node height

Before node compaction, record the exact first-round and second-round fixtures, browser version, theme, viewport and `getBoundingClientRect().height` at 1024, 1280 and 1440 CSS px in `implementation-evidence.md`. After implementation, render the same fixtures in the same environment. Every matching post-change height must be no more than 70% of its baseline, with title, role/input summary, state, primary action and latest-result summary still reachable.

### 7.2 Moderated first-use study

Recruit at least 20 participants who have not used this build or read its tutorial. Allocate participants as evenly as possible among 1024, 1280 and 1440 CSS px. Give every participant the same clean seeded project and the same four task cards; reveal one card at a time and record only anonymized duration, first action, corrections and pass/fail.

1. Tool discovery: start timing when the named-tool card appears and stop when the correct node exists. Pass threshold: at least 18/20 within 30 seconds.
2. Role connection: provide the same person, scene, outfit and accessory inputs. Pass threshold: at least 19/20 bind every requested role without first creating an incorrect edge.
3. Path recognition: select the same workflow node and ask for one specified direct upstream and downstream node. Pass threshold: at least 18/20 answer within 2 seconds.
4. Drawing workflow: start when the board task appears and stop when a saved connectable board image output exists. Pass threshold: at least 18/20 within 120 seconds.

Automated browser timings and geometry support diagnosis but do not replace these human results. If recruitment or a threshold is incomplete, record the criterion as `NOT VERIFIED` or `FAILED`; never mark it passed by inference.

## 8. Final gates

```bash
pnpm run check
pnpm run test:e2e:production
node .gitnexus/run.cjs detect-changes --scope all --repo .
git diff --check
```

`test:e2e:production` must still use its safe local fixture configuration; stop if it resolves production credentials or storage. Confirm that `tests/test-runner-isolation.test.mjs` proves all new TypeScript tests are registered and that `tests/e2e-safety.test.mjs` asserts named safety journeys without a fixed file-count dependency. GitNexus `partial: true`, `truncated: true` or UNKNOWN impact is not a pass. Report exact test/build/graph outcomes and confirm that paid external request count was zero.

Production rebuild/restart, database migration application and any real generation remain separate, explicitly authorized steps after implementation review.
