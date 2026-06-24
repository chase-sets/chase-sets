# Design System Milestones

This is the checked-in traceability record for completed design-system milestones and the living verification commands that keep them from regressing. Each milestone section captures its requirements, issue references, completion standard, and the generated-inventory or acceptance-matrix evidence that proves closure.

## Milestone #10 — Form System

This is the traceability artifact for GitHub milestone #10, "Design System Form System".

Audit status: implementation evidence is collected for the current branch. PR, CI, merge queue, staging verification, production verification, and local cleanup remain pending until this branch is published and merged.

### Completion Standard

Milestone #10 requires:

- A robust, accessible, composable form system with state, validation, hints, errors, summaries, native submission, server-error mapping, and design-system field composition.
- Shared `Form` and router adapter boundaries.
- A consistent field API and native submission behavior for every eligible design-system form primitive.
- Migration of every production form surface to the shared pattern.
- Removal of raw lowercase `<form>` usage, direct framework `Form` usage, obsolete local wrappers, and migration-only compatibility code.
- Automated guardrails that prevent regressions.
- Documentation, acceptance matrix coverage, migration smoke or route-contract coverage, and a final traceability audit with no deferred legacy-form exceptions.

### Issue Traceability

| Issue | Requirement | Current evidence | Residual risk |
| --- | --- | --- | --- |
| #900 | Epic goal and completion gates | This audit, the form matrix in this document, `README.md`, `check:no-legacy-forms`, `verify:static`, `verify:typecheck` | PR/CI/merge/deploy pending |
| #901 | Form architecture and field adapter contract | `README.md` form architecture section, `form.tsx`, `router-form.tsx`, `shared.tsx`, `form-system.test.tsx` | None known before PR review |
| #902 | Field anatomy for labels, hints, errors, status, counters | `shared.tsx`, native/composite/boolean primitive updates, `form-system.test.tsx` field anatomy tests | None known before PR review |
| #903 | Native submission semantics for eligible primitives | `form-system.test.tsx` `FormData` coverage, primitive `name`/`form` and hidden/native input support | Browser-level file input behavior remains covered by representative route-contract smoke rather than full browser upload |
| #904 | Form state and validation lifecycle primitives | `form-state.ts`, async stale-result suppression test, dirty/touched/reset/server-error tests | None known before PR review |
| #905 | Schema and server error mapping | `normalizeFormErrors`, `clearFieldError`, README controlled-form example, `form-system.test.tsx` server-error tests | Schema-library-specific adapters intentionally not coupled to the design system |
| #906 | Validation summary, submit status, unsaved-change patterns | `validation-summary.tsx`, summary focus tests, `useFormState` dirty/reset/submitting APIs, README lifecycle guidance | Full app-level navigation blocking examples are documented through API guidance rather than wired into product screens |
| #907 | Group controls: CheckboxGroup, RadioGroup, Switch, Slider | `checkbox.tsx`, `radio-group.tsx`, `switch.tsx`, `slider.tsx`, repeated checkbox and boolean/range `FormData` tests | None known before PR review |
| #908 | Composite controls: Select, Combobox, Autocomplete, TagInput, FileDropzone | `select.tsx`, `combobox.tsx`, `autocomplete.tsx`, `tag-input.tsx`, `file-dropzone.tsx`, composite `FormData` tests | File drag/drop browser behavior is not exhaustively browser-tested in this branch |
| #909 | Form accessibility and behavior acceptance matrix | the form matrix in this document, `form-system.test.tsx`, route smoke scripts wired into `verify:static` | Matrix must stay updated if PR review changes scope |
| #910 | Documentation, recipes, migration guidance, no-legacy-form rule | `README.md`, the form matrix in this document, guardrail script/tests | None known before PR review |
| #911 | Representative product adoption slice | Auth sign-in, experience GET filter, marketplace listing multipart, public waitlist, marketplace shell smoke tests | Representative coverage only; full migration proof relies on #913/#924 |
| #912 | Final audit and legacy code removal proof | This audit file, `check:no-legacy-forms` final mode, empty baseline, verification commands below | PR/CI/merge/deploy pending |
| #913 | Track migration of every production form surface | Production migrations across bounded contexts/deployables/design-system, final guardrail inventory | Any future form additions before merge must pass the guardrail |
| #914 | AST guardrail baseline for raw forms and direct framework Form | `scripts/check-no-legacy-forms.mjs`, `scripts/check-no-legacy-forms.test.mjs` | None known before PR review |
| #916 | Shared Form primitive and native/router adapter boundaries | `form.tsx`, `router-form.tsx`, package subpath export, `tsconfig` path mapping | None known before PR review |
| #917 | Deployable shell/layout form migration | `deployables/*/routes/*layout.tsx`, marketplace layout tests | None known before PR review |
| #918 | Auth and identity form migration | Auth/identity migrated route components, auth sign-in route-contract tests | None known before PR review |
| #919 | Checkout, discovery, marketplace, payments migration | Checkout/discovery/marketplace/payments migrated components, listing multipart smoke | None known before PR review |
| #920 | Fulfillment, inventory, ordering, operations migration | Fulfillment/inventory/ordering/platform-operations migrated components, migration guardrail | Representative smoke only |
| #921 | Public presence, settlement, pricing, commercial terms, reputation, experience migration | Public/settlement/pricing/commercial/reputation/experience migrated components, waitlist and feedback smoke tests | Representative smoke only |
| #922 | Browser smoke or equivalent route-contract coverage | `test:form-migration-smoke` wired into `verify:static` | Product owners may request deeper full-browser coverage after PR review |
| #923 | Design-system internal form renderer migration | `operational-workflow.tsx` migrated to shared `Form`, design-system tests | None known before PR review |
| #924 | Final blocking no-legacy-form guardrail | `pnpm run check:no-legacy-forms` final mode passes with 0 baseline entries | None known before PR review |

