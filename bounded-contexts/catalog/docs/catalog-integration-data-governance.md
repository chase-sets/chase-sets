# Catalog Integration Data Governance

Catalog Integration Control Plane data governance defines what provider-controlled data can be stored, shown, exported, logged, sampled, or retained while Catalog turns external provider facts into reviewed Source Observations and Catalog truth.

The authoritative executable policy lives in `bounded-contexts/catalog/features/source-observations/api/catalog-integration-data-governance.ts`.

## Ownership

- Catalog source-observations owns the policy contract, Source Observation payload references, dry-run evidence, fixture evidence, diagnostics, audit summaries, job summaries, and Admin Control Plane read-model constraints.
- Provider adapters own raw transport payload acquisition, provider endpoint DTOs, credentials, sessions, throttling, provenance envelopes, and sanitized transport diagnostics.
- Ops, Security, and Legal own provider-data approval decisions. Catalog owns the launch gate that prevents retained real-provider samples or raw-provider evidence views from shipping without that approval or an explicit retained-data exception.

## Governed Data Classes

| Data class | Retention | Raw body policy | Admin visibility | Export policy |
| --- | --- | --- | --- | --- |
| Raw provider payload | Request only | Forbidden | Security/legal reviewed only | No export |
| Sampled provider payload | Resettable pre-launch | Approval required | Security/legal reviewed only | Reviewed evidence package only |
| Fixture payload | Resettable pre-launch | Approval required | Support redacted detail | Reviewed evidence package only |
| Dry-run input payload | Request only | Approval required | Support redacted detail | Redacted summary only |
| Dry-run output evidence | Retained redacted summary | Redacted preview only | Catalog manage summary | Redacted summary only |
| Engine diagnostic | Retained redacted summary | Redacted preview only | Catalog manage summary | Redacted summary only |
| Provider transport diagnostic | Retained redacted summary | Redacted preview only | Support redacted detail | Redacted summary only |
| Provider credential readiness | Retained redacted summary | Redacted preview only | Support redacted detail | Redacted summary only |
| Provider usage and credit summary | Retained redacted summary | Redacted preview only | Catalog manage summary | Redacted summary only |
| Audit evidence | Retained audit summary | Redacted preview only | Support redacted detail | Reviewed evidence package only |
| Job progress summary | Retained redacted summary | Redacted preview only | Catalog manage summary | Redacted summary only |

Raw provider payload bodies are not Catalog truth. Catalog truth is normalized Source Observation facts, reviewed Catalog commands, hashes, stable references, diagnostic codes, and audit-safe summaries.

## Approval Gate

Provider-data policy/legal review and approval is required before any release, fixture set, dry-run workflow, Admin view, or launch evidence does one of these things for a real provider. The [Catalog Integration Security Privacy Launch Gate](./catalog-integration-security-privacy-launch-gate.md), enforced by `scripts/check-structure/catalog-integration-security-privacy-launch-gate.ts`, blocks release when this approval or retained-data exception evidence is missing:

- stores a raw provider body;
- retains a real-provider sample;
- retains a fixture payload body;
- retains a dry-run payload body;
- shows raw provider content in Admin;
- exports provider content;
- includes provider imagery in evidence views.

Retained sampled payloads, fixture bodies, and dry-run bodies also require a retained-data exception issue that names the owner, provider, reason, allowed retention window, deletion or rotation behavior, and removal criteria.

## Redaction

All provider-controlled data classes must redact provider secrets, account/seller facts, and commerce signals that are not Catalog truth before they appear in Admin, logs, metrics, traces, screenshots, CI artifacts, launch evidence, diagnostics, or audit summaries.

Representative sensitive or excluded paths include:

- authorization headers, cookies, tokens, secrets, and passwords;
- TCGplayer `TCGAuthTicket_Production` cookie material;
- seller ids, seller keys, seller names, seller emails, phone numbers, and account-specific marketplace identifiers;
- price, market price, inventory, quantity, listing, latest sales, and order/message facts unless a different bounded context owns and governs them;
- raw provider request or response bodies.

