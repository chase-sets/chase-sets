# Catalog Integration Audit Evidence

Catalog integration audit evidence is the canonical, append-only record of provider integration lifecycle facts. It gives Admin timelines, support investigations, release verification, and future projection rebuilds one stable model instead of asking UI modules to infer history from profile JSON, durable job rows, or provider payloads.

The authoritative TypeScript model lives in:

```text
bounded-contexts/catalog/features/source-observations/api/catalog-integration-audit-evidence.ts
```

## Ownership

- Catalog Source Observations owns audit/evidence event names, record shape, redacted evidence summaries, Admin timeline DTOs, and projection interpretation.
- Provider adapters own raw transport payloads, credentials, sessions, and transport diagnostics. Catalog audit records may retain only redacted adapter summaries.
- Platform owns durable job mechanics and generic event/projection infrastructure. Catalog owns the Catalog-specific meaning of integration audit records.

## Record Contract

Every audit/evidence record uses `schemaVersion: catalog-audit-evidence-record-v1` and `compatibilityPolicy: audit-evidence-record`.

Records include:

- `eventId`
- `eventName`
- category
- `occurredAt`
- actor kind, user id, and account id when available
- `providerKey`
- `unitKey`
- profile pointer when applicable
- section, job, observation, Catalog Item, promotion plan, and reapply identifiers when applicable
- governed evidence entries
- diagnostic codes and diagnostic paths when diagnostics were present

The model is append-only. Corrective workflows should append a new event rather than rewriting earlier evidence.

## Event Inventory

Canonical event names are:

- `profile-created`
- `profile-cloned`
- `profile-section-edited`
- `fixture-validation-run`
- `dry-run-executed`
- `activation-readiness-evaluated`
- `profile-activated`
- `profile-deprecated`
- `profile-rolled-back`
- `profile-retired`
- `import-job-started`
- `import-job-completed`
- `import-job-failed`
- `source-observation-recorded`
- `source-observation-changed`
- `source-observation-promoted`
- `source-observation-rejected`
- `source-observation-deferred`
- `promotion-plan-generated`
- `promotion-plan-executed`
- `reapply-run-executed`
- `adapter-readiness-changed`
- `provider-credential-readiness-changed`
- `diagnostics-present`

These names are provider-neutral. Adding a provider, product domain, or product form must not create provider-specific audit event names.

## Evidence Rules

Each evidence entry names one governed data class from the Catalog integration data-governance policy. Audit entries may retain summaries, hashes, identifiers, status, counts, diagnostic codes, and redacted previews. They must not retain provider credentials, cookies, authorization headers, seller/account facts, raw provider bodies, prices, inventory, quantities, listing facts, or provider-controlled commerce values that Catalog does not own.

Raw provider payload evidence is reference-only for Catalog audit retention. If an adapter observes a raw provider body, the audit record may retain safe metadata such as provider key, source URL, content hash, request scope, and diagnostic code, but not the raw body.

Credential readiness evidence may retain readiness state, requirement, source kind, redacted secret reference labels, provider key, unit key, checked timestamp, and diagnostic code. It must not retain token, cookie, password, bearer value, session id, or provider account secret material.

## Admin Timeline Projection

`audit-evidence-timeline` consumes canonical audit/evidence timeline entries. The Admin read model exposes the event id, occurrence time, event name, category, actor ids, provider key, ingestion unit, profile pointer, section key, related job/observation/Catalog Item ids, promotion plan id, reapply run id, evidence summaries, governed evidence entries, and diagnostic codes.

The timeline projection can lag source writes. UI modules should use the read-model freshness/SLO contract to render fresh, stale, lagging, partial, or unavailable states; they should not read lower-level profile, job, or payload tables to reconstruct history.

## Durable Source Expectations

Future persistence/projection implementation should store or project `catalog-audit-evidence-record-v1` records as append-only Catalog-owned evidence. Query paths should support provider, ingestion unit, profile/version, event category, related job, related observation, and occurrence-time filters. High-volume audit views must use cursor pagination and supporting keyset indexes; broad global scans are not acceptable for operator timelines.

## Related Docs

- [Admin Control Plane Query Contracts](./admin-control-plane-query-contracts.md)
- [Admin Control Plane Read-Model SLOs](./admin-control-plane-read-model-slos.md)
- [Catalog Integration Data Governance](./catalog-integration-data-governance.md)
- [Catalog Integration Credential Readiness](./catalog-integration-credential-readiness.md)
- [Catalog Integration Schema Compatibility](./catalog-integration-schema-compatibility.md)
- [Catalog Integration Job Consistency](./catalog-integration-job-consistency.md)