### Primitive Coverage

| Primitive or pattern | Field anatomy | Native submission | Lifecycle/error coverage | Evidence |
| --- | --- | --- | --- | --- |
| `Form` | Form context and validation summary association | Native form attributes, hidden fields, external submit | Disabled/submitting state | `form.tsx`, `form-system.test.tsx` |
| `RouterForm` | Form context and validation summary association | React Router adapter boundary | Route-compatible action/method behavior | `router-form.tsx`, `form-system.test.tsx` |
| `ValidationSummary` | Alert summary with field and form errors | Not applicable | Link focus and group focus delegation | `validation-summary.tsx`, `form-system.test.tsx` |
| `useFormState` | Field metadata adapter | Not applicable | Dirty, touched, reset, async validation, stale result suppression, server-error clearing | `form-state.ts`, `form-system.test.tsx` |
| `TextInput`, `CurrencyInput`, `SearchInput` | Label, description, error, status, counter | Native input | Error clearing through `useFormState` adapters | `text-input.tsx`, `form-system.test.tsx` |
| `PasswordInput` | Label, description, error, status, counter | Native input | Reveal toggle remains local | `password-input.tsx`, the form matrix in this document |
| `Textarea` | Label, description, error, status, counter | Native textarea | Shared error/status semantics | `textarea.tsx`, the form matrix in this document |
| `NativeSelect` | Label, description, error, status, counter | Native select | Shared error/status semantics | `select.tsx`, the form matrix in this document |
| `Select` | Label, description, error, status, counter | Hidden input from selected value | Disabled submission exclusion | `select.tsx`, `form-system.test.tsx` |
| `NumberField` | Label, description, error, status, counter | Base UI native/hidden input via `name`/`form` | Shared error/status semantics | `number-field.tsx`, `form-system.test.tsx` |
| `Checkbox` | Item label plus description/error/status/counter | Native checkbox | Indeterminate visual state, read-only guard | `checkbox.tsx`, `form-system.test.tsx` |
| `CheckboxGroup` | Fieldset/legend group label plus item labels | Repeated native checkbox values via `name`/`form` | Disabled/read-only group behavior | `checkbox.tsx`, `form-system.test.tsx` |
| `RadioGroup` | Group label plus item labels | Base UI radio inputs via `name`/`form` | Required/disabled/read-only pass-through | `radio-group.tsx`, `form-system.test.tsx` |
| `Switch` | Item label plus description/error/status/counter | Base UI hidden/native value via `name`/`form` | Checked/unchecked value support | `switch.tsx`, `form-system.test.tsx` |
| `Slider` | Label, description, error, status, counter | Base UI hidden/native range value via `name`/`form` | Value display and disabled support | `slider.tsx`, `form-system.test.tsx` |
| `Combobox` | Label, description, error, status, counter | Hidden input from selected value | Selected value semantics | `combobox.tsx`, `form-system.test.tsx` |
| `Autocomplete` | Label, description, error, status, counter | Hidden input from selected value | Selected value semantics | `autocomplete.tsx`, `form-system.test.tsx` |
| `TagInput` | Label, description, error, status, counter | Repeated hidden inputs | Ordered multi-value serialization | `tag-input.tsx`, `form-system.test.tsx` |
| `FileDropzone` | Label, description, error, status, counter | Native file input with `name`/`form` | Shared error/status semantics | `file-dropzone.tsx`, multipart migration smoke |

