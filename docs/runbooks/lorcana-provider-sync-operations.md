# Lorcana Provider Sync Operations

This runbook covers staging and production runtime posture for Disney Lorcana
Catalog sync from LorcanaJSON, Lorcast, Scrydex, and the existing Chase Sets
TCGplayer provider path. Do not paste provider API keys, team identifiers,
cookies, request headers, account screenshots, raw provider payloads, full
provider URLs, retained provider samples, or unredacted provider errors into
this file, issue comments, logs, fixtures, or PR bodies.

## Runtime Posture

Staging can run the interface UAT after approved profile versions and provider
credentials are present. Production remains safe until activation gates pass:

- `CATALOG_INTEGRATION_CONTROL_PLANE_MODE` defaults to `dry-run-only` in
  production when unset.
- `CATALOG_INTEGRATION_ACTIVATION_MODE` defaults to `test-profiles-only` in
  production when unset.
- Provider-scoped disabled, imports-disabled, promotion-disabled, reapply
  disabled, cache-only, and emergency-stop controls must remain available for
  LorcanaJSON, Lorcast, Scrydex, and TCGplayer Lorcana work.
- `CATALOG_INTEGRATION_LORCANA_PRODUCTION_SIGNOFF_REFERENCE` must name the
  accepted provider-data approval and milestone #50 UAT evidence before
  production-like Lorcana writes are opened.

LorcanaJSON and Lorcast public transports do not require credentials. Scrydex
requires the shared runtime API key and team identifier in the API and worker
environments that execute provider transport. Configure `SCRYDEX_API_KEY` and
`SCRYDEX_TEAM_ID` once per environment for all Scrydex-backed product lines; do
not create Lorcana-specific or game-specific Scrydex secrets. TCGplayer uses the
existing automation-provider credential posture documented in
[TCGplayer Automation Operations](./tcgplayer-automation-operations.md).

## Provider Roles

| Provider | Role | Operator note |
| --- | --- | --- |
| LorcanaJSON | Free public baseline for Lorcana sets, cards, card metadata, image evidence references, and repeatable fixtures | Import selected sets from bulk set files; use all-cards data for option discovery |
| Lorcast | Free public supplemental card and set reference source, including set-scoped card payloads and TCGplayer ids where present | Respect published cache guidance; prefer cached set payloads and set-card endpoints over per-card calls |
| Scrydex | Paid supplemental source when its Lorcana coverage is better for cards, sealed products, variants, or image/price-history evidence | Every request uses credits, so imports must be bulk-first, preflighted, and credit-aware |
| TCGplayer | Marketplace product ids, group/set identity, SKU mapping, condition/language/printing variants, and price-reference evidence | Shared provider key with other games; Lorcana enablement must be unit-aware |
| Ravensburger official Lorcana | Canonical validation reference only unless separate approval permits ingestion | Do not scrape or retain official text/images without approval |

## Bulk-First And Credit-Aware Imports

The normal selected-set path must be bulk/list/search first:

- LorcanaJSON card and set imports use the selected set file for import
  payloads and avoid per-card provider calls.
- Lorcast card imports use the selected set cards endpoint; selected-card
  imports still use the set-scoped cards endpoint and filter locally.
- Scrydex Lorcana imports must use the highest safe bulk/list/search page size
  and selected fields for the chosen import unit. Operators should reject or
  block plans that make one provider call per card, variant, or sealed product
  as the normal path.
- TCGplayer Lorcana uses the existing automation provider throttling, redaction,
  and unit-scoped controls.

Before starting a Scrydex import from the shared Catalog importer, confirm:

1. Scrydex credential readiness is `configured`, with only redacted secret
   references shown.
2. The shared team, usage, credit, rate-limit, cache, and option freshness state
   is visible.
3. The selected source scope shows estimated request count and credit impact, or
   an explicit `estimate-unavailable` diagnostic with a reason.
4. The import plan names the selected provider, unit, profile version, and
   source scope.
5. The plan uses paginated bulk/list/search retrieval and minimal selected
   fields for the selected import unit.

After a Scrydex import completes, record job id, provider key, unit key, profile
version, source scope, actual request count, page count, cache hit/miss count,
usage-check result, credit/rate/degraded diagnostics, bulk-first confirmation or
documented per-record fallback reason, Source Observation counts, promotion
preview counts, conflict counts, and duplicate-prevention outcomes.

## Provider Rollout Controls

Use the narrowest switch that stops the unsafe behavior:

- Provider outage, suspected auth leak, credit exhaustion, or unexpected
  high-call import plan:
  `CATALOG_INTEGRATION_PROVIDER_API_EMERGENCY_STOP=<provider>`.
- One Lorcana unit only:
  `CATALOG_INTEGRATION_PROVIDER_API_EMERGENCY_STOP_UNITS=<unit key>`.
- Stop live option queries while keeping cached choices visible:
  `CATALOG_INTEGRATION_PROVIDER_OPTION_QUERIES=cache-only`.
- Stop or cache-only one provider/product-line selector:
  `CATALOG_INTEGRATION_PROVIDER_OPTION_QUERY_UNITS_DISABLED=<unit key>` or
  `CATALOG_INTEGRATION_PROVIDER_OPTION_QUERY_UNITS_CACHE_ONLY=<unit key>`.
- Stop imports:
  `CATALOG_INTEGRATION_IMPORTS_DISABLED=<provider>`.
