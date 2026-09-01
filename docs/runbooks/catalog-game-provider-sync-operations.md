# Catalog Game Provider Sync Operations

This runbook covers staging and production runtime posture for Catalog provider sync across every product domain that can participate in the complete production Catalog synchronization: Magic: The Gathering, Pokemon, Yu-Gi-Oh!, One Piece, and Disney Lorcana. The active provider profile/unit registry (`catalogProviderIntegrationProfileVersions` in `bounded-contexts/catalog/features/source-observations/api/provider-integration-profiles.ts`) and its accepted mappings are the executable source of truth for "all production providers"; treat this runbook and the [Catalog Integration Production Signoff](../../bounded-contexts/catalog/docs/catalog-integration-production-signoff.md) as the operating narrative bound to that state. The shared operating posture below applies to all product domains; the per-domain sections add only the provider, credit, validation, and signoff facts that differ. `scripts/check-structure/catalog-integration-production-signoff-coverage.ts` fails if an active production-capable provider unit lacks a matching signoff/runbook section.

## Shared operating posture

Do not paste provider API keys, team identifiers, cookies, request headers, account screenshots, raw provider payloads, full provider URLs, retained provider samples, usage account details, or unredacted provider errors into runbook files, issue comments, logs, fixtures, or PR bodies.

### Runtime defaults and activation gates

Staging can run the interface UAT after approved profile versions and provider credentials are present. Production remains safe until activation gates pass:

- `CATALOG_INTEGRATION_CONTROL_PLANE_MODE` defaults to `dry-run-only` in production when unset.
- `CATALOG_INTEGRATION_ACTIVATION_MODE` defaults to `test-profiles-only` in production when unset.
- Provider-scoped disabled, imports-disabled, promotion-disabled, reapply-disabled, cache-only, and emergency-stop controls must remain available for every provider that backs the game.
- `CATALOG_INTEGRATION_PROVIDER_API_EMERGENCY_STOP` stays empty during normal operation and can be set to a provider key or `all`.

A per-game production-signoff reference env var (named in each game section) must name the accepted provider-data approval and the game's UAT evidence before production-like writes are opened for that game.

### Credential posture

- Public transports (MTGJSON, Scryfall, TCGdex, YGOPRODeck, YGOJSON, LorcanaJSON, Lorcast) do not require credentials.
- Scrydex requires a shared runtime API key and team identifier in the API and worker environments that execute provider transport. Configure `SCRYDEX_API_KEY` and `SCRYDEX_TEAM_ID` once per environment for all Scrydex-backed product lines; do not create game-specific Scrydex secrets.
- TCGplayer requires `TCGPLAYER_AUTOMATION_TCG_AUTH_COOKIE` in the executing API and worker environment before live option queries or imports can run, using the existing automation-provider credential posture documented in [TCGplayer Automation Operations](./tcgplayer-automation-operations.md).

### Shared-transport handling (TCGplayer and Scrydex)

Provider-scoped controls accept one provider key, a comma-separated provider list, or `all`. Use the narrowest provider scope first so one provider can stop without stopping the others.

Because TCGplayer and Scrydex are used by more than one product line, do not use a broad TCGplayer or Scrydex enablement as proof that a specific game's units are approved. Production enablement for a game must name that game's unit/profile evidence, and shared-provider work must stay unit-aware so the other games' units remain independently governed.

| Control | Behavior | Code-supported reference |
| --- | --- | --- |
| Disabled provider adapter | Stops provider transport, provider option queries, and imports for the scoped provider; other providers continue unless also scoped. | `provider-adapter-disabled` in `catalog-integration-rollout-controls.ts`. |
| Dry-run-only control plane | Blocks import, promotion, reapply, and activation while leaving reads and dry-run evidence available. | `dry-run-only` in `catalog-integration-rollout-controls.ts`; production default when unset. |
| Imports disabled | Blocks import enqueue and import worker turns for the scoped provider; existing observations remain inspectable. | `imports-disabled` in `catalog-integration-rollout-controls.ts`. |
| Promotion disabled | Blocks single and bulk Source Observation promotion for the scoped provider; import and reapply stay governed by their own controls. | `promotion-disabled` in `catalog-integration-rollout-controls.ts`. |
| Reapply disabled | Blocks explicit and scoped reapply for the scoped provider; import and promotion stay governed by their own controls. | `reapply-disabled` in `catalog-integration-rollout-controls.ts`. |
| Provider API emergency stop | Blocks provider transport, provider option queries, and imports for the scoped provider during provider incidents; Catalog review of already-recorded observations can continue. | `provider-api-emergency-stop` in `catalog-integration-rollout-controls.ts`. |
| Provider option cache-only | Stops live option queries and serves only fresh or stale cached option pages. If no safe cached page exists, the provider option selector is unavailable. | `provider-option-queries-cache-only` in `catalog-integration-rollout-controls.ts` and cache metadata from provider option query responses. |

