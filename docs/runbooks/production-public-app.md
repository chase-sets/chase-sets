# Production Public App

public-corten serves chasesets.com and www.chasesets.com on every production deploy. public-web is no longer deployed in production, and no variable selects it. There is no separate Corten public host in production, and `/api`, `/ucp`, `/mcp` and `/.well-known` on both hosts go to platform-api at the ingress. `marketplace.chasesets.com` and `admin.chasesets.com` are covered by [Production Marketplace App](./production-marketplace-app.md) and [Production Admin App](./production-admin-app.md).

## How a release reaches production

Every Deploy Production run deploys the Corten public image digest that Deploy Staging deployed and smoked for the same release (`needs.deploy-staging.outputs.corten_public_image`). The deploy's `helm upgrade --wait --atomic` is the gate: the Corten public app must become ready. The Smoke check's landing smoke then walks the public routes on `chasesets.com` (`smoke:public-web-routes --mode healthy`), as staging's does on `www.staging`.

Production indexes the public site (`CHASE_SETS_PUBLIC_INDEXING=true`), which staging never does. After a deploy that changes the public app, `https://chasesets.com/robots.txt` must allow crawling and name the sitemap, `https://chasesets.com/sitemap.xml` must list the home page, and the home page must carry no `noindex`.

A failed deploy shows as a red Deploy Production that Helm rolled back to the previous release. The response is to fix forward on staging, not to retry production.

The `PRODUCTION_PUBLIC_APP` variable is no longer read. It stays set to `public-corten` while a release from before public-web was retired is still a rollback target: such a release still reads it, and deleting it would put that release back on public-web. Leave it alone until those releases are out of the rollback window.

## Rolling back

To roll back, deploy an earlier release_ref. Use Platform Deploy with that `release_ref`, or follow [DOKS Platform Operations](./doks-platform-operations.md#rollback). There is no switch back to public-web.

## When Deploy Production refuses before Helm

These refusals change nothing in production, and production keeps serving the last release, but they hold every later production release until someone acts.

1. "corten-public-image is required on production": Deploy Staging deployed no Corten public image for this release, because the image was not built. Recover by fixing the Corten public image build and deploying again.
2. "PROXIES is required on production": the ingress pod CIDRs could not be read, and the Corten public app would take every request as coming from the ingress. Recover by fixing the ingress pod CIDR discovery in the deploy step and deploying again.
