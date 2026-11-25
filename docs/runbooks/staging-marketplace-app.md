# Staging Marketplace App

`marketplace.staging.chasesets.com`, the staging root `staging.chasesets.com` and `marketplace-corten.staging.chasesets.com` are served by the Corten marketplace app (`marketplace-corten`). marketplace-web (the `marketplace` component) is no longer deployed on staging, and no variable selects it. `/api` paths on the marketplace hosts go to platform-api at the ingress.

A release without a Corten marketplace image fails Deploy Staging instead of removing what serves the marketplace. The staging ingress wait reads `marketplace-corten`'s `/health/ready`, the Smoke check signs in on `marketplace.staging` and opens `/account`, and the Stripe money smoke runs against `marketplace.staging`. Each successful Deploy Staging hands its image digest to Deploy Production through `corten_marketplace_image` (see [Production Marketplace App](./production-marketplace-app.md)).

## Rolling back

Rollback is reverting to an earlier release: deploy an earlier `release_ref` through Platform Deploy, or follow [DOKS Platform Operations](./doks-platform-operations.md#rollback). There is no switch back to marketplace-web.
