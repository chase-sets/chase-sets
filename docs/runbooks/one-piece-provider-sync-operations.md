# One Piece Provider Sync Operations

This runbook covers staging and production runtime posture for One Piece Catalog
sync from Scrydex and the existing Chase Sets TCGplayer provider path. Do not
paste provider API keys, team identifiers, request headers, account screenshots,
raw provider payloads, usage account details, retained provider samples, or
unredacted provider errors into this file, issue comments, logs, fixtures, or PR
bodies.

## Runtime Posture

Staging can run the interface UAT after approved profile versions and provider
credentials are present. Production remains safe until activation gates pass:

- `CATALOG_INTEGRATION_CONTROL_PLANE_MODE` defaults to `dry-run-only` in
  production when unset.
- `CATALOG_INTEGRATION_ACTIVATION_MODE` defaults to `test-profiles-only` in
  production when unset.
- Provider-scoped disabled, imports-disabled, promotion-disabled, reapply
  disabled, cache-only, and emergency-stop controls must remain available for
  Scrydex and TCGplayer One Piece work.
- `CATALOG_INTEGRATION_ONE_PIECE_PRODUCTION_SIGNOFF_REFERENCE` must name the
  accepted provider-data approval and #2285 UAT evidence before production-like
  One Piece writes are opened.

Scrydex requires a shared runtime API key and team identifier in the API and
worker environments that execute provider transport. Configure `SCRYDEX_API_KEY`
and `SCRYDEX_TEAM_ID` once per environment for all Scrydex-backed product lines;
do not create One Piece-specific or game-specific Scrydex secrets. TCGplayer
uses the existing automation-provider credential posture documented in
[TCGplayer Automation Operations](./tcgplayer-automation-operations.md).

## Provider Roles

| Provider | Role | Operator note |
| --- | --- | --- |
| Scrydex | Preferred paid seed provider for One Piece cards, variants, expansions, sealed products, approved price-history evidence, and webhook freshness | Every request uses credits, so imports must be bulk-first and preflighted |
| TCGplayer | Marketplace product ids, group/set identity, SKU mapping, condition/language/printing variants, and price-reference evidence | Shared provider key with Magic; One Piece enablement must be unit-aware |
| Bandai official One Piece Card Game | Canonical validation reference only unless separate approval permits ingestion | Do not scrape or retain official text/images without approval |
| Fallback/community/free sources | Comparison-only or fallback evidence after source approval | Do not promote as default production authority |

## Scrydex Bulk-First Operations

Scrydex imports must use bulk/list/search pagination whenever the provider can
return the required data for the selected source scope. Operators should reject
or block an import plan that shows one-call-per-card, one-call-per-variant, or
one-call-per-sealed-product behavior as the normal path.

Before starting a Scrydex import from the shared Catalog importer, confirm:

1. Scrydex credential readiness is `configured`, with only a redacted secret
   reference shown.
2. Team, usage, credit, rate-limit, and cache state are visible.
3. The selected source scope shows estimated request count and credit impact, or
   an explicit `estimate-unavailable` diagnostic with a reason.
4. The import plan names the selected provider, unit, profile version, and
   source scope.
5. The plan uses paginated bulk/list/search retrieval and minimal selected
   fields for the chosen import unit.

After the import completes, record:

- job id, provider key, unit key, profile version, and source scope;
- actual Scrydex request count;
- page count;
- cache hit/miss count;
- usage-check result;
- credit/rate/degraded diagnostics;
- bulk-first confirmation or the documented per-record fallback reason;
- Source Observation counts, promotion preview counts, conflict counts, and
  duplicate-prevention outcomes.

## Provider Rollout Controls

Use the narrowest switch that stops the unsafe behavior:

- Provider outage, suspected auth leak, credit exhaustion, or unexpected
  high-call import plan:
  `CATALOG_INTEGRATION_PROVIDER_API_EMERGENCY_STOP=scrydex`.
- Stop live option queries while keeping cached choices visible:
  `CATALOG_INTEGRATION_PROVIDER_OPTION_QUERIES=cache-only`.
- Stop Scrydex imports:
  `CATALOG_INTEGRATION_IMPORTS_DISABLED=scrydex`.
- Stop writes into Catalog truth:
  `CATALOG_INTEGRATION_PROMOTION_DISABLED=scrydex` or the affected provider.
- Freeze reapply/replay:
  `CATALOG_INTEGRATION_REAPPLY_DISABLED=scrydex` or the affected provider.
