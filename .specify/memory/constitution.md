<!--
Sync Impact Report
- Version change: initial template -> 1.0.0
- Modified principles: none; this is the first ratified constitution
- Added principles:
  - I. Professional Garment Semantics and Reference Isolation
  - II. Paid AI Safety and Deterministic Execution
  - III. Data Security, Privacy, and Authorization
  - IV. Contract-First, Test-First Delivery
  - V. Observable, Recoverable Production
- Added sections:
  - Technical and Product Constraints
  - Development Workflow and Quality Gates
- Removed sections: none
- Follow-up TODOs: none
-->

# Garment Canvas Constitution

## Core Principles

### I. Professional Garment Semantics and Reference Isolation

- Every image input role MUST have one documented responsibility, priority, and conflict rule.
- In staged virtual try-on, the person reference MUST be the sole identity and body source; the
  scene reference MUST contribute only scene, composition, lighting, pose, and expression; the
  main outfit reference MUST be the sole garment and styling source.
- Accessories MUST be constrained only when the user supplies the corresponding category. Missing
  accessory inputs MUST NOT introduce filler instructions or inherit unrelated reference content.
- Reference ordering, role metadata, and provider limits MUST be enforced by schema, execution code,
  prompts, and regression tests. The system MUST NOT silently switch models, delete excess inputs,
  or change an approved reference role.

Rationale: professional apparel output is only auditable when identity, garment, scene, and
accessory evidence cannot contaminate one another.

### II. Paid AI Safety and Deterministic Execution

- Client and server MUST reject invalid roles, missing approvals, missing material specifications,
  unsupported parameters, and excess references before any paid request.
- Every paid run MUST use a persistent idempotency key, record the actual provider request count,
  and preserve success, failure, partial success, and unknown-outcome states.
- Deterministic input, parameter, authentication, content-refusal, and corrupt-response failures
  MUST NOT retry. Approved transient failures MAY retry at most two times after the initial request.
- Provider responses MUST be parsed according to the documented provider contract. Diagnostic logs
  MUST retain safe response shape and request identifiers without prompts, image data, or secrets.
- Automated tests and readiness checks MUST NOT call real or paid AI providers. A real generation
  requires the user's explicit authorization and must state the possible request count beforehand.

Rationale: generation can incur cost and may produce an uncertain upstream result, so validation,
idempotency, and exact accounting are non-negotiable.

### III. Data Security, Privacy, and Authorization

- Secrets MUST remain in private environment configuration and MUST NOT enter source control,
  browser payloads, logs, screenshots, generated artifacts, or agent output.
- Authentication, password-change, administrator, owner, and resource-reference checks MUST remain
  enforced server-side. Non-disclosing not-found responses MUST be used where existence is private.
- File identifiers, MIME type, decoded size, magic bytes, paths, and remote addresses MUST be
  validated before access. Traversal, SSRF, private-network fetches, and cross-account references
  MUST fail closed.
- Multi-table ownership, deletion, transfer, billing, and reference changes MUST be transactional.
  Recovery windows and referenced-asset deletion guards MUST be preserved.
- PostgreSQL MUST remain unavailable to untrusted networks. Public exposure requires a separately
  approved HTTPS, cookie-security, firewall, and threat-review specification.

Rationale: garment assets, model identities, account data, and paid generation records are private
business data whose confidentiality and ownership must survive every workflow.

### IV. Contract-First, Test-First Delivery

- Every behavior change MUST begin with an approved specification and explicit acceptance scenarios.
  Defect fixes MUST first add a regression that demonstrates the failure before implementation.
- Shared workflow schemas, provider contracts, database migrations, document snapshots, and API
  authorization boundaries MUST have focused contract or integration tests.
- Desktop UI changes MUST verify behavior, accessibility, focus, and rendered geometry at 1024,
  1280, and 1440 CSS pixels. Class-name assertions alone are insufficient.
- Tests MUST use isolated PostgreSQL, temporary file directories, and stub providers. Production
  data, production volumes, and real AI credentials MUST never be used as test fixtures.
- A change is not complete until focused tests, the applicable full suite, build, whitespace checks,
  and required static or graph analysis pass or are explicitly reported unavailable.