### Migration Coverage

| Slice | Starting inventory source | Final proof | Verification evidence |
| --- | --- | --- | --- |
| Design-system internal renderers | Guardrail inventory and local scan before migration | Only approved `Form` implementation renders underlying lowercase `<form>` in production package code | `check:no-legacy-forms`, design-system tests |
| Deployable shell/layout forms | Guardrail inventory for deployables | Layout sign-out and guest-exit forms use shared `Form` | `deployables/marketplace/app/routes/layout.test.tsx`, `test:form-migration-smoke` |
| Auth and identity | Guardrail inventory for auth/identity files | Auth and identity forms use `Form`/`RouterForm` | `bounded-contexts/auth/features/sign-in/ui/sign-in-page.test.tsx`, `test:form-migration-smoke` |
| Checkout, discovery, marketplace, payments | Guardrail inventory for commerce/payment files | Checkout, cart, listing, offer, discovery, and payment forms use shared pattern | `bounded-contexts/marketplace/features/listings/ui/listing-list-page.test.tsx`, `test:form-migration-smoke` |
| Fulfillment, inventory, ordering, operations | Guardrail inventory for operational files | Fulfillment, inventory, ordering, and platform operations forms use shared pattern | `check:no-legacy-forms`, `verify:static` |
| Public presence, settlement, pricing, commercial terms, reputation, experience | Guardrail inventory for public/admin/business surfaces | Public conversion, settlement, pricing, commercial terms, reputation, and experience forms use shared pattern | `bounded-contexts/public-presence/features/waitlist/ui/public-pages.test.tsx`, `bounded-contexts/experience/features/platform-feedback/ui/admin-pages.test.tsx`, `test:form-migration-smoke` |

### Form Acceptance Matrix

This matrix is the design-system acceptance checklist for form primitives. Keep it in sync with `src/__tests__/form-system.test.tsx`, route/browser smoke tests, and the no-legacy-form guardrail.

#### Form-Level Patterns

| Pattern | Required coverage | Current evidence |
| --- | --- | --- |
| `Form` | Native `method`, `action`, `encType`, `target`, `ref`, hidden fields, external submit controls, disabled/submitting context, validation summary association | `form-system.test.tsx` |
| `RouterForm` | React Router action compatibility through `@chase-sets/design-system/react-router`, no direct framework `Form` imports in production consumers | `form-system.test.tsx`, `check:no-legacy-forms` |
| `ValidationSummary` | Field links, delegated focus for native/group targets, form-level messages, alert semantics, dynamic error updates | `form-system.test.tsx` |
| `useFormState` and error helpers | dirty, touched, reset, submit count, local validation, async validation, validating/submitting state, normalized server errors, stale field-error clearing | `form-system.test.tsx` |

#### Primitive Matrix

| Primitive | Field anatomy | Native submission | Required verification |
| --- | --- | --- | --- |
| `TextInput` | label, description, error, status, counter | native input | accessible label/description/error/status and `FormData` |
| `CurrencyInput` | label, description, error, status, counter | native input | accessible label/description/error/status and `FormData` |
| `SearchInput` | label, description, error, status, counter | native input | accessible label/description/error/status and `FormData` |
| `PasswordInput` | label, description, error, status, counter | native input | accessible label/description/error/status, reveal toggle, and `FormData` |
| `Textarea` | label, description, error, status, counter | native textarea | accessible label/description/error/status and `FormData` |
| `NativeSelect` | label, description, error, status, counter | native select | accessible label/description/error/status and `FormData` |
| `Select` | label, description, error, status, counter | hidden input synced from selected value | accessible trigger text, option interaction, disabled submission exclusion, and `FormData` |
| `NumberField` | label, description, error, status, counter | Base UI hidden/native input via `name`/`form` | value stepping, disabled/read-only behavior, and `FormData` |
| `Checkbox` | visible item label plus shared description, error, status, counter | native checkbox | checked, unchecked, indeterminate visual state, disabled exclusion, and `FormData` |
| `CheckboxGroup` | fieldset/legend group label plus item labels | repeated native checkbox values via `name`/`form` | group label semantics, disabled/read-only behavior, and repeated `FormData` values |
| `RadioGroup` | group label plus item labels | Base UI hidden/native radio inputs via `name`/`form` | selected value, required behavior, keyboard behavior, and `FormData` |
| `Switch` | visible item label plus shared description, error, status, counter | Base UI hidden input via `name`/`form` | checked/unchecked values, disabled/read-only behavior, and `FormData` |
| `Slider` | label, description, error, status, counter | Base UI hidden range input via `name`/`form` | value formatting, keyboard behavior, disabled behavior, and `FormData` |
| `Combobox` | label, description, error, status, counter | hidden input synced from selected value | selected value, filtering, disabled behavior, and `FormData` |
| `Autocomplete` | label, description, error, status, counter | hidden input synced from selected value | selected value, empty state, keyboard behavior, and `FormData` |
| `TagInput` | label, description, error, status, counter | repeated hidden inputs, one per tag | add/remove keyboard behavior, duplicate prevention, max-tags behavior, and repeated `FormData` values |
| `FileDropzone` | label, description, error, status, counter | native file input | file selection/drop behavior, multipart route smoke coverage, and `FormData` |

