# Production Admin App

admin-corten serves admin.chasesets.com on every production deploy. admin-web is no longer deployed in production, and no variable selects it. There is no separate Corten admin host in production, and `/api` paths on the admin host go to platform-api at the ingress.

## How a release reaches production

Every Deploy Production run deploys the Corten admin image digest that Deploy Staging deployed and smoked for the same release (`needs.deploy-staging.outputs.corten_admin_image`). The deploy's `helm upgrade --wait --atomic` is the gate: the Corten admin must become ready. The Smoke check then runs the authenticated admin smoke against `admin.chasesets.com`, as staging's Smoke check does on `admin.staging`.

A failed deploy shows as a red Deploy Production that Helm rolled back to the previous release. The response is to fix forward on staging, not to retry production.

The `PRODUCTION_ADMIN_APP` variable is no longer read. It stays set to `admin-corten` while a release from before admin-web was retired is still a rollback target: such a release still reads it, and deleting it would put that release back on admin-web. Leave it alone until those releases are out of the rollback window.

## Rolling back

To roll back, deploy an earlier release_ref. Use Platform Deploy with that `release_ref`, or follow [DOKS Platform Operations](./doks-platform-operations.md#rollback). There is no switch back to admin-web.

## When Deploy Production refuses before Helm

These refusals change nothing in production, and production keeps serving the last release, but they hold every later production release until someone acts.

1. "corten-admin-image is required on production": Deploy Staging deployed no Corten admin image for this release, because the image was not built. Recover by fixing the Corten admin image build and deploying again.
2. "PROXIES is required on production": the ingress pod CIDRs could not be read, and the Corten admin would take every request as coming from the ingress. Recover by fixing the ingress pod CIDR discovery in the deploy step and deploying again.