Operator-visible denial evidence uses `catalog_integration_rollout_control_denied`, `catalog-integration-rollout-control-denied`, the `controlId`, the affected provider, and the capability that was stopped. Do not treat disabled Admin buttons as the enforcement boundary; the server and worker controls enforce the stop.

### Emergency disablement pattern

Use the narrowest switch that stops the unsafe behavior:

- Provider outage, suspected auth leak, credit exhaustion, or unexpected high-call import plan: `CATALOG_INTEGRATION_PROVIDER_API_EMERGENCY_STOP=<provider>`.
- One game unit only: `CATALOG_INTEGRATION_PROVIDER_API_EMERGENCY_STOP_UNITS=<unit key>`.
- Stop live option queries while keeping cached choices visible: `CATALOG_INTEGRATION_PROVIDER_OPTION_QUERIES=cache-only`.
- Stop or cache-only one provider/product-line selector: `CATALOG_INTEGRATION_PROVIDER_OPTION_QUERY_UNITS_DISABLED=<unit key>` or `CATALOG_INTEGRATION_PROVIDER_OPTION_QUERY_UNITS_CACHE_ONLY=<unit key>`.
- Stop imports for one provider: `CATALOG_INTEGRATION_IMPORTS_DISABLED=<provider>`.
- Stop one import lane without blocking the same provider elsewhere: `CATALOG_INTEGRATION_IMPORT_UNITS_DISABLED=<unit key>`.
- Stop writes into Catalog truth: `CATALOG_INTEGRATION_PROMOTION_DISABLED=<provider>`.
- Stop one promotion lane: `CATALOG_INTEGRATION_PROMOTION_UNITS_DISABLED=<unit key>`.
- Freeze reapply/replay: `CATALOG_INTEGRATION_REAPPLY_DISABLED=<provider>` or `CATALOG_INTEGRATION_REAPPLY_UNITS_DISABLED=<unit key>`.
- Freeze the whole control plane except dry-run evidence: `CATALOG_INTEGRATION_CONTROL_PLANE_MODE=dry-run-only`.

Operator-visible diagnostics may include provider key, unit key, readiness state, domain key, HTTP status class, retry outcome, and redacted diagnostic code. They must not include cookies, authorization headers, seller or account facts, prices, listings, raw request bodies, or raw response bodies.

### Credit-aware and bulk-first imports

For paid/credited transports (Scrydex), every request uses credits, so imports must be bulk-first and preflighted. Scrydex imports must use bulk/list/search pagination with the highest safe page size and minimal selected fields whenever the provider can return the required data for the selected source scope. Operators should reject or block an import plan that shows one-call-per-card, one-call-per-variant, or one-call-per-sealed-product behavior as the normal path; per-record fallback requires a visible reason and call impact before import.

Before starting a Scrydex import from the shared Catalog importer, confirm:

1. Scrydex credential readiness is `configured`, with only a redacted secret reference shown.
2. Team, usage, credit, rate-limit, cache, and option freshness state are visible.
3. The selected source scope shows estimated request count and credit impact, or an explicit `estimate-unavailable` diagnostic with a reason.
4. The import plan names the selected provider, unit, profile version, and source scope.
5. The plan uses paginated bulk/list/search retrieval and minimal selected fields for the chosen import unit.

After a Scrydex import completes, record job id, provider key, unit key, profile version, source scope, actual request count, page count, cache hit/miss count, usage-check result, credit/rate/degraded diagnostics, bulk-first confirmation or documented per-record fallback reason, Source Observation counts, promotion preview counts, conflict counts, and duplicate-prevention outcomes.

When Scrydex readiness is degraded, credits are low, usage checks fail, rate limits are active, cache state is unavailable, or preflight estimates look too large: stop the affected Scrydex unit with `CATALOG_INTEGRATION_PROVIDER_API_EMERGENCY_STOP_UNITS=<unit key>` or keep selectors cache-only with `CATALOG_INTEGRATION_PROVIDER_OPTION_QUERY_UNITS_CACHE_ONLY=<unit key>`; do not start or resume imports until the Admin preflight shows the provider, unit, source scope, estimated request count/credit impact or `estimate-unavailable`, usage-check state, and bulk-first plan; prefer a smaller bulk/list/search source scope over per-record fallback; after recovery run a dry-run or smallest approved import and record the actual usage diagnostics; and escalate to provider-account review only with redacted usage summaries and provider-safe diagnostic codes.

### TCGplayer cookie rotation

