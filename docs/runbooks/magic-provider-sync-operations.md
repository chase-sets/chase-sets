# Magic Provider Sync Operations

This runbook covers staging and production runtime posture for Magic: The Gathering Catalog sync from MTGJSON, Scryfall, and TCGplayer. Do not paste provider cookies, request headers, account screenshots, raw provider payloads, or retained provider samples into this file, issue comments, logs, fixtures, or PR bodies.

## Runtime Defaults

Staging can run the interface UAT after approved profile versions and provider credentials are present. Production remains safe until activation gates pass:

- `CATALOG_INTEGRATION_CONTROL_PLANE_MODE` defaults to `dry-run-only` in production when unset.
- `CATALOG_INTEGRATION_ACTIVATION_MODE` defaults to `test-profiles-only` in production when unset.
- `CATALOG_INTEGRATION_IMPORTS_DISABLED`, `CATALOG_INTEGRATION_PROMOTION_DISABLED`, and `CATALOG_INTEGRATION_REAPPLY_DISABLED` default to `mtgjson,scryfall,tcgplayer` in production when unset.
- `CATALOG_INTEGRATION_PROVIDER_API_EMERGENCY_STOP` stays empty during normal operation and can be set to a provider key or `all`.

MTGJSON and Scryfall public transports do not require credentials. TCGplayer requires `TCGPLAYER_AUTOMATION_TCG_AUTH_COOKIE` in the executing API and worker environment before live option queries or imports can run.

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

## Staging UAT Posture

Before running milestone UAT:

1. Confirm MTGJSON and Scryfall readiness is `not-required`.
2. Confirm TCGplayer readiness is `configured` and the scope shows only a redacted runtime secret reference.
3. Keep provider option queries open only for the selected Magic set scope.
4. Keep production dry-run and disable defaults unchanged unless the production signoff checklist is complete.
5. Record evidence through Chase Sets screens and redacted job artifacts only.

Related docs:

- [Catalog Integration Rollout Controls](../../bounded-contexts/catalog/docs/catalog-integration-rollout-controls.md)
- [Catalog Integration Credential Readiness](../../bounded-contexts/catalog/docs/catalog-integration-credential-readiness.md)
- [TCGplayer Automation Operations](./tcgplayer-automation-operations.md)
