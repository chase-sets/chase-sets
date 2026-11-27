# Staging Admin App

admin-corten serves admin.staging on every staging deploy. `admin.staging.chasesets.com` and `admin-corten.staging.chasesets.com` are both served by the Corten admin app (`admin-corten`). admin-web is no longer deployed on staging, and no variable selects it. `/api` paths on the admin hosts go to platform-api at the ingress.

A release without a Corten admin image fails Deploy Staging instead of removing what serves admin. The staging ingress wait reads `admin-corten`'s `/health/ready`, and the Smoke check runs the authenticated admin smoke against `admin.staging`. Each successful Deploy Staging hands its image digest to Deploy Production through `corten_admin_image` (see [Production Admin App](./production-admin-app.md)).

The `STAGING_ADMIN_APP` variable is no longer read. It stays set while a release from before admin-web was retired is still a rollback target, because such a release still reads it; leave it alone until those releases are out of the rollback window.

## Rolling back

To roll back, deploy an earlier release_ref. Use Platform Deploy with that `release_ref`, or follow [DOKS Platform Operations](./doks-platform-operations.md#rollback). There is no switch back to admin-web.
