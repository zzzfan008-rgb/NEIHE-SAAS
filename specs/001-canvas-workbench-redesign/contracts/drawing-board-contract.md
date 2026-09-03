# Drawing Board Contract

## 1. Capability boundary

The drawing board is a non-AI editor. It supports brush, eraser, rectangle, ellipse, line, arrow, text, layer order/visibility/lock/opacity, board-local undo/redo, save and PNG export. It does not call an AI provider.

Konva is a rendering/interaction adapter only. The application-owned `DrawingDocument` is the canonical editable format; Konva Stage serialization is prohibited.

## 2. Limits

The first release enforces all limits before persistence:

- canvas width and height: 256–4096 px;
- maximum layers: 5;
- maximum objects across layers: 2,000;
- maximum normalized points across all strokes: 100,000;
- maximum UTF-8 text length per text object: 4,000 bytes;
- maximum canonical DrawingDocument JSON: 2 MiB;
- opacity: 0–1; finite coordinates only; stroke width: 1–256 px;
- export pixel count: at most 16,777,216 pixels and pixel ratio at most 2.

The editor performs point simplification before draft/persist validation. Exceeding a limit keeps the current editor state, explains the specific limit, and offers deletion/simplification; it never truncates silently.

## 3. Client editing session

1. Capture `DocumentTarget` and the node's current `contentRef`/hash.
2. Load the immutable DrawingDocumentVersion after owner authorization, or initialize an empty v1 document.
3. Open the dynamically imported editor; keep selection, transform handles, local zoom and command history in editor memory.
4. After a content-changing command, append one local command and schedule a 500ms throttled IndexedDB recovery write.
5. Undo/redo changes the local document only.
6. Closing without changes writes no project history.
7. Save validates limits, creates an immutable server version, creates/updates an owner-scoped preview image, revalidates DocumentTarget, then performs one project document mutation with the new refs.
8. Only after the project mutation succeeds is the matching recovery draft deleted.

If version or preview upload succeeds but the DocumentTarget has changed, the project is not patched. The unclaimed version follows recovery retention and the local draft remains available.

## 4. Recovery draft

- Storage: IndexedDB, separate from ProjectTab session shards.
- Key: ownerId + tabId + projectId + documentEpoch + nodeId.
- Base match: contentRef and canonical content hash.
- Writes are bounded and replace the prior draft for the same key.
- On matching reopen, the user may recover or discard.
- On base mismatch, the user may open the draft as a new board or discard; overwrite is never automatic.
- Recovery creates no global history entry until the user explicitly saves.
- Logout removes the current account's drafts from the active browser profile; account switches can never enumerate another owner's drafts.

## 5. Board version API

### POST `/api/drawing-boards/versions`

Authenticated request:

```json
{
  "clientRequestId": "stable-idempotency-key",
  "projectId": "project-id",
  "nodeId": "drawing-node-id",
  "baseContentRef": "optional-prior-version-id",
  "document": { "version": 1, "canvas": {}, "layers": [] }
}
```

Server requirements:

- authenticate owner and verify writable project ownership;
- validate project/node/base reference ownership and relation;
- validate the complete document and limits before insert;
- use `clientRequestId` idempotently;
- canonicalize and hash content;
- insert an immutable PostgreSQL version;
- never log `document` content.

Success `201` (or idempotent replay `200`):

```json
{
  "contentRef": "drawing-version-id",
  "sha256": "hex-digest",
  "createdAt": "ISO-8601"
}
```

### GET `/api/drawing-boards/versions/:id`

Returns `{ contentRef, sha256, document, createdAt }` only to an authorized owner/resource reader. A cross-owner or unknown id uses the existing non-disclosing not-found behavior.

### Project save integration

When a project references `contentRef`, server project validation confirms owner/project/node consistency in the same transaction as the project write. It does not copy content bytes into `flow_json`.

## 6. Preview and export

- The client renders PNG via `stage.toBlob()` from same-origin or validated CORS-safe resources.
- Cross-origin images that would taint the canvas are rejected before entering a board.
- Preview/export upload reuses the existing image validation/file-store path and owner authorization.
- A board exposes `previewImageRef` as its image output only after the upload and project commit succeed.
- Image-compatible downstream nodes may connect directly to that committed board output; DAG resolution revalidates owner/project/file access and passes the preview as an ordinary image reference, never as inline DrawingDocument content.
- Before the first successful save, after a failed save, or when `previewImageRef` is missing/stale, connection and execution fail before provider access with a bounded Chinese business error.
- “导出为图片节点” creates a new image-input using the committed export ref. Board data remains unchanged except for an optional latest export ref recorded in the same explicit command.

## 7. History contract

| Action | Board-local history | Project history |
| --- | --- | --- |
| Draw/erase/shape/text/layer command | +1 | +0 |
| Board-local undo/redo | changes | +0 |
| Recovery draft autosave | unchanged | +0 |
| Recover matching draft | restored | +0 |
| Successful end/save session | reset/close | +1 total |
| Failed save | retained | +0 |
| Export as image node | unchanged | +1 for atomic image-node creation |

## 8. Template, copy and deletion

- Template creation strips contentRef, previewImageRef and exportImageRef and retains only dimensions/background.
- Project duplication creates owner-safe copies/references in a transaction before the duplicate becomes visible.
- Board version deletion is never driven directly by UI node deletion. Unreferenced content enters the existing recovery window and purge process.
- Normal deploy, migration and `docker compose up` never delete board versions or preview files.

## 9. Verification

- Contract tests cover malformed objects, limits, idempotency, owner/project/node mismatch, non-disclosing reads, project-save transaction behavior and direct board-image DAG resolution.
- History tests prove N local edits create zero project entries and one completed session creates exactly one.
- Recovery tests cover crash, quota error, account switch, epoch mismatch and base mismatch.
- Bundle tests prove the editor is absent from initial chunks and all budgets pass.
- E2E direct connection and export use local vector content only and perform zero AI/provider requests until the user explicitly runs a valid downstream paid node.
