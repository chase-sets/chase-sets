# Production Marketplace App

`marketplace.chasesets.com` is served by marketplace-web unless the `production` environment variable `PRODUCTION_MARKETPLACE_APP` says otherwise. The Corten marketplace app (`marketplace-corten`) takes over the same host; there is no separate Corten marketplace host in production, and `/api` paths on the marketplace host go to platform-api at the ingress whichever app serves it. The production apex `chasesets.com` and `www.chasesets.com` stay with public-web either way. The marketplace host exists only while `PRODUCTION_MARKETPLACE_SERVED` (or `PRODUCTION_MARKETPLACE_PUBLIC_ENABLED`) is `true`.

## The switch

`PRODUCTION_MARKETPLACE_APP` selects the app behind `marketplace.chasesets.com`:

1. Unset or `marketplace`: marketplace-web serves it, and the Corten marketplace is not deployed, whatever image staging built. Nothing about the pilot can fail or hold a production release in this mode.
2. `marketplace-corten`: the Corten marketplace serves it, running the image digest that Deploy Staging deployed and smoked for the same release (`needs.deploy-staging.outputs.corten_marketplace_image`). The deploy's `helm upgrade --wait --atomic` is the gate: the Corten marketplace must become ready, then the Smoke check smokes `marketplace.chasesets.com` and also signs in there and opens `/account`, as staging's Smoke check does on `marketplace.staging`.

Any other value fails the deploy before Helm runs. Every Deploy Production run names the app in the step summary ("Production marketplace app"), in the `production_kubernetes_deploy` step's and the job's `marketplace_app` output, and in the deploy record's `productionMarketplaceApp`, whose `marketplaceCorten` field says `deployed` or `not-deployed`.

A failed switch shows as a red Deploy Production that rolled back to marketplace-web. The response is to fix forward on staging, not to retry production.

## Gates before setting the variable

Set `PRODUCTION_MARKETPLACE_APP=marketplace-corten` only when all of these hold, and record each one on the switch issue:

1. A green staging deploy whose Smoke check passed against `marketplace.staging` served by the Corten marketplace, signed in (see [Staging Marketplace App](./staging-marketplace-app.md)).
2. Telemetry: a Grafana look shows traces for `service.name=marketplace-corten` and both exported marketplace metrics by `service_name` from staging. If either is missing, fix the export before switching.
3. Money: a settled card checkout on the staging Corten marketplace, on a listing other than the canary, run after the deploy that carries the pilot's wait for the order after `payment_start_pending`. The payment must reach captured and the order must leave pending payment.
4. 3-D Secure: a card that requires authentication completes its hosted 3-D Secure step and returns to the order on the staging Corten marketplace, run after the deploy that carries hosted 3-D Secure for inline card checkout.

## Switch to the Corten marketplace

1. `gh variable set PRODUCTION_MARKETPLACE_APP --repo chase-sets/chase-sets --env production --body marketplace-corten`
2. Deploy: `gh workflow run platform-production.yml --repo chase-sets/chase-sets --ref main -f release_ref=main -f dispatch_source=manual -f force_deploy=true -f reason="Serve marketplace.chasesets.com from the Corten marketplace"`.
3. Check the run: the "Production marketplace app" summary says marketplace-corten via `PRODUCTION_MARKETPLACE_APP=marketplace-corten`, the deploy record's `productionMarketplaceApp.marketplaceCorten` is `deployed`, and the Smoke check and the served-marketplace invitation gate passed against `marketplace.chasesets.com`.

## Roll back to marketplace-web

1. `gh variable delete PRODUCTION_MARKETPLACE_APP --repo chase-sets/chase-sets --env production` (or set it to `marketplace`).
2. Deploy as in step 2 above, with the reason "Serve marketplace.chasesets.com from marketplace-web".
3. Check the run: the summary says marketplace and that marketplace-corten is not deployed, and the Smoke check passed against `marketplace.chasesets.com`.

## When Deploy Production refuses before Helm

These refusals change nothing in production, but they hold every later production release until someone acts. Both apply only under `PRODUCTION_MARKETPLACE_APP=marketplace-corten`.

1. "corten-marketplace-image is required on production": Deploy Staging deployed no Corten marketplace image for this release, because staging serves marketplace-web (`STAGING_MARKETPLACE_APP=marketplace`) or the image was not built. Recover by setting `PRODUCTION_MARKETPLACE_APP=marketplace` (or deleting it) and re-running, or by returning staging to the Corten marketplace and deploying again.
2. "PROXIES is required on production": the ingress pod CIDRs could not be read, and the Corten marketplace would take every request as coming from the ingress. Recover by setting `PRODUCTION_MARKETPLACE_APP=marketplace` (or deleting it) and re-running, or by fixing the ingress pod CIDR discovery in the deploy step and deploying again.