#### Migration Gates

- Production code must use `Form` or an approved design-system adapter instead of lowercase JSX/HTML `<form>`.
- React Router route actions must use `RouterForm` from `@chase-sets/design-system/react-router`.
- `pnpm run check:no-legacy-forms` must pass in final mode with an empty `scripts/no-legacy-forms.baseline.json`.
- Migration slices must preserve submitted field names, hidden fields, multipart uploads, GET filters, destructive actions, and external submit controls.

### Legacy Removal and Guardrails

Final blocking guardrail evidence:

```text
pnpm run check:no-legacy-forms
Legacy form guardrail passed in final mode for 0 file(s) with baseline entries.
```

The guardrail detects:

- Lowercase JSX `<form>` elements in production files outside exact approved implementation files.
- Imperative `React.createElement("form")` and `createElement("form")`.
- Direct framework `Form` imports from React Router/Remix.
- Framework `Form` aliases, namespace member usage, and re-exports.
- Broad allowlists and stale baseline entries.

The checked-in baseline file is intentionally empty:

```text
scripts/no-legacy-forms.baseline.json
```

### Verification Commands

Latest local evidence collected on this branch:

```text
pnpm --filter @chase-sets/design-system run test -- src/__tests__/form-system.test.tsx src/__tests__/design-system.test.tsx
pnpm --filter @chase-sets/design-system run typecheck
pnpm run check:no-legacy-forms
pnpm run check:no-any
pnpm run test:no-legacy-forms
pnpm run format:check
pnpm run test:form-migration-smoke
pnpm run verify:static
pnpm run verify:typecheck
```

`verify:static` passes. It still prints pre-existing advisory structure warnings for single-slice support-file relocation; those warnings are unrelated to the form milestone and do not fail the gate.

### Remaining Release Steps

- Publish the branch and open a PR with this audit summarized in the PR body.
- Confirm CI passes on the PR.
- Enter and pass the merge queue after required review.
- Verify staging after merge.
- Verify production after promotion or rollout.
- Remove the generated local plan after its final content is captured in PR details.
- Delete the temporary worktree/branch and refresh `main` after merge and cleanup.

## Milestone #12 — Legacy Eradication

This is the traceability artifact for GitHub milestone #12, "Design System Legacy Pattern Eradication".

### Scope

Milestone #12 removes legacy design-system usage with no production exceptions:

- no production `Ui*` compatibility aliases
- no public or production dependency on `packages/design-system/src/components/ui/*`
- no missing mobile labels on legacy responsive tables
- no route-local print styling islands
- no production app-local styling or raw-control exceptions
- canonical print primitives, source-layout cleanup, final guardrails, documentation, and retained visual/accessibility evidence

### Delivery Controls

Issue #960 owns milestone delivery controls. Until a GitHub Project or alternate tracker is linked, this audit and `DESIGN_SYSTEM_LEGACY_INVENTORY.json` are the local execution ledger.

Closure rules:

- #960 establishes issue owner/status tracking before implementation issues close.
- #945 owns the generated inventory and must stay current as migrations land.
- Phase 3 consumer migrations cannot close before their prerequisite primitive or relocation issues.
- Phase 4 guardrails cannot close before relevant migrations and #959 source-layout relocation.
- #956 is the final closure issue and must prove every inventory entry is migrated, removed, relocated, or superseded by another issue in milestone #12.

### Generated Inventory

Regenerate the ledger with:

```powershell
pnpm run ops design-system:legacy-inventory --write-ledger
```

Validate scanner behavior with:

```powershell
pnpm run test:design-system-legacy-inventory
```

Regenerate retained representative visual/accessibility evidence with:

```powershell
pnpm run ops design-system:legacy-evidence --write
```

Validate evidence behavior with:

```powershell
pnpm run test:design-system-legacy-evidence
```

Current generated ledger:

- `packages/design-system/DESIGN_SYSTEM_LEGACY_INVENTORY.json`
- Generated by: `pnpm run ops design-system:legacy-inventory --write-ledger`
- Files with findings: 0

