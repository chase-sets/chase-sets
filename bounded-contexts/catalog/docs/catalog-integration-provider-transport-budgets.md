# Catalog Integration Provider Transport Budgets

This document defines the proof criteria, reliability vocabulary, and first-slice budgets that must be satisfied before the real-provider proof runs for the rebuilt Catalog control plane.

The primary operator path stays front and center: pull provider data, review Source Observations, and promote eligible sources into Catalog Items or Catalog-owned references. Supporting diagnostics, profile authoring, lifecycle recovery, audit, and governance flows exist to explain or unblock that path. They are not peers that can bury the import-to-promotion workflow.

This rebuild is not a migration of retired admin structure. For legacy control-plane surfaces, "retire", "remove", "deprecate", and "cleanup" mean complete removal from code, product patterns, route/API/client/read-model behavior, tests, fixtures, seeds, screenshots, documentation, runbooks, release notes, operator instructions, aliases, flags, fallback branches, redirects, support-only routes, compatibility aliases, compatibility shims, and migration shims. Data loss is acceptable for unlaunched legacy state when it simplifies the launch contract.

## Ownership

Catalog owns provider transport readiness semantics, proof criteria, operator blockers, Source Observation read models, and first-slice performance budgets.

Provider adapters own provider domains, auth/session behavior, endpoint paths, provider-native pagination, cooldowns, retries, rate limits, raw response parsing, and transport diagnostics.

Catalog provider profiles own mapping semantics, duplicate prevention, Source Observation structure, selected Options, reference hierarchy, external references, and promotion command plans. Provider adapters must not decide which provider facts become Catalog fields or whether an observation is promotable.

## First-Slice Proof Provider

| Role | Provider unit | Decision | Why |
| --- | --- | --- | --- |
| Primary proof | `tcgdex:pokemon:single-card:source-observation-import` | Selected as primary proof | Active profile-backed path that exercises provider scope selection, language/Series/Expansion option queries, Expansion/card payload fetches, image and metadata mapping, Source Observation profile metadata, and promotion planning without provider-specific Admin branches. |
| Supplemental transport evidence | `tcgplayer:pokemon:single-card:source-observation-import` | Not selected as primary proof | Useful for credential/session/domain/rate-limit diagnostics, but its promotion path is not launch-active. It cannot be used to satisfy the first-slice import-to-promotion proof unless the provider choice is explicitly changed with evidence. |

## Proof Criteria

| Criterion | Required evidence |
| --- | --- |
| Provider scope option-query selection | Operator can select TCGdex provider, unit, language, Series, and Expansion through bounded option queries. |
| Provider pagination or multi-step retrieval | Proof traverses more than one provider transport step before producing Source Observations. TCGdex must fetch Expansion metadata and then card payloads. |
| Image and metadata mapping | Source Observations include provider image/provenance metadata and normalized facts required for review and promotion preview. |
| Provider transport degraded condition | The proof packet maps at least one degraded provider transport condition to the canonical `providerTransport` and blocker vocabulary. |
| Source Observation profile metadata | Created observations retain provider key, unit key, source profile version, external key, source URL, source update time when available, and safe provenance. |
| Promotion preview counts | The proof packet records eligible, blocked, skipped, conflict, and failed counts before any Catalog write. |
| Redaction-safe evidence | The proof packet excludes credentials, cookies, raw payload bodies, full provider URLs, account/user identifiers, provider-controlled labels, and provider-sensitive material; the security/privacy launch gate still owns launch security/privacy approval. |

## Provider Transport Reliability Vocabulary

