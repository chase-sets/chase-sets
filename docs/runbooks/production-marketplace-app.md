# Production Marketplace App

`marketplace.chasesets.com` is served by the Corten marketplace app (`marketplace-corten`). marketplace-web (the `marketplace` component) is no longer deployed in production, and no variable selects it. `/api` paths on the marketplace host go to platform-api at the ingress. The production apex `chasesets.com` and `www.chasesets.com` are covered by [Production Public App](./production-public-app.md). The marketplace host exists only while `PRODUCTION_MARKETPLACE_SERVED` (or `PRODUCTION_MARKETPLACE_PUBLIC_ENABLED`) is `true`.

## How a release reaches production

Every Deploy Production run deploys the Corten marketplace image digest that Deploy Staging deployed and smoked for the same release (`needs.deploy-staging.outputs.corten_marketplace_image`). The deploy's `helm upgrade --wait --atomic` is the gate: the Corten marketplace must become ready. The Smoke check then smokes `marketplace.chasesets.com`, signs in there and opens `/account`, as staging's Smoke check does on `marketplace.staging`.

A failed deploy shows as a red Deploy Production that Helm rolled back to the previous release. The response is to fix forward on staging, not to retry production.

## Rolling back

Rollback is reverting to an earlier release: follow [DOKS Platform Operations](./doks-platform-operations.md#rollback), or deploy an earlier `release_ref` through Platform Deploy. There is no switch back to marketplace-web.

## When Deploy Production refuses before Helm

These refusals change nothing in production, and production keeps serving the last release, but they hold every later production release until someone acts.

1. "corten-marketplace-image is required on production": Deploy Staging deployed no Corten marketplace image for this release, because the image was not built. Recover by fixing the Corten marketplace image build and deploying again.
2. "PROXIES is required on production": the ingress pod CIDRs could not be read, and the Corten marketplace would take every request as coming from the ingress. Recover by fixing the ingress pod CIDR discovery in the deploy step and deploying again.