Redacted summaries may include provider key, ingestion-unit key, profile version, fixture flow, source URL, source hash, diagnostic code, path, owner, uses, retry count, HTTP status, scope, credential readiness state, credential source kind, job id, normalized Catalog facts, estimated provider request count, actual provider request count, page count, cache hit/miss count, usage-check state, and credit/degraded diagnostics.

## Admin UI And API Rules

Admin Control Plane read models must name the governed data classes they expose. The typed map lives in `catalogAdminControlPlaneQueryGovernanceDataClasses`.

- Dry-run, fixture, diagnostic, audit, source review, promotion, job, and transport views show normalized facts, references, hashes, diagnostic codes, counts, and redacted previews.
- Normal Catalog managers should not see raw provider bodies.
- Support detail may see redacted provider diagnostic previews.
- Security/legal reviewed access is required for raw provider sample inspection, and only when the approval gate allows the retained body.
- Export and download flows must use redacted summaries unless the reviewed evidence package path is explicitly approved.

## Logs, Metrics, And Artifacts

Logs, metrics, traces, screenshots, CI artifacts, and launch evidence may include bounded identifiers, counts, status, retry, scope, and redacted diagnostic text. They must not include raw provider payload bodies, provider credentials, provider cookies, seller/account data, or provider-controlled commerce fields that Catalog does not own.

Metric labels must stay bounded and must not include provider product ids, SKU ids, seller ids, account ids, job ids, request URLs, or raw paths from provider payloads.

## Provider Notes