Rotate the TCGplayer automation cookie when the provider session expires, an operator leaves the provider account, a leak is suspected, or repeated authorization failures continue after cooldown.

1. Set `CATALOG_INTEGRATION_PROVIDER_API_EMERGENCY_STOP=tcgplayer` (or the unit-scoped stop for the affected game unit).
2. Replace `TCGPLAYER_AUTOMATION_TCG_AUTH_COOKIE` through the approved secret path for the target environment.
3. Keep conservative runtime defaults unless an incident review approves a change: request delay `250ms`, cooldown `30000ms`, max concurrent requests `2`, max retries `3`.
4. Redeploy or restart the API and worker components that execute Catalog provider transport.
5. Run a small product-line option query and confirm readiness reports `configured` without exposing the cookie.
6. Clear the emergency stop only after the small query succeeds.

### Credential rotation (shared secrets)

Rotate provider credentials from the approved secret-management UI and release control workflow only. Never paste secret values, team ids, account ids, request headers, or provider screenshots into runbook notes, issue comments, PR bodies, fixtures, logs, or audit evidence.

1. Activate a unit-scoped emergency stop for the affected Scrydex or TCGplayer game unit from the release/Ops controls.
2. Confirm Integration health shows the intended provider/unit blocked and that the other games' TCGplayer and Scrydex units remain independently governed.
3. Replace the secret value in the secret-management UI, preserving the existing shared Scrydex secret names `SCRYDEX_API_KEY` and `SCRYDEX_TEAM_ID`.
4. Redeploy or restart only the affected runtime/worker environment through the normal platform UI.
5. Open Provider setup and Integration health in Admin and verify credential readiness is `configured` or `ready` with redacted references only.
6. Run a dry-run preflight for the smallest approved source scope and review estimated calls/credit impact or `estimate-unavailable`.
7. Remove the unit-scoped stop only after readiness, cache state, and usage diagnostics are visible and redacted.

### Image evidence operations

Only paid/marketplace provider image URI evidence approved by the provider-data signoff (for example Scrydex and TCGplayer) may enter the shared Catalog importer/review surfaces. Official validation-reference and fallback/community images remain comparison-only and must not be linked, cached, transformed, rehosted, or retained. Promotion must publish Chase Sets asset URLs from a Catalog-owned Product Asset Set, not provider image URLs. If an image is missing, stale, or from an unapproved source, keep the Source Observation reviewable and do not rehost it until the source is approved and current.

Retained Product Asset Sets follow `catalog-product-image-retention-v1`: preview assets expire after 90 days, staging/production assets are retained while referenced, and takedown/removal requests target deletion within 30 days after approval through the Catalog asset takedown path. Evidence packets may include provider key, source URL host/hash, source hash, Catalog storage key or public Chase Sets URL, image count, status, and redacted diagnostics. They must not include full provider image URLs, raw payload bodies, provider image bytes, provider screenshots, prices, inventory, quantities, seller/account facts, cookies, API keys, team ids, or console captures.

### Monitoring signals

During staging UAT and production launch, the Admin Integration health surface and the Catalog Integration Control Plane dashboard must show these signals without exposing provider cookies, account facts, raw payloads, or raw provider URLs:

| Signal | Operator source | Healthy launch expectation |
| --- | --- | --- |
| Provider availability | Integration health provider readiness and provider transport diagnostics. | Public providers are ready or not-required; credentialed providers are configured before live work. Provider-specific outages name only the provider and diagnostic code. |
| Option-query freshness, cache-only, and stale state | Import scope option selectors and Integration health option-query status. | Required selectors show fresh or accepted stale/cache-only state before import. Empty cache-only pages block selection. |
| Job lag | Import jobs activity and Integration health job progress. | Queued and running import/reapply/bulk review jobs advance, or show a clear blocked/stale state with the affected provider. |
| Failure rate | Integration job and bulk review terminal outcomes. | Failed import, reapply, promote, reject, and defer work stays at zero for the launch slice or is explained by reviewed diagnostics. |
| Blocked promotions | Promotion preview and review controls. | Blocked counts are reviewed before promotion; production promotion is not enabled while unexplained blocked counts remain. |
| Conflict counts | Conflict resolution workspace and promotion preview summary. | Provider disagreements have an owner decision or remain blocked from promotion. |
| Duplicate-prevention blocks | Source Observation review, dry-run evidence, and duplicate-prevention preview. | Duplicate blocks are expected, counted, and reviewed; repeated imports do not create duplicate Catalog Items or Products. |
| Emergency-stop state | Integration health rollout controls summary and provider readiness diagnostics. | Emergency stop is clear for normal launch, or active only for the intentionally stopped provider during a drill or incident. |

### Interface-only operator actions