- Freeze the whole control plane except dry-run evidence:
  `CATALOG_INTEGRATION_CONTROL_PLANE_MODE=dry-run-only`.

Because TCGplayer is used by more than one product line, do not use a broad
TCGplayer enablement as proof that One Piece TCGplayer units are approved.
Production One Piece enablement must name the One Piece unit/profile evidence.

## Interface-Only Operator Actions

Normal UAT and launch operations happen through the Chase Sets Admin interface:
the Integrations Import workbench, Provider setup, Governance, Integration
health, validation readiness, conflict resolution, lifecycle recovery, and audit
evidence views. Operators must not use handcrafted URLs, direct API calls, CLI
commands, SQL, Postman, browser console commands, provider endpoints, or hidden
routes for normal UAT actions.

1. Provider setup: review Scrydex and TCGplayer One Piece profile versions,
   credential readiness, fixture coverage, and dry-run readiness.
2. Source-scope selection: open the Integrations Import workbench, select One
   Piece, select Scrydex or TCGplayer, choose the provider unit and source scope
   from guided controls, and review option freshness/cache state.
3. Scrydex preflight: review estimated request count, credit impact or
   `estimate-unavailable`, usage/credit state, and bulk-first plan evidence.
4. Import: start the import and follow the visible job card until it reaches a
   terminal successful, empty-change, blocked, or failed state.
5. Review: inspect Source Observation counts, diagnostics, conflict/duplicate
   outcomes, and normalized facts from the shared review surfaces.
6. Promotion: review promotion preview for the selected scope, then promote only
   the approved scope.
7. Regression: repeat UI-only smoke proof for one Pokemon set and one MTG set
   from the same shared importer controls.
8. Emergency stop: activate the approved release/Ops control workflow for only
   the unsafe provider and verify Integration health shows the intended blocked
   state.

## Staging UAT Evidence

The #2285 staging UAT must include:

- selected One Piece, Pokemon, and MTG source scopes;
- Scrydex and TCGplayer readiness state;
- Scrydex credential, team, usage, credit/rate, cache, and option freshness
  state;
- preflight estimated Scrydex request count/credit impact or
  `estimate-unavailable` with a reason;
- actual Scrydex request count, page count, cache hit/miss count, usage-check
  result, and credit/degraded diagnostics;
- proof that Scrydex used bulk/search pagination and did not make one provider
  call per card, variant, or sealed product in the normal path;
- Source Observation counts, promotion preview/result, conflict/duplicate
  outcomes, and read-model visibility;
- TCGplayer external reference/SKU evidence without forbidden commerce facts;
- screenshots or operator-visible artifacts for dry-run-only, emergency stop,
  imports-disabled, promotion-disabled, reapply-disabled, and cache-only option
  query states.

Record the proof as an interface-only packet with these sections:

- One Piece scope: provider key, unit key, profile version, source scope summary
  with source-specific identifiers redacted, readiness states, import job id,
  Source Observation counts, promotion preview/result counts, and read-model
  visibility.
- Scrydex usage summary: data class `provider-usage-summary`, estimated request
  count or `estimate-unavailable`, actual request count, page count, cache hit
  count, cache miss count, usage-check state, credit state, bulk-first
  confirmation or redacted per-record fallback reason, and redacted diagnostics.
- Regression scopes: one Pokemon scope and one MTG scope exercised through the
  same Admin interface controls, with provider key, unit key, profile version,
  import state, Source Observation counts, and promotion preview/result counts.
- Rollout controls: operator-visible proof that only the intended One Piece
  provider/unit is blocked or opened, including the shared TCGplayer regression
  that Pokemon and MTG units remain governed independently.

The packet must not include Scrydex API keys, team ids, account identifiers,
raw usage responses, full provider URLs, provider-controlled labels, raw
provider payloads, provider imagery, or screenshots that expose those values.

## Related Docs

- [Catalog Integration One Piece Production Signoff](../../bounded-contexts/catalog/docs/catalog-integration-one-piece-production-signoff.md)
- [Catalog Integration Data Governance](../../bounded-contexts/catalog/docs/catalog-integration-data-governance.md)
- [Catalog Integration Credential Readiness](../../bounded-contexts/catalog/docs/catalog-integration-credential-readiness.md)
- [Catalog Integration Rollout Controls](../../bounded-contexts/catalog/docs/catalog-integration-rollout-controls.md)
- [Catalog Integration Provider Transport Budgets](../../bounded-contexts/catalog/docs/catalog-integration-provider-transport-budgets.md)
- [TCGplayer Automation Operations](./tcgplayer-automation-operations.md)
