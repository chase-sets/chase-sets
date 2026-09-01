# Catalog Integration Real-Provider Proof

This proof exercises the rebuilt Catalog control plane's primary path with the launch-selected real provider adapter:

1. select TCGdex provider scope through bounded option queries;
2. pull provider data through the TCGdex ProviderAdapter;
3. review redacted Source Observation evidence with profile metadata;
4. capture promotion-preview counts before any Catalog Item write;
5. link the [security/privacy launch gate](./catalog-integration-security-privacy-launch-gate.md), its `scripts/check-structure/catalog-integration-security-privacy-launch-gate.test.mjs` proof, provider transport budget, and rollout approval evidence.

The proof is not a migration or reskin of retired admin structure. Health, profile authoring, validation, lifecycle, RBAC, observability, audit, and rollout controls remain supporting workflows. They explain or unblock import-to-promotion; they must not bury it.

## Provider And Scope

The first-slice provider is:

- provider: `tcgdex`
- unit: `tcgdex:pokemon:single-card:source-observation-import`
- language: `en`
- Series: `swsh`
- Expansion: `swsh3`

This scope satisfies the provider transport budgets because it exercises language, Series, and Expansion option queries, multi-step Expansion/card retrieval, image and metadata mapping, Source Observation profile metadata, promotion-preview evidence, and canonical degraded transport handling without provider-specific Admin branches.

TCGplayer remains supplemental transport evidence for credential/session/rate-limit behavior. It does not satisfy the primary import-to-promotion proof unless the provider choice is explicitly changed with new transport-budget evidence.

## Evidence Command

Run the proof from the repository root:

```powershell
pnpm run catalog:real-provider-proof -- --environment staging --transport-mode staging-provider-proof
```

For local live transport:

```powershell
pnpm run catalog:real-provider-proof -- --environment local --transport-mode live-provider
```

The command uses the active TCGdex profile, the TCGdex ProviderAdapter, and live provider fetch by default. It prints a redacted `catalog-real-provider-proof/v1` JSON packet. Attach or link that packet to the real-provider proof and then to rollout approval.

CI and unit tests use deterministic adapter responses so provider availability cannot make the build flaky. Deterministic tests prove the packet contract; the operator command proves live provider transport.

## Packet Requirements

The packet must include:

- provider key, unit key, active profile key/version, connector kind, transport mode, and selected scope;
- option-query counts for language, Series, and Expansion, with selected values present;
- import plan key, transport steps, total progress-event count, redacted progress samples, payload count, completion state, and diagnostic counts;
- Source Observation review counts plus capped sample rows with provider key, unit key, external key, source profile version, source URL host only, source update/hash presence, and normalized fact keys;
- promotion-preview counts for matched, eligible, blocked, skipped, conflicting, failed, and terminal rows before any Catalog write;
- a canonical degraded transport condition mapped to `providerTransport` and blocker vocabulary;
- security/privacy, transport-budget, and rollout handoff fields, with the security/privacy field pointing at the launch gate;
- explicit retired-surface booleans showing no migration, raw JSON escape hatch, compatibility route, or legacy documentation was retained.

The packet must not include raw provider payload bodies, provider-controlled labels, full provider URLs, image URLs, credentials, cookies, account/user identifiers, broad JSON patches, retired route instructions, compatibility redirects, support-only legacy paths, screenshots of retired surfaces, or documentation that teaches retired behavior.

## Promotion Safety

The proof packet records promotion-preview counts before Catalog writes and sets `writeExecuted: false`. Safe execution of promotion in staging or production must happen through the rebuilt primary workbench or typed Source Observation API, with audit evidence captured separately.

If production execution is unsafe before public launch, staging/dev must prove the full import-to-preview path and production smoke must verify readiness, routing, and blocker posture without executing unsafe writes.

## Degraded Transport

The proof must show at least one degraded transport condition. The proof packet records the canonical timeout mapping:

- condition: `timeout`
- workbench transport category: `timeout`
- blocker: `provider-transport-timeout`
- action state: `degraded`

Provider error bodies stay redacted. Unknown provider transport failures fail closed and must not collapse to generic disabled states.

## Retirement Rule

For this milestone, retire means complete removal. Retired code, product patterns, route/module contracts, API/read-model contracts, clients, tests, fixtures, seeds, screenshots, documentation, runbooks, release notes, operator instructions, feature flags, hidden flags, aliases, fallback branches, redirects, compatibility aliases, compatibility shims, and migration shims must be deleted. A retired behavior may not remain as a hidden flag, support-only route, compatibility redirect, migration shim, stale fixture, stale screenshot, documentation-only deprecation, or legacy doc.

If a URL, schema/table name, concept name, copy pattern, or doc section remains for launch, it must be backed only by rebuilt clean contracts and include evidence that the old implementation, patterns, tests, fixtures, and documentation were removed.
