# Staging Public App

public-corten serves www.staging on every staging deploy. `www.staging.chasesets.com` and `public-corten.staging.chasesets.com` are both served by the Corten public app (`public-corten`). public-web is no longer deployed on staging, and no variable selects it. The staging root `staging.chasesets.com` is the marketplace's (see [Staging Marketplace App](./staging-marketplace-app.md)), not public's. `/api`, `/ucp`, `/mcp` and `/.well-known` on `www.staging` go to platform-api at the ingress.

A release without a Corten public image fails Deploy Staging instead of removing what serves `www.staging`. The staging ingress wait reads `public-corten`'s `/health/ready`, and the Smoke check's landing smoke runs the derived public route walk (`smoke:public-web-routes --mode healthy`) against `www.staging`. Each successful Deploy Staging hands its image digest to Deploy Production through `corten_public_image` (see [Production Public App](./production-public-app.md)).

The `STAGING_PUBLIC_APP` variable is no longer read, and it is not set in the staging environment. A release from before public-web was retired treats it as unset, which means the Corten public app, so rolling back to such a release keeps public-corten serving `www.staging`.

## Rolling back

To roll back, deploy an earlier release_ref. Use Platform Deploy with that `release_ref`, or follow [DOKS Platform Operations](./doks-platform-operations.md#rollback). There is no switch back to public-web.