Normal UAT and launch operations happen through the Chase Sets Admin interface: the Integrations Import workbench, Provider setup, Governance, Integration health, validation readiness, conflict resolution, lifecycle recovery, downstream read-model surfaces, and audit evidence views. Operators must not use handcrafted URLs, direct API calls, CLI commands, SQL, Postman, browser console commands, provider endpoints, or hidden routes for normal UAT actions.

1. Provider setup: review active profile versions, credential readiness, fixture coverage, dry-run readiness, and provider-data approval state for the game's providers.
2. Dry run / source-scope selection: open Provider setup or validation readiness, or the Integrations Import workbench, select the game, provider, unit, approved profile version, and source scope from guided controls, and review option freshness/cache state plus normalized facts, diagnostics, duplicate-prevention preview, conflict preview, source hash status, and redaction summary.
3. Preflight (credited providers): review request strategy, estimated request count, selected fields, cache/usage state, credit impact or `estimate-unavailable`, and per-record fallback diagnostics before starting a sync.
4. Import: start the import and follow the visible job card until it reaches a terminal successful, empty-change, blocked, or failed state.
5. Review: inspect Source Observation counts, diagnostics, conflict/duplicate outcomes, and normalized facts from the shared review surfaces.
6. Promotion and reapply: review the promotion preview for the selected scope, promote only the approved scope, then reapply through visible lifecycle controls (current-active-profile reapply or original-source-profile replay) when testing idempotence; use the visible job controls to cancel, retry, or resume.
7. Downstream smoke: verify the promoted/reapplied item or set appears in a representative downstream Catalog read model/UI through normal navigation.
8. Emergency stop and rollback: use the approved release/Ops control workflow to stop only the affected provider/unit, verify Integration health shows the rollout control active for that provider and not the others, continue only with read-only review of already-recorded observations until cleared, and use Provider setup lifecycle recovery to roll back the provider profile and verify rollback audit evidence before re-enabling imports or promotions.

### Staging UAT posture

Run UAT through Chase Sets screens and redacted job artifacts only. Confirm public-provider readiness is `not-required` and credentialed-provider readiness is `configured` with only redacted runtime secret references; keep provider option queries open only for the selected set scope; keep production dry-run and disable defaults unchanged unless the production signoff checklist is complete; and exercise disabled, dry-run-only, imports-disabled, promotion-disabled, reapply-disabled, provider emergency-stop, and cache-only option-query states for every backing provider through Admin surfaces only.

Record an interface-only packet that captures, per active provider/unit: provider key, unit key, profile version, selected scope/set label with source-specific identifiers redacted, readiness states, import job id, terminal job state, estimated (and where credited, actual) request/page/cache counts, bulk-first confirmation or redacted per-record fallback reason, Source Observation counts, promotion preview/result counts, conflict/duplicate outcomes, read-model visibility, and rollout-control proof that only the intended provider/unit is blocked or opened. Packets must not include API keys, team ids, account identifiers, raw usage responses, full provider URLs, raw provider payloads, provider imagery, provider screenshots exposing sensitive values, or console captures.

When a game shares transports, UAT must include the cross-game regression scopes named in that game's section, exercised through the same Admin importer controls, proving the other games' units remain governed independently.

## Magic

Magic Catalog sync draws from MTGJSON, Scryfall, and TCGplayer. The three Magic provider keys are `mtgjson`, `scryfall`, and `tcgplayer`; the production default for `CATALOG_INTEGRATION_IMPORTS_DISABLED`, `CATALOG_INTEGRATION_PROMOTION_DISABLED`, and `CATALOG_INTEGRATION_REAPPLY_DISABLED` is `mtgjson,scryfall,tcgplayer` when unset.

| Provider | Credentials | Role |
| --- | --- | --- |
| MTGJSON | None (public) | Set-reference data promoted into Reference Records (never plans Catalog Item commands). |
| Scryfall | None (public) | Card data. |
| TCGplayer | `TCGPLAYER_AUTOMATION_TCG_AUTH_COOKIE` | Marketplace product ids, SKU mapping, sealed products; shared provider key. |

Operator notes:

- MTGJSON and Scryfall public transports do not require credentials; TCGplayer requires the automation cookie before live option queries or imports can run.
- Staging UAT readiness check: MTGJSON and Scryfall are `not-required`; TCGplayer is `configured` with only a redacted runtime secret reference. Keep provider option queries open only for the selected Magic set scope.
- MTGJSON set-reference promotion/reapply must keep the same Reference Record identity and plan fingerprint across repeated reapply; TCGplayer sealed-product reapply/retry must keep the same Catalog Item identity, SKU selected options, and plan fingerprint without creating a replacement Catalog Item.
- Post-UAT launch requires Magic production signoff evidence (provider policy approval, profile versions, dry-run/import/promotion outcomes, conflicts, duplicate-prevention blocks, emergency-stop proof, and redaction review) before production imports or promotions are enabled.