- TCGdex: public JSON payloads may be used for deterministic fixture-backed contract tests, but retained real-provider samples still require the approval gate. The real-provider proof packet intentionally reports `sourceHash: null` until the governed hash material and retention policy define how real-provider payload content hashes are computed and retained. The packet must redact raw payload bodies, full provider URLs, provider-controlled labels, credentials, cookies, and asset URLs.
- TCGplayer: cookie/session auth, seller/account data, price, inventory, listing, latest sales, and marketplace account identifiers are excluded from Catalog truth and hashes. The TCGplayer automation runbook remains the transport runbook for credential handling, throttling, and diagnostic redaction. Catalog stores only redacted credential-readiness state and source-kind metadata.
- Retired Scrydex/Scryfall-style Magic proof and MTGJSON validation: fixture-backed validation may use redacted sample payloads only after the approval gate is satisfied for the provider and data class. The Scrydex Scryfall-style Magic proof is quarantined as explicit test-scoped contract evidence only; it is not a production Magic sync provider, import choice, or rollout/UAT dependency. Rulings, legalities, prices, seller/inventory facts, and other non-Catalog-owned fields stay outside Catalog truth unless a later owner contract changes the boundary.
- Magic production sync: MTGJSON, Scryfall, and TCGplayer Magic production activation is governed by [Catalog Integration Magic Production Signoff](./catalog-integration-production-signoff.md#magic). Scryfall is the primary card-print and image-evidence source, MTGJSON is the set/reference-data and cross-check source, and TCGplayer Magic is limited to marketplace product, SKU, sealed-product, and external-reference identity. The #2039 interface-only staging UAT accepted after PR #2108 proves the shared importer path; production controls still require the Magic signoff reference before production-like Magic writes are opened.
- One Piece production sync: Scrydex is the preferred paid seed provider after source-authority approval; TCGplayer remains the marketplace identity and SKU evidence provider; Bandai official pages are validation-only unless legal/source-authority approval explicitly permits ingestion; fallback/community sources are comparison-only unless separately approved. Scrydex imports must be bulk-first and credit-aware: use list/search pagination and minimal field selection whenever possible, avoid one-call-per-record normal flows, and retain only redacted request/page/cache/usage summaries. Production activation remains blocked until [Catalog Integration One Piece Production Signoff](./catalog-integration-production-signoff.md#one-piece) is complete and the interface-only staging UAT passes.
- Lorcana production sync: LorcanaJSON is the preferred free bulk-first card/set reference provider; Lorcast is a free supplemental set/card, image, TCGplayer-id, legality, and lightweight-price source; TCGplayer remains the marketplace identity and SKU evidence provider through the existing Chase Sets automation path; Scrydex is a paid supplement using shared credentials and credit-aware access; Disney Lorcana/Ravensburger official pages are validation-only unless legal/source-authority approval explicitly permits ingestion. Scrydex imports must be bulk-first and use shared `SCRYDEX_API_KEY` and `SCRYDEX_TEAM_ID` settings once per environment, never per-game Scrydex secrets. Milestone #50 accepted the interface-only staging UAT and downstream projection smoke on SHA `0fc9f20279428b78d19c079cb61085a7f6d0cfd6`; production-like Lorcana writes still require the [Catalog Integration Lorcana Production Signoff](./catalog-integration-production-signoff.md#lorcana) reference and rollout controls to name that accepted approval/evidence.

## Release Checklist

Before enabling live provider sampling, retained fixtures, retained dry-run evidence, or provider-data export:

1. Name each governed data class and provider key affected by the release.
2. Confirm raw provider payload bodies are not stored, logged, shown, or exported unless policy/legal approval and a retained-data exception allow it.
3. Confirm sampled payload, fixture body, and dry-run body retention has policy/legal approval, owner, reason, removal criteria, and deletion/rotation plan.
4. Confirm Admin UI surfaces show normalized facts, hashes, references, diagnostic codes, or redacted previews instead of raw provider bodies.
5. Confirm logs, metrics, traces, screenshots, CI artifacts, and launch evidence exclude provider secrets, account/seller data, and raw provider bodies.
6. Confirm provider-specific constraints for TCGdex, TCGplayer, Scrydex/Scryfall-style, MTGJSON, Scrydex One Piece, Bandai validation, and future providers are documented before live sampling.
7. For Magic production sync, confirm the [Magic production signoff](./catalog-integration-production-signoff.md#magic) is complete before MTGJSON, Scryfall, or TCGplayer Magic activation.
8. For One Piece production sync, confirm the [One Piece production signoff](./catalog-integration-production-signoff.md#one-piece) is complete before Scrydex or TCGplayer One Piece activation.
9. For Lorcana production sync, confirm the [Lorcana production signoff](./catalog-integration-production-signoff.md#lorcana) is complete before LorcanaJSON, Lorcast, Scrydex, or TCGplayer Lorcana activation.

## Related Policies

- This policy owns provider payload, fixture, dry-run, diagnostics, and audit evidence data governance.
- Provider-data policy/legal approval criteria are owned by the data-governance policy.
- Provider credential storage, validation, rotation, and readiness are documented in [Catalog Integration Credential Readiness](./catalog-integration-credential-readiness.md).
- Canonical audit/evidence event persistence is documented in [Catalog Integration Audit Evidence](./catalog-integration-audit-evidence.md).
- Admin RBAC enforcement is documented in [Catalog Integration Admin Control Plane RBAC](./catalog-integration-admin-control-plane-rbac.md).
- Magic production provider authority, retained-data exceptions, and UAT signoff are documented in [Catalog Integration Magic Production Signoff](./catalog-integration-production-signoff.md#magic).
- One Piece production provider authority, Scrydex credit policy, retained-data exceptions, and UAT signoff are documented in [Catalog Integration One Piece Production Signoff](./catalog-integration-production-signoff.md#one-piece).
- Lorcana production provider authority, Scrydex credit policy, retained-data exceptions, official validation, downstream smoke, and UAT signoff are documented in [Catalog Integration Lorcana Production Signoff](./catalog-integration-production-signoff.md#lorcana).
- Rollout modes, feature flags, and kill switches are governed outside this policy.
