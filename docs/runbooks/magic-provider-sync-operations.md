# Magic Provider Sync Operations

This runbook covers staging and production runtime posture for Magic: The Gathering Catalog sync from MTGJSON, Scryfall, and TCGplayer. Do not paste provider cookies, request headers, account screenshots, raw provider payloads, or retained provider samples into this file, issue comments, logs, fixtures, or PR bodies.

## Runtime Defaults

Staging can run the interface UAT after approved profile versions and provider credentials are present. Production remains safe until activation gates pass:

- `CATALOG_INTEGRATION_CONTROL_PLANE_MODE` defaults to `dry-run-only` in production when unset.
- `CATALOG_INTEGRATION_ACTIVATION_MODE` defaults to `test-profiles-only` in production when unset.
- `CATALOG_INTEGRATION_IMPORTS_DISABLED`, `CATALOG_INTEGRATION_PROMOTION_DISABLED`, and `CATALOG_INTEGRATION_REAPPLY_DISABLED` default to `mtgjson,scryfall,tcgplayer` in production when unset.
- `CATALOG_INTEGRATION_PROVIDER_API_EMERGENCY_STOP` stays empty during normal operation and can be set to a provider key or `all`.

MTGJSON and Scryfall public transports do not require credentials. TCGplayer requires `TCGPLAYER_AUTOMATION_TCG_AUTH_COOKIE` in the executing API and worker environment before live option queries or imports can run.

## Provider Rollout Controls

The three Magic provider keys are `mtgjson`, `scryfall`, and `tcgplayer`. Provider-scoped controls accept one provider key, a comma-separated provider list, or `all`. Use the narrowest provider scope first so MTGJSON can stop without stopping Scryfall or TCGplayer, Scryfall can stop without stopping MTGJSON or TCGplayer, and TCGplayer can stop without stopping MTGJSON or Scryfall.

| Control | MTGJSON behavior | Scryfall behavior | TCGplayer behavior | Code-supported reference |
| --- | --- | --- | --- | --- |
| Disabled provider adapter | Stops provider transport, provider option queries, and imports for `mtgjson`; other providers continue unless also scoped. | Stops provider transport, provider option queries, and imports for `scryfall`; other providers continue unless also scoped. | Stops provider transport, provider option queries, and imports for `tcgplayer`; other providers continue unless also scoped. | `provider-adapter-disabled` in `catalog-integration-rollout-controls.ts`. |
| Dry-run-only control plane | Blocks import, promotion, reapply, and activation while leaving reads and dry-run evidence available. | Same. | Same. | `dry-run-only` in `catalog-integration-rollout-controls.ts`; production default when unset. |
| Imports disabled | Blocks import enqueue and import worker turns for `mtgjson`; existing observations remain inspectable. | Blocks import enqueue and import worker turns for `scryfall`; existing observations remain inspectable. | Blocks import enqueue and import worker turns for `tcgplayer`; existing observations remain inspectable. | `imports-disabled` in `catalog-integration-rollout-controls.ts`; production default includes all three Magic providers when unset. |
| Promotion disabled | Blocks single and bulk Source Observation promotion for `mtgjson`; import and reapply stay governed by their own controls. | Blocks single and bulk Source Observation promotion for `scryfall`; import and reapply stay governed by their own controls. | Blocks single and bulk Source Observation promotion for `tcgplayer`; import and reapply stay governed by their own controls. | `promotion-disabled` in `catalog-integration-rollout-controls.ts`; production default includes all three Magic providers when unset. |
| Reapply disabled | Blocks explicit and scoped reapply for `mtgjson`; import and promotion stay governed by their own controls. | Blocks explicit and scoped reapply for `scryfall`; import and promotion stay governed by their own controls. | Blocks explicit and scoped reapply for `tcgplayer`; import and promotion stay governed by their own controls. | `reapply-disabled` in `catalog-integration-rollout-controls.ts`; production default includes all three Magic providers when unset. |
| Provider API emergency stop | Blocks provider transport, provider option queries, and imports for `mtgjson` during provider incidents; Catalog review of already-recorded observations can continue. | Blocks provider transport, provider option queries, and imports for `scryfall` during provider incidents; Catalog review of already-recorded observations can continue. | Blocks provider transport, provider option queries, and imports for `tcgplayer` during provider incidents; Catalog review of already-recorded observations can continue. | `provider-api-emergency-stop` in `catalog-integration-rollout-controls.ts`. |
| Provider option cache-only | Stops live option queries and serves only fresh or stale cached option pages. If no safe cached page exists, the provider option selector is unavailable. | Same. | Same. | `provider-option-queries-cache-only` in `catalog-integration-rollout-controls.ts` and cache metadata from provider option query responses. |