### Magic automated coverage map

Use this map when staging UAT records an expected failure mode. The automated tests do not replace interface UAT; they identify the code-level proof that the interface evidence should align with.

| UAT expected failure mode | Automated proof |
| --- | --- |
| An active Magic profile is missing an executable mapping contract, allows live provider calls in fixture gates, omits a required fixture flow, lacks a matching fixture case, or has profile validation errors. | `bounded-contexts/catalog/features/source-observations/api/providers/provider-integration-profiles.test.ts` -> `gates every active Magic profile version on executable fixture-backed mapping coverage`. |
| A partial Magic provider payload should block normalization with structured diagnostics instead of silently appearing promotable. | `bounded-contexts/catalog/features/source-observations/api/providers/provider-profile-contract-harness.test.ts` -> `classifies Magic fixture dry-runs as blocked, changed, ambiguous, promotable, and replay-safe`; backed by partial fixtures for MTGJSON, Scryfall, and TCGplayer Magic profile units. |
| Changed Magic provider payloads should move the source record hash while replay payloads keep the same source record hash and source mapping fingerprint. | `bounded-contexts/catalog/features/source-observations/api/providers/provider-profile-contract-harness.test.ts` -> `keeps replay deterministic while changed fixtures move the source hash`. |
| Ambiguous Magic rows should remain reviewable/blockable through duplicate-prevention policy instead of bypassing operator review. | `bounded-contexts/catalog/features/source-observations/api/providers/provider-profile-contract-harness.test.ts` -> `validates every executable profile against local golden fixtures without provider calls` and `classifies Magic fixture dry-runs as blocked, changed, ambiguous, promotable, and replay-safe`. |
| Promotable TCGplayer Magic sealed products should expose promotion command inputs, selected options, and duplicate-prevention evidence without pricing, inventory, seller, or secret facts. | `bounded-contexts/catalog/features/source-observations/api/providers/provider-profile-contract-harness.test.ts` -> `classifies Magic fixture dry-runs as blocked, changed, ambiguous, promotable, and replay-safe`; `runtime-promotion.test.ts` -> `promotes Magic sealed products with set fields and TCGplayer SKU selected options`. |
| MTGJSON set-reference promotion/reapply should never plan Catalog Item commands and should keep the same Reference Record identity and plan fingerprint across repeated reapply. | `bounded-contexts/catalog/features/source-observations/api/runtime-promotion.test.ts` -> `promotes MTGJSON Magic set-reference observations into Reference Records` and `reapplies promoted MTGJSON Magic set-reference observations without Catalog Item commands`. |
| TCGplayer Magic sealed-product reapply/retry should keep the same Catalog Item identity, SKU selected options, and plan fingerprint across repeated reapply without creating a replacement Catalog Item. | `bounded-contexts/catalog/features/source-observations/api/runtime-promotion.test.ts` -> `reapplies promoted Magic sealed products without replacing the Catalog Item or SKU options`. |

### Magic related docs

- [Catalog Integration Rollout Controls](../../bounded-contexts/catalog/docs/catalog-integration-rollout-controls.md)
- [Catalog Integration Credential Readiness](../../bounded-contexts/catalog/docs/catalog-integration-credential-readiness.md)
- [TCGplayer Automation Operations](./tcgplayer-automation-operations.md)

## Pokemon

