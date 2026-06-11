# Catalog Integration Data Governance

Catalog Integration Control Plane data governance defines what provider-controlled data can be stored, shown, exported, logged, sampled, or retained while Catalog turns external provider facts into reviewed Source Observations and Catalog truth.

The authoritative executable policy lives in `bounded-contexts/catalog/features/source-observations/api/catalog-integration-data-governance.ts`.

## Ownership

- Catalog source-observations owns the policy contract, Source Observation payload references, dry-run evidence, fixture evidence, diagnostics, audit summaries, job summaries, and Admin Control Plane read-model constraints.
- Provider adapters own raw transport payload acquisition, provider endpoint DTOs, credentials, sessions, throttling, provenance envelopes, and sanitized transport diagnostics.
- Ops, Security, and Legal own provider-data signoff decisions. Catalog owns the launch gate that prevents retained real-provider samples or raw-provider evidence views from shipping without that signoff or an explicit retained-data exception.

## Governed Data Classes

| Data class | Retention | Raw body policy | Admin visibility | Export policy |
| --- | --- | --- | --- | --- |
| Raw provider payload | Request only | Forbidden | Security/legal reviewed only | No export |
| Sampled provider payload | Resettable pre-launch | Signoff required | Security/legal reviewed only | Reviewed evidence package only |
| Fixture payload | Resettable pre-launch | Signoff required | Support redacted detail | Reviewed evidence package only |
| Dry-run input payload | Request only | Signoff required | Support redacted detail | Redacted summary only |
| Dry-run output evidence | Retained redacted summary | Redacted preview only | Catalog manage summary | Redacted summary only |
| Engine diagnostic | Retained redacted summary | Redacted preview only | Catalog manage summary | Redacted summary only |
| Provider transport diagnostic | Retained redacted summary | Redacted preview only | Support redacted detail | Redacted summary only |
| Provider credential readiness | Retained redacted summary | Redacted preview only | Support redacted detail | Redacted summary only |
| Audit evidence | Retained audit summary | Redacted preview only | Support redacted detail | Reviewed evidence package only |
| Job progress summary | Retained redacted summary | Redacted preview only | Catalog manage summary | Redacted summary only |

Raw provider payload bodies are not Catalog truth. Catalog truth is normalized Source Observation facts, reviewed Catalog commands, hashes, stable references, diagnostic codes, and audit-safe summaries.

## Signoff Gate

Provider-data policy/legal signoff is required before any release, fixture set, dry-run workflow, Admin view, or launch evidence does one of these things for a real provider:

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

Redacted summaries may include provider key, ingestion-unit key, profile version, fixture flow, source URL, source hash, diagnostic code, path, owner, uses, retry count, HTTP status, scope, credential readiness state, credential source kind, job id, and normalized Catalog facts.

## Admin UI And API Rules

Admin Control Plane read models must name the governed data classes they expose. The typed map lives in `catalogAdminControlPlaneQueryGovernanceDataClasses`.

- Dry-run, fixture, diagnostic, audit, source review, promotion, job, and transport views show normalized facts, references, hashes, diagnostic codes, counts, and redacted previews.
- Normal Catalog managers should not see raw provider bodies.
- Support detail may see redacted provider diagnostic previews.
- Security/legal reviewed access is required for raw provider sample inspection, and only when the signoff gate allows the retained body.
- Export and download flows must use redacted summaries unless the reviewed evidence package path is explicitly approved.

## Logs, Metrics, And Artifacts

Logs, metrics, traces, screenshots, CI artifacts, and launch evidence may include bounded identifiers, counts, status, retry, scope, and redacted diagnostic text. They must not include raw provider payload bodies, provider credentials, provider cookies, seller/account data, or provider-controlled commerce fields that Catalog does not own.

Metric labels must stay bounded and must not include provider product ids, SKU ids, seller ids, account ids, job ids, request URLs, or raw paths from provider payloads.

## Provider Notes

- TCGdex: public JSON payloads may be used for deterministic fixture-backed contract tests, but retained real-provider samples still require the signoff gate. The #1062 real-provider proof packet intentionally reports `sourceHash: null` until the governed hash material and retention policy define how real-provider payload content hashes are computed and retained. The packet must redact raw payload bodies, full provider URLs, provider-controlled labels, credentials, cookies, and asset URLs.
- TCGplayer: cookie/session auth, seller/account data, price, inventory, listing, latest sales, and marketplace account identifiers are excluded from Catalog truth and hashes. The TCGplayer automation runbook remains the transport runbook for credential handling, throttling, and diagnostic redaction. Catalog stores only redacted credential-readiness state and source-kind metadata.
- Scrydex/Scryfall-style and MTGJSON validation: fixture-backed validation may use redacted sample payloads only after the signoff gate is satisfied for the provider and data class. Rulings, legalities, prices, seller/inventory facts, and other non-Catalog-owned fields stay outside Catalog truth unless a later owner contract changes the boundary.

## Release Checklist

Before enabling live provider sampling, retained fixtures, retained dry-run evidence, or provider-data export:

1. Name each governed data class and provider key affected by the release.
2. Confirm raw provider payload bodies are not stored, logged, shown, or exported unless policy/legal signoff and a retained-data exception allow it.
3. Confirm sampled payload, fixture body, and dry-run body retention has policy/legal signoff, owner, reason, removal criteria, and deletion/rotation plan.
4. Confirm Admin UI surfaces show normalized facts, hashes, references, diagnostic codes, or redacted previews instead of raw provider bodies.
5. Confirm logs, metrics, traces, screenshots, CI artifacts, and launch evidence exclude provider secrets, account/seller data, and raw provider bodies.
6. Confirm provider-specific constraints for TCGdex, TCGplayer, Scrydex/Scryfall-style, MTGJSON, and future providers are documented before live sampling.

## Related Issues

- #794 owns provider payload, fixture, dry-run, diagnostics, and audit evidence data governance.
- #803 owns provider-data policy/legal signoff criteria.
- #782 owns provider credential storage, validation, rotation, and readiness.
- #783 owns canonical audit/evidence event persistence.
- #784 owns fixture repository lifecycle.
- #788 owns Admin RBAC enforcement.
- #801 owns rollout modes, feature flags, and kill switches.
