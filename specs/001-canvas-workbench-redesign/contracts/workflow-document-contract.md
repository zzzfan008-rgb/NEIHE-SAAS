# Workflow Document Contract v5

## 1. Canonical ownership

- `ProjectTab` owns committed project name, nodes and edges.
- `DocumentSnapshot` is the whitelist boundary for project save, template save, run-plan input and browser session recovery.
- Node UI/runtime fields are reconstructed outside the persisted workflow.
- Every asynchronous write captures and revalidates `tabId`, `projectId` and `documentEpoch`.

## 2. Schema and migration

- `WORKFLOW_SCHEMA_VERSION` becomes 5.
- Readers accept supported legacy versions and deterministically migrate them to v5.
- Writers emit only v5.
- Unknown future versions fail closed.
- v4 standard image workflows preserve behavior.
- v4 fabric-recolor defaults to `operationMode=combined`.
- v4 scene-stabilize defaults to `basisRevision=0`.
- Existing confirmed v4 refine workflows receive one deterministic stage-approval node; migration is idempotent.
- Legacy staged edges without an unambiguous role are rejected rather than guessed by creation order.

## 3. Typed port compatibility

An edge is valid only if:

1. source and target nodes exist and differ;
2. source output and target input value kinds match;
3. targetHandle is permitted by target kind and workflow stage;
4. role cardinality and node/model total limits remain satisfied;
5. an identical source/target role edge does not already exist;
6. project is writable for a client mutation.

Client preview validation, store mutation validation, server schema validation and DAG assertion all enforce the same rules. The server/DAG verdict is authoritative for paid execution.

## 4. Staged try-on roles

### Scene stabilize input ports

| Role | Kind | Required | Max sources | Responsibility |
| --- | --- | --- | --- | --- |
| person | image | yes | 1 | Only identity/body source; lower-right face crop remains recovery anchor. |
| scene | image | yes | 1 | After authorization and validation, the server derives scene/composition/light/pose/expression text; only that bounded analysis enters prompt composition and the raw scene image is not sent to the generation provider. |
| outfit | image | yes | 1 | Only garment and styling source. |
| bag | image | no | 1 | Bag only; unrelated content excluded and low weight. |
| shoes | image | no | 1 | Shoes only; unrelated content excluded and low weight. |
| hat | image | no | 1 | Hat only; unrelated content excluded and low weight. |
| ring | image | no | 1 | Ring only; unrelated content excluded and low weight. |
| earrings | image | no | 1 | Earrings only; unrelated content excluded and low weight. |
| bracelet | image | no | 1 | Bracelet only; unrelated content excluded and low weight. |
| detail | image | no | remaining total | Supplemental garment structure only. |

Absent accessories contribute neither an image nor filler prompt text. The total provider reference count may not exceed 14; the system never switches models or deletes excess references.

### Approval and refine

- Scene stabilize increments `basisRevision` before every re-run and whenever a semantic input, source output, or generation parameter changes.
- Stage-approval accepts one `baseline-candidate` image.
- User confirmation stores candidate source id, image ref and basis revision.
- It emits an image only while all three still match.
- Garment refine accepts `baseline` only from a confirmed stage-approval node, plus outfit, optional material and optional detail.
- Missing approval, garment category, material spec or construction spec blocks before provider network access.

## 5. Typed non-image payloads

- `color-palette` outputs `colors`; it never increments image reference counts.
- A palette edge may target only a declared `palette` colors input.
- Execution-plan compilation resolves the connected swatches into a stable parameter snapshot; the runner never receives them as `referenceImages`.
- `text-input` outputs `text`, but no current paid node declares a compatible prompt input in this feature. No implicit prompt concatenation is allowed.
- `drawing-board` outputs its persisted preview image only when a valid authorized preview ref exists.
- `stage-approval` outputs its approved image only in confirmed state.
- Video value kinds are reserved; no enabled v5 node emits or consumes them.

## 6. Document mutations and history

- Node creation, edge confirmation, palette creation, auto layout and completed board edit each use one `commitDocumentMutation`-equivalent operation.
- Board-local edits and recovery draft writes are not ProjectTab mutations.
- Auto layout replaces only positions in the selected connected component.
- A scene-stage basis change and `basisRevision` increment are one atomic mutation.
- Undo/redo restores exact prior nodes, edges, positions, approval facts and drawing refs.

## 7. Template rules

- Templates preserve v5 node kinds, typed roles, stage fields, tool presets and board dimensions/background.
- Templates do not persist user images, generated outputs, approval facts, owner-specific board content refs, preview refs, export refs or recovery drafts.
- Instantiation produces a new writable project identity and requires new inputs and approval.

## 8. Failure behavior

- Unsupported kind, role, payload type, duplicate single role, stale approval, unauthorized reference, malformed board ref or future schema version returns a bounded business error.
- These failures are deterministic and never retried.
- No invalid plan may reach the provider adapter.
- Diagnostic logs may include project/run/node ids, role names, counts and safe response shape; they exclude prompts, image data, board content and secrets.
