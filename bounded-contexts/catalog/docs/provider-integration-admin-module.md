# Provider Integration Admin Module

The Catalog provider integration admin module is the operator surface for authoring, validating, activating, importing, replaying, and retiring Provider Integration Profile versions.

Normal operator workflows must be fully UI driven. Operators should not need to edit profile JSON, fixture JSON, candidate JSON, active JSON, or dry-run result JSON to complete supported work. Versioned JSONB remains an acceptable persistence format, but the admin module must expose typed forms, guided controls, semantic comparisons, fixture workbenches, and diagnostics that map back to domain concepts.

Raw JSON may remain as an internal support inspection affordance behind an explicit advanced permission, but it is not the primary authoring path and must not be required for activation, migration evidence, import, reapply, rollback, retirement, or review.

If the current design system cannot support the best implementation of this deep module, add the necessary primitives or components instead of forcing awkward controls or raw JSON fallback controls into the workflow.

## Module Shape

The module should be organized around operator jobs rather than storage shape:

- Profile overview: provider, profile key, version, lifecycle, active state, validation status, capabilities, supported scopes, fixture coverage, mapping fingerprint, reference count, and authoring audit.
- Profile authoring workbench: guided sections for Basics, Provider Options, Connector, Observation Mapping, References, Product Options, Duplicate Prevention, Promotion Plan, Fixtures, Migration, and Review.
- Fixture dry-run workbench: fixture-flow chooser, generated safe payload override controls, structured run output, grouped diagnostics, redaction summary, evidence ownership, duplicate-prevention decisions, reference output, selected Options, and promotion command-plan preview.
- Semantic comparison: candidate vs active profile changes by lifecycle, capabilities, scopes, connector contract, option queries, mapping output, evidence use, external references, selected Options, Reference Record hierarchy, duplicate-prevention order, promotion plan, migration evidence, fixture coverage, and mapping fingerprint impact.
- Activation readiness: schema validation, fixture harness status, unsafe evidence checks, migration evidence requirement, reference count, non-goal/redaction checks, and import eligibility.
- Operations workbench: provider-specific import scope controls, active profile snapshot before enqueue, current job status, completed job result summaries, grouped failures, and links into filtered Source Observations.
- Lifecycle workbench: activation, deprecation, rollback, retirement, structured evidence capture, immutable audit display, and blocked-action guidance.

## Guided Authoring

Each profile section must be edited through controls that match the domain:

- Constrained text fields for display names, profile keys, version notes, source contract owner, repository, commit, document path, and fixture set version.
- Multi-select or checklist controls for capabilities, supported scopes, required fixture flows, and lifecycle gates.
- Structured provider option query editors for aliases, parent requirements, named transport operations, output value/label/parent/image mappings, scopes, and metadata paths.
- Connector metadata editors that separate transport-owned behavior from Catalog mapping-owned behavior.
- Mapping expression editors for path, constant, coalesce, template, array, object, array-map, named selector, named transform, string transform, coercion, and lookup expressions.
- Reference and selected-option editors for target levels, provider keys, external key prefixes, ambiguity policies, dimension aliases, value mappings, requiredness, and Product reference rules.
- Duplicate-prevention editors for ordered rule kinds, candidate policies, merge evidence, rule evidence, and ambiguous match behavior.
- Promotion-plan editors for plan kind, review requirement, ordered command rows, supported command names, required command inputs, evidence safety, and provider capability constraints.
- Migration-evidence editors for before/after mapping fingerprints, fixture run id, replay scope, observed impact, operator note, and immutable audit.

The UI should preserve unknown future-compatible profile data when saving a section, but it should not ask operators to manipulate that data directly.

## Typed Command Contract

The admin module should save edits through typed section commands instead of arbitrary profile patches. Section commands should be narrow, auditable, and validation-friendly:

- The request identifies provider key, profile version, section key, command type, and command payload.
- The server validates section shape, immutable profile identity, lifecycle constraints, evidence safety, fixture coverage, and mapping compatibility.
- Validation diagnostics identify section and control paths with redacted messages suitable for display.
- Successful saves return the updated authoring model or enough review data for the UI to refresh section diagnostics and activation readiness.
- Generic JSON patch remains internal/deprecated compatibility infrastructure until all normal UI authoring paths have migrated.

Typed commands currently cover the first section-level slices for basics, provider options, connector, catalog field mapping, source contract, fixtures, source observation, normalized observation, external references, selected options, reference hierarchy, duplicate prevention, promotion plan, retirement plan, and migration evidence. Deeper field-specific commands may be added where they make validation, audit, or UI ergonomics meaningfully better.

## Permissions

Catalog API reads require `catalog.view`. Profile authoring, lifecycle writes, production imports, promotion, reapply, rollback, retirement, and migration-evidence saves require `catalog.manage`.

The admin module should make that boundary visible:

- View-only operators can browse profiles, review observations, run safe dry-run/compare workflows when backed by read endpoints, and inspect diagnostics.
- Write actions are disabled or hidden for view-only operators and should explain the missing `catalog.manage` permission.
- Server-side authorization remains the source of truth; UI permission behavior is an operator clarity layer, not an enforcement replacement.
- Audit metadata should record actor, account, and timestamp for lifecycle and authoring changes.

## Diagnostics And Redaction

Diagnostics must be actionable without leaking provider-sensitive material:

- Messages should name the section, field path, fixture flow, severity, blocking state, and recommended correction.
- Redaction summaries should count redacted payload fields and evidence categories without showing secrets, pricing, inventory, seller, listing, order, message, or operations material.
- Unsafe evidence categories must block activation and must not enter normalized Catalog truth, hash material, merge identity, duplicate-prevention identity, promotion commands, logs, or UI text.

## Design System Expectations

The module needs dense, repeatable operational controls rather than marketing layouts. Prefer compact tables, tabs, drawers, split workbenches, section diagnostics, inline status pills, constrained form controls, and compare panels built for scanning.

Expected primitives include:

- nested expression editor rows with duplicate, reorder, remove, and inline diagnostics
- typed key/value path editors
- evidence ownership and redaction chips
- lifecycle and readiness status pills
- semantic diff tables with severity and activation impact
- fixture-run result panels
- disabled-action explanation affordances
- active job and completed job summary panels

Create missing primitives in the design system or local admin component layer when the current components cannot support this workflow cleanly.

