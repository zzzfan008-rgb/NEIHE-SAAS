# CodeGraph — Code Intelligence

Use CodeGraph for this project. Do not use GitNexus, either directly or through
scripts, skills, or delegated reviews. This is the user's ongoing tool preference.

- Check index freshness with `codegraph status .`; update with `codegraph sync .`.
- Explore unfamiliar code with `codegraph explore "concept" -p .` and inspect
  symbols with `codegraph node "symbolName" -p .`.
- Before editing existing symbols, run
  `codegraph impact "symbolName" -p . -j` and report affected callers/files.
  Empty or incomplete graph results are unresolved, not proof of low risk;
  supplement with source inspection and focused tests.
- Before delivery or commit, sync the index, inspect the complete diff, and run
  `codegraph affected <changed-source-files...> -p . -j` to select regression tests.
  Include newly added files; do not treat graph coverage as exhaustive.
- The existing `gate:codex` script still invokes GitNexus. Until separately migrated
  to CodeGraph, do not run it or report the full gate as passed. Continue the
  independent local tests/build checks and report the unavailable gate explicitly.

# Garment Canvas — Current Project Rules

This file is the single source of truth for current project rules. Dated handoffs,
completion ledgers, review notes, and screenshots are historical evidence only. If
they conflict with this file, follow this file and the user's latest explicit
instruction, then verify drift-prone repository and release state live.

## 1. Product Scope

- Garment Canvas is a desktop-only web product. The supported minimum width is
  1024 CSS pixels; 1280px and 1440px are the primary acceptance widths.
- Do not add mobile navigation, mobile-only layouts, touch-only interactions, or
  mobile regression scope unless the user explicitly changes the product contract.
- Use Node.js 22.20.0 or newer. PostgreSQL 18 is the production source of truth;
  SQLite exists only for legacy import and migration verification.

## 2. UI and Interaction Rules

- Every new or modified general-purpose UI surface must use the project's local
  shadcn components in `src/components/ui/`. This includes buttons, tabs, dialogs,
  alert dialogs, menus, cards, sheets, tooltips, skeletons, and equivalent standard
  controls. Do not hand-roll a second implementation of an available primitive.
- When no matching primitive exists, add or extend a project-local shadcn primitive,
  then compose the product-specific component from it. Canvas mechanics that have
  no shadcn equivalent may continue to use React Flow and domain code, but their
  visible standard controls must still be composed from shadcn primitives.
- A scoped UI change should migrate any equivalent hand-rolled controls it touches;
  unrelated legacy UI is not a reason for a broad rewrite.
- shadcn components own presentation, accessibility, and controlled component
  behavior only. Business state remains in the existing Store/domain layer. Theme
  ownership remains `data-theme` plus `--gc-*` variables; do not create a second
  theme source of truth.
- Preserve keyboard operation, visible focus, accessible names/states, reduced-motion
  behavior, and focus restoration for every changed interaction.
- Before editing UI or interaction code, present the concrete behavior and layout
  proposal to the user and wait for explicit confirmation. Read-only audits,
  screenshots, impact analysis, and proposal writing do not require confirmation.

## 3. Results and Document Boundaries

- Results must not be removed, hidden behind a degraded path, or weakened. Preserve
  cross-project run recovery, success, failure, unknown-result handling, view,
  compare, download, and continued processing / set-as-input flows.
- Keep `ProjectTab[]` as the canonical document source and preserve the strict
  `DocumentSnapshot` boundary. Selection, viewer/compare state, runtime state,
  React Flow measurements, and temporary UI state do not belong in project data.
- Async save, run, upload, asset, and mask writes must remain bound to the initiating
  `tabId + projectId + documentEpoch`. Do not let late responses write into a new
  document occupying the same tab container.
- UI panel open/closed state remains local UI state and must not enter document
  history, session persistence, or the business Store.

## 4. Security and Data Invariants

- Keep `/api/health`, `/api/ready`, login, and session checks intentionally separate
  from authenticated routes. Do not weaken `requireAuth`, `requirePasswordChanged`,
  or `requireAdmin` coverage.
- Preserve one active device session per account, hashed tokens, secure cookie
  attributes, replacement-session reporting, and revocation after account changes.
- Enforce owner/admin checks on projects, files, assets, history, usage, and output.
  Prefer a non-disclosing `404` when revealing resource existence would leak data.
- Validate image identifiers, MIME/extension, decoded size, and local references
  before filesystem access. Prevent traversal and arbitrary local/remote URL access.
- Keep destructive multi-table operations and ownership/reference updates
  transactional. Preserve recovery windows and referenced-asset deletion guards.
- Never expose AI gateway keys to clients or logs. Retain provider request limits,
  reference-image ordering, and non-stretching resize semantics. Automated tests
  must not call paid or real AI providers unless the user explicitly authorizes it.

## 5. Change and Verification Workflow

- Inspect relevant flows and tests first. Run CodeGraph `impact` before editing a
  function, class, method, route contract, or shared type; report substantial
  regression risks before proceeding.
- Prefer the smallest evidence-backed patch. Do not mix UI work with unrelated
  security fixes, architecture rewrites, dependency upgrades, or formatting churn.
- Add or update regression coverage for each behavior change. For desktop UI, assert
  rendered geometry and interactions at 1024, 1280, and 1440 rather than class names.
- Use the existing scripts: `npm run lint`, `npm run test`, `npm run check`, and
  `npm run build`. The isolated PostgreSQL runner owns test Compose lifecycle; do
  not replace it with ad-hoc direct Compose commands.
- Before delivery or commit, run the relevant focused tests, `npm run check`,
  `npm run build`, `git diff --check`, and CodeGraph `sync` / `affected`. Report any
  unavailable or degraded gate instead of treating it as passed.
- GitHub Actions is not a project gate. Once the CodeGraph migration described
  above is complete, run `npm run gate:codex -- --base origin/main`
  for a feature branch, or select an exact commit with `--commit SHA`. This runs the
  deterministic local suites on the exact minimum Node.js version pinned by `.nvmrc`,
  then a structured `codex exec` review without a model override, so the user's
  configured Codex default model is used. Any actionable P0-P3 finding blocks
  delivery. Record the exact base/head and the local result in the PR.

## 6. Git, Review, and Release Gates

- Preserve unrelated user changes in a dirty worktree. Do not force-reset, clean,
  rebase, or overwrite work that is outside the requested scope.
- The user message `通过` authorizes committing and pushing the approved batch plus
  a local exact-SHA review using the configured local review model. It does not
  authorize merging to `main`, tagging, releasing, or deploying.
- Do not trigger or wait for Codex Cloud review. The current review path is the
  local Codex gate, CodeGraph, exact head/base verification, and the user's explicit
  approval. GitHub Actions and CodeRabbit are not required evidence.
- Merging a PR, tagging, publishing a release, and deploying each require explicit
  user authorization. Never merge automatically.
- Keep `.env`, `.env.local`, PATs, provider keys, credentials, uploads, database
  dumps, `data/`, `dist/`, `dist-server/`, and other runtime/generated output out of
  commits and agent output. `.env.example` remains the public configuration contract.
- Historical audit details belong in `CODEX_REVIEW_HANDOFF_APP.md` and dated docs,
  not in this current-rule file.
