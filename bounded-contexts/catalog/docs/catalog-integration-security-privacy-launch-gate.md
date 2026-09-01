# Catalog Integration Security Privacy Launch Gate

This note defines the security/privacy launch gate for the rebuilt Catalog Control Plane. The gate supports the primary operator path, provider import -> Source Observation review -> promotion, and blocks release when security/privacy evidence is missing, unsafe, or framed as compatibility for retired admin behavior.

The authoritative executable gate lives in:

```text
scripts/check-structure/catalog-integration-security-privacy-launch-gate.ts
```

## Launch Packet

The launch packet uses schema `catalog-security-privacy-launch-gate/v1` and checklist version `catalog-security-privacy-checklist/2026-06-11`. It must name:

- owner and reviewer;
- approval timestamp;
- approval issue comment or evidence reference;
- checklist version;
- real-provider proof handoff;
- no-confusion acceptance handoff;
- production rollout/approval handoff.

Missing owner, reviewer, checklist version, approval reference, or handoff evidence fails closed.

## Required Checklist

The checklist covers:

- admin route protection and authenticated actor requirements;
- authorization boundaries for view-only, operator/admin, denied, rollout-stopped, destructive, and high-impact actions;
- write safeguards: POST-only write routes, server-side actor and permission checks, primary-command idempotency, double-submit protection, destructive confirmation, and no raw-JSON escape hatch;
- governed provider data coverage for every Catalog integration data class;
- provider-controlled content safety for provider text, URLs, images, diagnostics, labels, commerce values, seller/account facts, credentials, cookies, and PII;
- telemetry, logs, metrics, traces, screenshots, CI artifacts, and launch evidence redaction;
- audit evidence integrity for high-impact actions;
- real-provider proof privacy;
- reset/drop safeguards for prelaunch data loss;
- complete retirement of old control-plane surfaces.

## Fail-Closed Rules

The gate blocks launch when:

- any Catalog control-plane action lacks RBAC coverage;
- any destructive or write action is available to `catalog.view` only;
- unauthenticated, wrong-role, or rollout-stopped paths do not fail closed;
- primary write actions lack idempotency or destructive confirmation where required;
- raw provider payloads, credentials, cookies, seller/account facts, PII, provider commerce values, full provider URLs, provider-controlled labels, provider imagery, raw diagnostics, or unsafe evidence are retained;
- audit evidence omits actor, action, target, timestamp, result, or redaction-safe context;
- the real-provider proof retains raw payloads, full URLs, credentials/cookies, provider-controlled labels, or performs Catalog writes;
- production-prelaunch reset/drop lacks approval, backup/data-loss decision, dry-run counts, before/after verification, staging rehearsal, smoke verification, or bounded target tables;
- retained data is used as clean reset completion;
- migration evidence is used as an exception to retirement.

## Retirement Meaning

For this milestone, retire, remove, deprecate, cleanup, and legacy removal mean complete deletion. Complete deletion includes runtime code, API routes, UI modules, product patterns, read-model contracts, clients, route aliases, feature flags, hidden flags, fallback branches, redirects, compatibility aliases, compatibility shims, migration shims, tests, fixtures, seeds, screenshots, documentation, runbooks, release notes, and operator instructions.

Forbidden outcomes include soft deprecation, compatibility shims, legacy support paths, one-to-one migration of retired admin behavior, raw JSON escape hatches, support-only preserved routes, documentation-only deprecation, hidden flag fallbacks, or any guidance that teaches operators to use retired behavior.

## Related References

- [Catalog Integration Admin Control Plane RBAC](./catalog-integration-admin-control-plane-rbac.md)
- [Catalog Integration Data Governance](./catalog-integration-data-governance.md)
- [Catalog Integration Audit Evidence](./catalog-integration-audit-evidence.md)
- [Catalog Integration Reset and Cleanup](./catalog-integration-reset-and-cleanup.md)
- [Catalog Integration Real-Provider Proof](./catalog-integration-real-provider-proof.md)
- [Catalog Primary Workbench Admin Contract](./primary-workbench-admin-contract.md)