Current retained visual/accessibility evidence:

- `packages/design-system/DESIGN_SYSTEM_LEGACY_VISUAL_ACCESSIBILITY_EVIDENCE.json`
- Generated by: `pnpm run ops design-system:legacy-evidence --write`
- Representative surfaces covered: Fulfillment print document, Support request tables, Catalog authoring controls, Discovery commerce comparison rows, Public Presence waitlist CTA, Identity account badges, validation primitives, and hidden-input policy.

### Current Finding Counts

| Category | Count | Primary milestone issues |
| --- | ---: | --- |
| `canonicalUiSourceFile` | 0 | #959 |
| `legacyUiEntrypointExport` | 0 | #950, #951 |
| `legacyUiSourceImport` | 0 | #959, #950, #951 |
| `legacyAliasImport` | 0 | #949, #950, #951 |
| `legacyAliasJsxUsage` | 0 | #949, #950, #951 |
| `legacyResponsiveTableCellMissingLabel` | 0 | #952 |
| `embeddedStyle` | 0 | #946, #947, #953 |
| `routeLocalClassName` | 0 | #953, #954, #955 |
| `rawControl` | 0 | #953, #954, #955 |
| `hiddenInput` | 0 | #953 policy matrix |
| `rawTable` | 0 | #952, #953 |

### Owner Coverage

The generated ledger currently has no production findings. Historical migrations covered Auth, Catalog, Checkout, Deployable composition, Design System, Discovery, Experience, Fulfillment, Identity, Inventory, Marketplace, Ordering, Payments, Platform Operations, Pricing, Public Presence, Reputation, Settlement, and Support.

Owner assignment remains `unassigned until scheduled by #960` until implementation ownership is recorded in the linked GitHub issue, PR, or external tracker.

### Relocation Progress

- `ProductOptions` and its formatting helpers moved from `components/ui/marketplace-product-options.tsx` to `components/data-display/product-options.tsx`, reducing canonical `components/ui/*` source files from 17 to 16 while preserving public exports through the package entrypoint.
- Remaining compatibility adapters moved from `packages/design-system/src/components/ui/*` to `packages/design-system/src/components/compat/*`, and the package entrypoint now points at the relocated adapter source. The generated ledger now reports zero `canonicalUiSourceFile` and zero `legacyUiSourceImport` findings for #959.
- Catalog component admin contracts/pages no longer import through a `features/components/ui/*` path, removing the final source-layout false positive from #959 while preserving the route UI implementation under `features/components/view/*`.

### Consumer Migration Progress

- Support request pages no longer import or render `Ui*` compatibility aliases. Support request and available-flow tables now use `DataTable` column metadata, removing all `legacyResponsiveTableCellMissingLabel` findings from the generated inventory.
- Identity account profile/security pages and Settlement payout readiness/setup/detail pages no longer import or render `Ui*` compatibility aliases. Remaining Identity and Settlement findings are tracked through hidden-input and route-local styling policy work instead of compatibility alias migration.
- Fulfillment packing slips now render through design-system-owned `PackingSlipPrintDocument` primitives under `components/print`, clearing the route-local print style island, raw print table, and print toolbar raw controls from the generated inventory.
- Public `Ui*` compatibility exports were removed from `packages/design-system/src/index.ts`, and design-system tests now use canonical component names. The generated ledger now reports zero `legacyUiEntrypointExport`, `legacyAliasImport`, and `legacyAliasJsxUsage` findings.
- App hidden fields now render through design-system-owned `HiddenInput`/`HoneypotInput` primitives, clearing all `hiddenInput` findings from the generated inventory.
- Catalog source-observation authoring controls, Discovery commerce comparison rows, public waitlist sticky layout/discount value, account badges, payment method auto grids, and support/detail wrap-safe text now consume design-system primitives instead of route-local class names. The generated ledger now reports zero `routeLocalClassName`, `rawControl`, and `rawTable` findings.
- Representative visual/accessibility evidence is retained in `DESIGN_SYSTEM_LEGACY_VISUAL_ACCESSIBILITY_EVIDENCE.json` and is guarded by `pnpm run test:design-system-legacy-evidence`.

### Evidence Requirements

Every ledger entry includes:

- owner
- finding categories and counts
- milestone issue targets
- phase
- outcome classification
- prerequisites
- closure evidence requirements
- current status

As code changes land, update the generated ledger and this audit summary. Final closure requires `DESIGN_SYSTEM_LEGACY_INVENTORY.json` to show no open production legacy entries, or only entries explicitly superseded by another closed issue in milestone #12.