Operator-visible denial evidence uses `catalog_integration_rollout_control_denied`, `catalog-integration-rollout-control-denied`, the `controlId`, the affected provider, and the capability that was stopped. Do not treat disabled Admin buttons as the enforcement boundary; the server and worker controls enforce the stop.

## Monitoring Signals

During staging UAT and production launch, the Admin Integration health surface and the Catalog Integration Control Plane dashboard must show these signals without exposing provider cookies, account facts, raw payloads, or raw provider URLs:

| Signal | Operator source | Healthy launch expectation |
| --- | --- | --- |
| Provider availability | Integration health provider readiness and provider transport diagnostics. | MTGJSON and Scryfall are ready or not-required; TCGplayer is configured before live TCGplayer work. Provider-specific outages name only the provider and diagnostic code. |
| Option-query freshness, cache-only, and stale state | Import scope option selectors and Integration health option-query status. | Required selectors show fresh or accepted stale/cache-only state before import. Empty cache-only pages block selection. |
| Job lag | Import jobs activity and Integration health job progress. | Queued and running import/reapply/bulk review jobs advance, or show a clear blocked/stale state with the affected provider. |
| Failure rate | Integration job and bulk review terminal outcomes. | Failed import, reapply, promote, reject, and defer work stays at zero for the launch slice or is explained by reviewed diagnostics. |
| Blocked promotions | Promotion preview and review controls. | Blocked counts are reviewed before promotion; production promotion is not enabled while unexplained blocked counts remain. |
| Conflict counts | Conflict resolution workspace and promotion preview summary. | MTGJSON/Scryfall/TCGplayer disagreements have an owner decision or remain blocked from promotion. |
| Duplicate-prevention blocks | Source Observation review, dry-run evidence, and duplicate-prevention preview. | Duplicate blocks are expected, counted, and reviewed; repeated imports do not create duplicate Catalog Items or Products. |
| Emergency-stop state | Integration health rollout controls summary and provider readiness diagnostics. | Emergency stop is clear for normal launch, or active only for the intentionally stopped provider during a drill or incident. |

## TCGplayer Rotation

Rotate the TCGplayer automation cookie when the provider session expires, an operator leaves the provider account, a leak is suspected, or repeated authorization failures continue after cooldown.

1. Set `CATALOG_INTEGRATION_PROVIDER_API_EMERGENCY_STOP=tcgplayer`.
2. Replace `TCGPLAYER_AUTOMATION_TCG_AUTH_COOKIE` through the approved secret path for the target environment.
3. Keep conservative runtime defaults unless an incident review approves a change: request delay `250ms`, cooldown `30000ms`, max concurrent requests `2`, max retries `3`.
4. Redeploy or restart the API and worker components that execute Catalog provider transport.
5. Run a small product-line option query and confirm readiness reports `configured` without exposing the cookie.
6. Clear the emergency stop only after the small query succeeds.

## Emergency Disablement

Use the narrowest switch that stops the unsafe behavior:

- Provider outage or suspected auth leak: `CATALOG_INTEGRATION_PROVIDER_API_EMERGENCY_STOP=<provider>`.
- Stop live option queries while keeping cached choices visible: `CATALOG_INTEGRATION_PROVIDER_OPTION_QUERIES=cache-only`.
- Stop imports for one provider: `CATALOG_INTEGRATION_IMPORTS_DISABLED=<provider>`.
- Stop writes into Catalog truth: `CATALOG_INTEGRATION_PROMOTION_DISABLED=<provider>`.
- Freeze the whole control plane except dry-run evidence: `CATALOG_INTEGRATION_CONTROL_PLANE_MODE=dry-run-only`.

Operator-visible diagnostics may include provider key, unit key, readiness state, domain key, HTTP status class, retry outcome, and redacted diagnostic code. They must not include cookies, authorization headers, seller or account facts, prices, listings, raw request bodies, or raw response bodies.

## Interface-Only Operator Actions

Normal UAT and launch operations happen through the Chase Sets Admin interface: the Integrations Import workbench, Provider setup, Governance, Integration health, validation readiness, conflict resolution, lifecycle recovery, and audit evidence views. Operators must not use handcrafted URLs, direct API calls, CLI commands, SQL, Postman, browser console commands, provider endpoints, or hidden routes for these normal actions.