Rationale: executable contracts prevent subtle regressions across the canvas, persistence,
authorization, and provider boundaries.

### V. Observable, Recoverable Production

- PostgreSQL 18 is the authoritative structured-data store; `DATA_DIR` is the authoritative binary
  asset store. Backup and restore MUST treat them as one consistent recovery point.
- Generation jobs MUST be durable across process restarts, and Results MUST preserve successful,
  failed, partial, retrying, and unknown outcomes without hiding prior user work.
- Health and readiness probes MUST remain separate. Readiness MUST verify database, writable data
  storage, frontend availability in full mode, users, and AI configuration without paid calls.
- Operational logs MUST be structured, bounded, and secret-safe, with sufficient identifiers to
  trace a run, node, provider, retry, and response shape.
- Upgrades and migrations MUST have a verified backup and rollback path. Production volumes MUST
  never be deleted as a routine deployment step, and deployment requires explicit user approval.

Rationale: a long-running design system is trustworthy only when failures are visible, data remains
recoverable, and restart or upgrade does not erase user work.

## Technical and Product Constraints

- The supported product is a desktop web application with a minimum width of 1024 CSS pixels and
  primary acceptance widths of 1280 and 1440. Mobile-only scope requires an approved specification.
- The baseline stack is Node.js 22.20 or newer, React, Vite, Express, PostgreSQL 18, and Docker
  Compose. SQLite is permitted only for legacy import and migration verification.
- Standard UI controls MUST use the project-local shadcn primitives. Business state remains in the
  domain store, and theme ownership remains with `data-theme` and the existing design tokens.
- `ProjectTab` documents and the `DocumentSnapshot` boundary MUST remain canonical. Runtime,
  selection, viewer, measurement, and temporary panel state MUST NOT enter persisted project data.
- Asynchronous writes MUST remain bound to the initiating tab, project, and document epoch. Late
  responses MUST NOT update a replacement document.
- Provider-specific model, image-count, role, size, and quality constraints MUST be sourced from
  reviewed local contracts and verified before network access.

## Development Workflow and Quality Gates

1. Use the Spec Kit sequence: constitution, specification, optional clarification, plan, tasks,
   optional cross-artifact analysis, implementation, and convergence review.
2. Before editing a function, class, method, route contract, or shared type, run GitNexus upstream
   impact analysis. HIGH or CRITICAL risk MUST be reported before editing. UNKNOWN risk MUST be
   resolved with source verification and MUST NOT be treated as safe.
3. Prefer the smallest evidence-backed change. UI work, security changes, dependency upgrades,
   migrations, and architecture rewrites MUST NOT be mixed without explicit scope in the plan.
4. Run focused regression tests during implementation, then the applicable complete local gates.
   GitNexus change detection MUST run before a commit; degraded or unavailable analysis is a
   reported blocker, not a passing result.
5. Preserve unrelated user changes. Destructive Git, database, volume, production, merge, release,
   and deployment actions require explicit authorization at the appropriate step.
6. Delivery evidence MUST state the exact scope, tests, build result, graph risk, known limitations,
   migration and rollback requirements, and whether any paid external request occurred.

## Governance

- This constitution is the governing source for product engineering principles. `AGENTS.md` is the
  operational rulebook and MUST implement these principles; a conflict requires an explicit
  constitution amendment rather than silent circumvention.
- Every specification, plan, task list, review, and release candidate MUST include a constitution
  compliance check. Any exception requires a written rationale, bounded duration, owner, rollback
  plan, and explicit user approval.
- Amendments require a documented proposal, impact analysis, migration needs, and user approval.
  The amendment MUST update the Sync Impact Report, version, and amendment date.
- Versioning follows semantic versioning: MAJOR removes or redefines a governing principle, MINOR
  adds or materially expands principles or sections, and PATCH clarifies without changing intent.
- The user may change the product contract, but conflicting durable guidance MUST be incorporated
  through an amendment before dependent implementation proceeds.

**Version**: 1.0.0 | **Ratified**: 2026-09-02 | **Last Amended**: 2026-09-02