- Stop one Lorcana import lane:
  `CATALOG_INTEGRATION_IMPORT_UNITS_DISABLED=<unit key>`.
- Stop writes into Catalog truth:
  `CATALOG_INTEGRATION_PROMOTION_DISABLED=<provider>`.
- Stop one promotion lane:
  `CATALOG_INTEGRATION_PROMOTION_UNITS_DISABLED=<unit key>`.
- Freeze reapply/replay:
  `CATALOG_INTEGRATION_REAPPLY_DISABLED=<provider>` or
  `CATALOG_INTEGRATION_REAPPLY_UNITS_DISABLED=<unit key>`.
- Freeze the whole control plane except dry-run evidence:
  `CATALOG_INTEGRATION_CONTROL_PLANE_MODE=dry-run-only`.

Because Scrydex and TCGplayer are used by more than one product line, do not
use broad provider enablement as proof that Lorcana units are approved.
Production Lorcana enablement must name the Lorcana unit/profile evidence.

## Interface-Only Operator Actions

Normal UAT and launch operations happen through the Chase Sets Admin interface:
the Integrations Import workbench, Provider setup, Governance, Integration
health, validation readiness, conflict resolution, lifecycle recovery, downstream
read-model surfaces, and audit evidence views. Operators must not use
handcrafted URLs, direct API calls, CLI commands, SQL, Postman, browser console
commands, provider endpoints, or hidden routes for normal UAT actions.

1. Provider setup: review active Lorcana profile versions, credential readiness,
   fixture coverage, dry-run readiness, and provider-data approval state.
2. Source-scope selection: open the shared Integrations Import workbench, choose
   provider, unit, and a Lorcana set from guided controls, then review option
   freshness and cache state.
3. Preflight: review request strategy, estimated request count, selected fields,
   cache/usage state, credit impact where applicable, and per-record fallback
   diagnostics before starting a sync.
4. Import: start the import and follow the visible job card until it reaches a
   terminal successful, empty-change, blocked, or failed state.
5. Review: inspect Source Observation counts, diagnostics, conflict/duplicate
   outcomes, and normalized facts from the shared review surfaces.
6. Promotion and reapply: review the promotion preview for the selected scope,
   promote only approved facts, then reapply through visible lifecycle controls
   when testing idempotence.
7. Downstream smoke: verify the promoted Lorcana item or set appears in a
   representative downstream Catalog read model/UI through normal navigation.
8. Regression: repeat UI-only smoke proof for one Pokemon set, one MTG set, and
   one One Piece set through the same shared importer controls.

## Staging UAT Evidence

The milestone #50 staging UAT must include the `lorcana-launch` journey from
`deployables/admin-web/e2e/catalog-staging-provider-sync.uat.spec.ts` or an
equivalent operator-recorded walkthrough through the same visible controls.

Record an interface-only packet with:

- LorcanaJSON card and set reference scopes: provider key, unit key, profile
  version, selected set label, import job id, terminal job state, estimated
  request count, Source Observation counts, and review/promotion summary.
- Lorcast card and set reference scopes: provider key, unit key, profile
  version, selected set label, cache guidance evidence, import job id, terminal
  job state, request estimate, Source Observation counts, and review/promotion
  summary where applicable.
- Scrydex Lorcana scopes when active: shared credential readiness using
  `SCRYDEX_API_KEY` and `SCRYDEX_TEAM_ID`, usage/credit state, estimated and
  actual request/page/cache counts, bulk-first confirmation, selected fields,
  redacted diagnostics, job id, terminal state, and Source Observation counts.
- TCGplayer Lorcana card and sealed scopes: provider key, unit key, profile
  version, selected product line and set labels, job id, terminal state,
  external reference/SKU evidence without pricing, inventory, seller, or account
  facts.
- Downstream smoke: the promoted/reapplied Lorcana item or set visible through a
  representative Catalog read model/UI.
- Regression scopes: one Pokemon set, one MTG set, and one One Piece set
  exercised through the same Admin importer controls, with provider key, unit
  key, profile version, import state, Source Observation counts, and promotion
  preview/result counts.
- Rollout controls: operator-visible proof that dry-run-only, emergency stop,
  imports-disabled, promotion-disabled, reapply-disabled, and cache-only option
  query states block or open only the intended provider/unit.

The packet must not include Scrydex API keys, team ids, account identifiers,
raw usage responses, full provider URLs, raw provider payloads, provider
imagery, provider screenshots exposing sensitive values, or console captures.

## Related Docs

- [Catalog Integration Lorcana Production Signoff](../../bounded-contexts/catalog/docs/catalog-integration-lorcana-production-signoff.md)
- [Catalog Integration Rollout Controls](../../bounded-contexts/catalog/docs/catalog-integration-rollout-controls.md)
- [Catalog Integration Credential Readiness](../../bounded-contexts/catalog/docs/catalog-integration-credential-readiness.md)
- [Catalog Integration Provider Transport Budgets](../../bounded-contexts/catalog/docs/catalog-integration-provider-transport-budgets.md)
- [Catalog Integration Data Governance](../../bounded-contexts/catalog/docs/catalog-integration-data-governance.md)
- [Catalog Integration Operations](./catalog-integration-operations.md)
- [TCGplayer Automation Operations](./tcgplayer-automation-operations.md)