1. Dry run: open Provider setup or validation readiness, select the Magic provider and approved profile version, run the guided dry run, and review normalized facts, diagnostics, duplicate-prevention preview, conflict preview, source hash status, and redaction summary.
2. Import: open the Integrations Import workbench, select the provider and Magic set scope from the guided option controls, confirm readiness and cache/freshness state, start the import, and watch the job card until it reaches a terminal state.
3. Promotion: open the Source Observation review or promotion preview in the Import workbench, review eligible, blocked, skipped, conflict, and duplicate counts, then promote only the approved scope.
4. Reapply: open lifecycle recovery or the scoped reapply/replay action from the Import workbench, review the impact preview, choose current-active-profile reapply or original-source-profile replay as appropriate, and follow the job card to completion.
5. Pause or resume: use the visible import/reapply job controls to cancel, retry, or resume the affected provider job. Confirm Integration health shows only the intended provider or job state changed.
6. Emergency stop: use the approved release/Ops control workflow to stop the affected provider, then verify in Integration health that the rollout control is active for that provider and not the others. Continue only with read-only review of already-recorded observations until the incident is cleared.
7. Rollback: use Provider setup lifecycle recovery to roll back the provider profile or return to the last approved profile version, then verify readiness, dry-run evidence, and rollback audit evidence in Admin before re-enabling imports or promotions.
8. Post-UAT launch: use the launch checklist and Magic production signoff evidence to confirm provider policy approval, profile versions, dry-run outcomes, import outcomes, promotion outcomes, conflicts, duplicate-prevention blocks, emergency-stop proof, and redaction review before production imports or promotions are enabled.

## Staging UAT Posture

Before running milestone UAT:

1. Confirm MTGJSON and Scryfall readiness is `not-required`.
2. Confirm TCGplayer readiness is `configured` and the scope shows only a redacted runtime secret reference.
3. Keep provider option queries open only for the selected Magic set scope.
4. Keep production dry-run and disable defaults unchanged unless the production signoff checklist is complete.
5. Exercise disabled, dry-run-only, imports-disabled, promotion-disabled, reapply-disabled, provider emergency-stop, and cache-only option-query states for MTGJSON, Scryfall, and TCGplayer through Admin surfaces only.
6. Record evidence through Chase Sets screens and redacted job artifacts only.

## Automated Coverage Map

Use this map when staging UAT records an expected failure mode. The automated tests do not replace interface UAT; they identify the code-level proof that the interface evidence should align with.

| UAT expected failure mode | Automated proof |
| --- | --- |
| An active Magic profile is missing an executable mapping contract, allows live provider calls in fixture gates, omits a required fixture flow, lacks a matching fixture case, or has profile validation errors. | `bounded-contexts/catalog/features/source-observations/api/provider-integration-profiles.test.ts` -> `gates every active Magic profile version on executable fixture-backed mapping coverage`. |
| A partial Magic provider payload should block normalization with structured diagnostics instead of silently appearing promotable. | `bounded-contexts/catalog/features/source-observations/api/provider-profile-contract-harness.test.ts` -> `classifies Magic fixture dry-runs as blocked, changed, ambiguous, promotable, and replay-safe`; backed by partial fixtures for MTGJSON, Scryfall, and TCGplayer Magic profile units. |
| Changed Magic provider payloads should move the source record hash while replay payloads keep the same source record hash and source mapping fingerprint. | `bounded-contexts/catalog/features/source-observations/api/provider-profile-contract-harness.test.ts` -> `keeps replay deterministic while changed fixtures move the source hash`. |
| Ambiguous Magic rows should remain reviewable/blockable through duplicate-prevention policy instead of bypassing operator review. | `bounded-contexts/catalog/features/source-observations/api/provider-profile-contract-harness.test.ts` -> `validates every executable profile against local golden fixtures without provider calls` and `classifies Magic fixture dry-runs as blocked, changed, ambiguous, promotable, and replay-safe`. |
| Promotable TCGplayer Magic sealed products should expose promotion command inputs, selected options, and duplicate-prevention evidence without pricing, inventory, seller, or secret facts. | `bounded-contexts/catalog/features/source-observations/api/provider-profile-contract-harness.test.ts` -> `classifies Magic fixture dry-runs as blocked, changed, ambiguous, promotable, and replay-safe`; `runtime-promotion.test.ts` -> `promotes Magic sealed products with set fields and TCGplayer SKU selected options`. |
| MTGJSON set-reference promotion/reapply should never plan Catalog Item commands and should keep the same Reference Record identity and plan fingerprint across repeated reapply. | `bounded-contexts/catalog/features/source-observations/api/runtime-promotion.test.ts` -> `promotes MTGJSON Magic set-reference observations into Reference Records` and `reapplies promoted MTGJSON Magic set-reference observations without Catalog Item commands`. |
| TCGplayer Magic sealed-product reapply/retry should keep the same Catalog Item identity, SKU selected options, and plan fingerprint across repeated reapply without creating a replacement Catalog Item. | `bounded-contexts/catalog/features/source-observations/api/runtime-promotion.test.ts` -> `reapplies promoted Magic sealed products without replacing the Catalog Item or SKU options`. |

Related docs:

- [Catalog Integration Rollout Controls](../../bounded-contexts/catalog/docs/catalog-integration-rollout-controls.md)
- [Catalog Integration Credential Readiness](../../bounded-contexts/catalog/docs/catalog-integration-credential-readiness.md)
- [TCGplayer Automation Operations](./tcgplayer-automation-operations.md)