| Transport condition | Workbench category | Blocker | Operator state |
| --- | --- | --- | --- |
| HTTP 429 or provider rate-limit evidence | `rate-limit` | `provider-transport-rate-limited` | Degraded; preserve context and show retry/cooldown evidence. |
| Adapter cooldown or backpressure | `throttle` | `provider-transport-throttled` | Degraded; allow only safe retry or cached reads. |
| Quota exhausted | `quota` | `provider-transport-quota-exceeded` | Blocked; wait, change credentials, or change scope. |
| Request timeout or abort | `timeout` | `provider-transport-timeout` | Degraded; retry only through bounded command paths. |
| Cursor/page boundary failure | `pagination-failure` | `provider-transport-pagination-failure` | Blocked; do not continue a partial page as success. |
| Some payloads failed while safe rows remain | `partial-data` | `provider-transport-partial-data` | Degraded; show partial counts and failure groups. |
| Stale option-query cache served | `stale-cache` | `provider-transport-stale-cache` | Degraded; retain selections and label stale data. |
| Provider unavailable or uncategorized retryable failure | `degraded-provider` | `provider-transport-degraded` | Degraded or blocked based on action safety. |

Unknown provider transport conditions fail closed. They must not collapse to generic disabled states or raw provider error bodies.

## First-Slice Performance Budgets

| Surface | p95 | Timeout | Freshness | Pagination | Verification |
| --- | ---: | ---: | --- | --- | --- |
| Primary workbench initial load | 750 ms | 5000 ms | Fresh within 15s; stale after 60s; unavailable after 300s | none; representative 10,000 job/progress rows through composed reads | Smoke and E2E |
| Provider scope selector | 250 ms | 1500 ms | Fresh within 15s; stale after 60s; unavailable after 300s | option cache pages 50 default, 200 max | Unit and smoke |
| Source Observation review table | 500 ms | 3000 ms | Fresh within 5s; stale after 30s; unavailable after 180s | cursor, 100 default, 500 max; representative 100,000 rows | Unit, explain-plan, load sample |
| Promotion preview | 750 ms | 5000 ms | Fresh within 15s; stale after 90s; unavailable after 300s | cursor, 100 default, 500 max; representative 50,000 rows | Unit, explain-plan, load sample |
| Durable job progress | 300 ms | 2000 ms | Fresh within 5s; stale after 30s; unavailable after 180s | SSE replay, 50 default, 200 max; representative 10,000 rows | Smoke and load sample |
| Real-provider proof run | 15 minutes | 20 minutes | Evidence must link current readiness, job, review, and promotion-preview freshness | cursor, 100 default, 500 max; representative 50,000 rows where storage is involved | Real-provider proof, smoke, load sample, docs review |

Provider option-query cache policy remains:

- fresh TTL: 15 minutes;
- stale TTL: 24 hours;
- default page size: 50;
- max page size: 200;
- degraded fallback: serve stale cache only when still inside the stale window; otherwise block instead of retrying unbounded live calls.

## Verification Expectations

The first-slice real-provider proof is not complete until it links:

- selected TCGdex provider scope and active profile version;
- option-query evidence for language, Series, and Expansion;
- import/job progress evidence showing bounded retry/resume/cancel behavior where relevant;
- Source Observation review rows with redacted evidence and profile metadata;
- promotion preview counts before Catalog writes;
- at least one degraded transport condition mapped to the canonical category and blocker;
- screenshots or logs proving the primary import-to-promotion path is the default, not buried behind support workspaces.

The durable proof command is:

```powershell
pnpm run catalog:real-provider-proof -- --environment staging --transport-mode staging-provider-proof
```

It emits a redacted `catalog-real-provider-proof/v1` packet. See [Catalog Integration Real-Provider Proof](./catalog-integration-real-provider-proof.md) for packet fields, redaction rules, live/local usage, and rollout, security/privacy, and transport-budget handoff expectations.

Redaction and privacy hardening for evidence produced by this proof is owned by the security/privacy launch gate. Complete deletion of old control-plane pages, routes, module patterns, route/API/client/read-model behavior, documentation, tests, fixtures, seeds, screenshots, runbooks, release notes, and operator instructions follows once the rebuilt workbench is accepted.

## Forbidden Outcomes

The first slice must not ship:

- migration of retired admin structure;
- support-only preserved retired routes;
- compatibility redirects or hidden flags for retired screens;
- provider-specific Admin branches outside the profile/adapter contracts;
- raw JSON broad patch or raw provider payload escape hatches;
- tests, fixtures, seeds, screenshots, documentation, runbooks, release notes, or operator instructions that tell users how to use retired behavior.