Pokemon Catalog sync draws from TCGdex and the existing Chase Sets TCGplayer provider path. Pokemon is the foundational importer baseline, so `CATALOG_INTEGRATION_POKEMON_PRODUCTION_SIGNOFF_REFERENCE` must name the accepted provider-data approval and the regression-baseline UAT evidence (#2039, #2285, and milestone #50 `all-provider-regression`) before production-like Pokemon writes are opened. The Pokemon provider keys are `tcgdex` and `tcgplayer`.

| Provider | Credentials | Role |
| --- | --- | --- |
| TCGdex | None (public) | Card-print, series/expansion, language, and image-evidence data; bulk/list ingestion first. |
| TCGplayer | `TCGPLAYER_AUTOMATION_TCG_AUTH_COOKIE` | Marketplace product ids, SKU mapping, sealed products; shared provider key. |

Operator notes:

- TCGdex public transport does not require credentials; TCGplayer requires the automation cookie before live option queries or imports can run.
- Because TCGplayer is shared with Magic, Yu-Gi-Oh!, One Piece, and Lorcana, do not use a broad TCGplayer enablement as proof that Pokemon TCGplayer units are approved; production Pokemon enablement must name the Pokemon unit/profile evidence, and credential rotation must confirm the other domains' TCGplayer units remain independently governed.
- Only TCGdex and TCGplayer Pokemon image URI evidence may enter the shared importer/review surfaces, and only when the provider-data signoff covers image evidence for that source. Official Pokemon (pokemon.com) images remain comparison-only.
- Pokemon is the shared regression anchor: every other product domain's UAT must repeat UI-only smoke proof for one Pokemon set through the same shared importer controls.

### Pokemon related docs

- [Catalog Integration Pokemon Production Signoff](../../bounded-contexts/catalog/docs/catalog-integration-production-signoff.md#pokemon)
- [Catalog Integration Rollout Controls](../../bounded-contexts/catalog/docs/catalog-integration-rollout-controls.md)
- [Catalog Integration Credential Readiness](../../bounded-contexts/catalog/docs/catalog-integration-credential-readiness.md)
- [TCGplayer Automation Operations](./tcgplayer-automation-operations.md)

## Yu-Gi-Oh!

Yu-Gi-Oh! Catalog sync draws from YGOPRODeck, YGOJSON, and the existing Chase Sets TCGplayer provider path. `CATALOG_INTEGRATION_YUGIOH_PRODUCTION_SIGNOFF_REFERENCE` must name the accepted provider-data approval and milestone #44 (#2126) UAT evidence before production-like Yu-Gi-Oh! writes are opened. The Yu-Gi-Oh! provider keys are `ygoprodeck`, `ygojson`, and `tcgplayer`.

| Provider | Credentials | Role |
| --- | --- | --- |
| YGOPRODeck | None (public) | Card, printing, set, archetype, banlist/format, and image-evidence baseline; bulk/list ingestion first. |
| YGOJSON | None (public) | Structured set/product, sealed-product, and pack-metadata reference and normalization cross-check; set-file/bulk ingestion first. |
| TCGplayer | `TCGPLAYER_AUTOMATION_TCG_AUTH_COOKIE` | Marketplace product ids, group/set identity, SKU mapping, condition/language/printing/edition variants, and price-reference evidence; shared provider key. |

Operator notes:

- YGOPRODeck and YGOJSON public transports do not require credentials; their normal path must be bulk/list/search or set-file first and must not make one provider call per card, printing, or sealed product.
- TCGplayer requires the automation cookie before live option queries or imports can run; because it is shared with Magic, Pokemon, One Piece, and Lorcana, do not use a broad TCGplayer enablement as proof that Yu-Gi-Oh! TCGplayer units are approved, and credential rotation must confirm the other domains' TCGplayer units remain independently governed.
- Only YGOPRODeck and TCGplayer Yu-Gi-Oh! image URI evidence may enter the shared importer/review surfaces, and only when the provider-data signoff covers image evidence for that source. Official Konami database images remain comparison-only.
- Regression: repeat UI-only smoke proof for one Pokemon set, one MTG set, and one One Piece set through the same shared importer controls.

### Yu-Gi-Oh! related docs

- [Catalog Integration Yu-Gi-Oh! Production Signoff](../../bounded-contexts/catalog/docs/catalog-integration-production-signoff.md#yu-gi-oh)
- [Catalog Integration Rollout Controls](../../bounded-contexts/catalog/docs/catalog-integration-rollout-controls.md)
- [Catalog Integration Credential Readiness](../../bounded-contexts/catalog/docs/catalog-integration-credential-readiness.md)
- [TCGplayer Automation Operations](./tcgplayer-automation-operations.md)

## One Piece

One Piece Catalog sync draws from Scrydex and the existing Chase Sets TCGplayer provider path. `CATALOG_INTEGRATION_ONE_PIECE_PRODUCTION_SIGNOFF_REFERENCE` must name the accepted provider-data approval and #2285 UAT evidence before production-like One Piece writes are opened.

| Provider | Role | Operator note |
| --- | --- | --- |
| Scrydex | Preferred paid seed provider for One Piece cards, variants, expansions, sealed products, approved price-history evidence, and webhook freshness | Every request uses credits, so imports must be bulk-first and preflighted |
| TCGplayer | Marketplace product ids, group/set identity, SKU mapping, condition/language/printing variants, and price-reference evidence | Shared provider key with Magic; One Piece enablement must be unit-aware |
| Bandai official One Piece Card Game | Canonical validation reference only unless separate approval permits ingestion | Do not scrape or retain official text/images without approval |
| Fallback/community/free sources | Comparison-only or fallback evidence after source approval | Do not promote as default production authority |

Operator notes:

- Only Scrydex and TCGplayer One Piece image URI evidence may enter the shared importer/review surfaces, and only when the provider-data signoff covers image evidence for that source. Bandai official and fallback/community images remain comparison-only.
- Because TCGplayer is shared with Pokemon and Magic, do not use a broad TCGplayer enablement as proof that One Piece TCGplayer units are approved; production One Piece enablement must name the One Piece unit/profile evidence, and credential rotation must confirm Pokemon and MTG TCGplayer units remain independently governed.
- Regression: repeat UI-only smoke proof for one Pokemon set and one MTG set through the same shared importer controls.

### One Piece staging UAT evidence

The #2285 staging UAT must include selected One Piece, Pokemon, and MTG source scopes; Scrydex and TCGplayer readiness state; Scrydex credential, team, usage, credit/rate, cache, and option freshness state; preflight estimated Scrydex request count/credit impact or `estimate-unavailable` with a reason; actual Scrydex request count, page count, cache hit/miss count, usage-check result, and credit/degraded diagnostics; proof that Scrydex used bulk/search pagination and did not make one provider call per card, variant, or sealed product in the normal path; Source Observation counts, promotion preview/result, conflict/duplicate outcomes, and read-model visibility; TCGplayer external reference/SKU evidence without forbidden commerce facts; and screenshots or operator-visible artifacts for dry-run-only, emergency stop, imports-disabled, promotion-disabled, reapply-disabled, and cache-only option query states.

Record the proof as an interface-only packet with these sections:

- One Piece scope: provider key, unit key, profile version, source scope summary with source-specific identifiers redacted, readiness states, import job id, Source Observation counts, promotion preview/result counts, and read-model visibility.
- Scrydex usage summary: data class `provider-usage-summary`, estimated request count or `estimate-unavailable`, actual request count, page count, cache hit count, cache miss count, usage-check state, credit state, bulk-first confirmation or redacted per-record fallback reason, and redacted diagnostics.
- Regression scopes: one Pokemon scope and one MTG scope exercised through the same Admin interface controls, with provider key, unit key, profile version, import state, Source Observation counts, and promotion preview/result counts.
- Rollout controls: operator-visible proof that only the intended One Piece provider/unit is blocked or opened, including the shared TCGplayer regression that Pokemon and MTG units remain governed independently.

The packet must not include Scrydex API keys, team ids, account identifiers, raw usage responses, full provider URLs, provider-controlled labels, raw provider payloads, provider imagery, or screenshots that expose those values.

### One Piece related docs

- [Catalog Integration One Piece Production Signoff](../../bounded-contexts/catalog/docs/catalog-integration-production-signoff.md#one-piece)
- [Catalog Integration Data Governance](../../bounded-contexts/catalog/docs/catalog-integration-data-governance.md)
- [Catalog Integration Credential Readiness](../../bounded-contexts/catalog/docs/catalog-integration-credential-readiness.md)
- [Catalog Integration Rollout Controls](../../bounded-contexts/catalog/docs/catalog-integration-rollout-controls.md)
- [Catalog Integration Provider Transport Budgets](../../bounded-contexts/catalog/docs/catalog-integration-provider-transport-budgets.md)
- [TCGplayer Automation Operations](./tcgplayer-automation-operations.md)

## Lorcana

Disney Lorcana Catalog sync draws from LorcanaJSON, Lorcast, Scrydex, and the existing Chase Sets TCGplayer provider path. `CATALOG_INTEGRATION_LORCANA_PRODUCTION_SIGNOFF_REFERENCE` must name the accepted provider-data approval and milestone #50 UAT evidence before production-like Lorcana writes are opened.

| Provider | Role | Operator note |
| --- | --- | --- |
| LorcanaJSON | Free public baseline for Lorcana sets, cards, card metadata, image evidence references, and repeatable fixtures | Import selected sets from bulk set files; use all-cards data for option discovery |
| Lorcast | Free public supplemental card and set reference source, including set-scoped card payloads and TCGplayer ids where present | Respect published cache guidance; prefer cached set payloads and set-card endpoints over per-card calls |
| Scrydex | Paid supplemental source when its Lorcana coverage is better for cards, sealed products, variants, or image/price-history evidence | Every request uses credits, so imports must be bulk-first, preflighted, and credit-aware |
| TCGplayer | Marketplace product ids, group/set identity, SKU mapping, condition/language/printing variants, and price-reference evidence | Shared provider key with other games; Lorcana enablement must be unit-aware |
| Ravensburger official Lorcana | Canonical validation reference only unless separate approval permits ingestion | Do not scrape or retain official text/images without approval |

Operator notes:

- Active launch profiles are LorcanaJSON card/set reference data, Lorcast
  card/set reference data, Scrydex card/set reference data, and TCGplayer
  card/sealed-product source observations. The Scrydex Lorcana sealed-product
  profile is fixture-backed `test` lifecycle evidence only and must not be used
  as a production import choice or UAT launch scope until separately approved.
- LorcanaJSON and Lorcast public transports do not require credentials; their normal selected-set path must be bulk/list/search first. LorcanaJSON card and set imports use the selected set file and avoid per-card provider calls; Lorcast card imports use the selected set cards endpoint and selected-card imports still use the set-scoped cards endpoint and filter locally.
- Scrydex and TCGplayer are shared with other games, so do not use broad provider enablement as proof that Lorcana units are approved; production Lorcana enablement must name the Lorcana unit/profile evidence.
- Ravensburger is canonical validation reference only; do not scrape or retain official text/images without separate approval.
- Regression: repeat UI-only smoke proof for one Pokemon set, one MTG set, and one One Piece set through the same shared importer controls.

### Lorcana staging UAT evidence

Milestone #50 accepted the interface-only Lorcana launch proof on `0fc9f20279428b78d19c079cb61085a7f6d0cfd6`. The accepted evidence is:

- `lorcana-launch` run `28278540059`: all active Lorcana providers completed from the shared importer and downstream Catalog Items projection passed.
- second same-SHA `lorcana-launch` run `28278807826`: rerun idempotency proof passed and reached the same downstream projection.
- `all-provider-regression` run `28279080021`: Lorcana providers, One Piece Scrydex/TCGplayer, Pokemon TCGdex, and MTG MTGJSON completed through the same Admin importer; downstream Lorcana Catalog Items projection passed.

The downstream smoke row observed `Abu - Mischievous Monkey ... The First Chapter ... English Lorcana Card Print ... lorcanajson, tcgplayer ... draft`. The proof used Chase Sets screens and redacted workflow logs only; it did not use direct provider URLs, direct APIs, SQL, browser console commands, hidden routes, raw provider payloads, provider imagery, or secrets.

Future milestone #50 revalidation or rollback evidence should use the `lorcana-launch` journey from `deployables/admin-web/e2e/catalog-staging-provider-sync.uat.spec.ts` plus the `all-provider-regression` journey, or an equivalent operator-recorded walkthrough through the same visible controls.

Record an interface-only packet with:

- LorcanaJSON card and set reference scopes: provider key, unit key, profile version, selected set label, import job id, terminal job state, estimated request count, Source Observation counts, and review/promotion summary.
- Lorcast card and set reference scopes: provider key, unit key, profile version, selected set label, cache guidance evidence, import job id, terminal job state, request estimate, Source Observation counts, and review/promotion summary where applicable.
- Active Scrydex Lorcana card/set scopes: shared credential readiness using `SCRYDEX_API_KEY` and `SCRYDEX_TEAM_ID`, usage/credit state, estimated and actual request/page/cache counts, bulk-first confirmation, selected fields, redacted diagnostics, job id, terminal state, and Source Observation counts. Do not include the gated Scrydex sealed-product test profile in launch UAT evidence.
- TCGplayer Lorcana card and sealed scopes: provider key, unit key, profile version, selected product line and set labels, job id, terminal state, external reference/SKU evidence without pricing, inventory, seller, or account facts.
- Downstream smoke: the promoted/reapplied Lorcana item or set visible through a representative Catalog read model/UI.
- Regression scopes: one Pokemon set, one MTG set, and one One Piece set exercised through the same Admin importer controls, with provider key, unit key, profile version, import state, Source Observation counts, and promotion preview/result counts.
- Rollout controls: operator-visible proof that dry-run-only, emergency stop, imports-disabled, promotion-disabled, reapply-disabled, and cache-only option query states block or open only the intended provider/unit.

The packet must not include Scrydex API keys, team ids, account identifiers, raw usage responses, full provider URLs, raw provider payloads, provider imagery, provider screenshots exposing sensitive values, or console captures.

### Lorcana related docs

- [Catalog Integration Lorcana Production Signoff](../../bounded-contexts/catalog/docs/catalog-integration-production-signoff.md#lorcana)
- [Catalog Integration Rollout Controls](../../bounded-contexts/catalog/docs/catalog-integration-rollout-controls.md)
- [Catalog Integration Credential Readiness](../../bounded-contexts/catalog/docs/catalog-integration-credential-readiness.md)
- [Catalog Integration Provider Transport Budgets](../../bounded-contexts/catalog/docs/catalog-integration-provider-transport-budgets.md)
- [Catalog Integration Data Governance](../../bounded-contexts/catalog/docs/catalog-integration-data-governance.md)
- [Catalog Integration Operations](./catalog-integration-operations.md)
- [TCGplayer Automation Operations](./tcgplayer-automation-operations.md)
