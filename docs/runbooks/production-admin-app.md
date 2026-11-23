# Production Admin App

`admin.chasesets.com` is served by admin-web unless the `production` environment variable `PRODUCTION_ADMIN_APP` says otherwise. The Corten admin app (`admin-corten`) takes over the same host; there is no separate Corten admin host in production, and `/api` paths on the admin host go to platform-api at the ingress whichever app serves admin.

## The switch

`PRODUCTION_ADMIN_APP` selects the app behind `admin.chasesets.com`:

1. Unset or `admin-web`: admin-web serves it, and the Corten admin is not deployed, whatever image staging built. Nothing about the pilot can fail or hold a production release in this mode.
2. `admin-corten`: the Corten admin serves it, running the image digest that Deploy Staging deployed and smoked for the same release (`needs.deploy-staging.outputs.corten_admin_image`). The deploy's `helm upgrade --wait --atomic` is the gate: the Corten admin must become ready, then the Smoke check runs the authenticated admin smoke against `admin.chasesets.com`.

Any other value fails the deploy before Helm runs. Every Deploy Production run names the app in the step summary ("Production admin app"), in the `production_kubernetes_deploy` step's and the job's `admin_app` output, and in the deploy record's `productionAdminApp`, whose `adminCorten` field says `deployed` or `not-deployed`.

A failed switch shows as a red Deploy Production that rolled back to admin-web. The response is to fix forward on staging, not to retry production.

## Switch to the Corten admin

Only after a green staging deploy whose Smoke check passed against `admin.staging` served by the Corten admin (see [Staging Admin App](./staging-admin-app.md)).

1. `gh variable set PRODUCTION_ADMIN_APP --repo chase-sets/chase-sets --env production --body admin-corten`
2. Deploy: `gh workflow run platform-production.yml --repo chase-sets/chase-sets --ref main -f release_ref=main -f dispatch_source=manual -f force_deploy=true -f reason="Serve admin.chasesets.com from the Corten admin"`.
3. Check the run: the "Production admin app" summary says admin-corten via `PRODUCTION_ADMIN_APP=admin-corten`, the deploy record's `productionAdminApp.adminCorten` is `deployed`, and the Smoke check passed against `admin.chasesets.com`.

## Roll back to admin-web

1. `gh variable delete PRODUCTION_ADMIN_APP --repo chase-sets/chase-sets --env production` (or set it to `admin-web`).
2. Deploy as in step 2 above, with the reason "Serve admin.chasesets.com from admin-web".
3. Check the run: the summary says admin-web and that admin-corten is not deployed, and the Smoke check passed against `admin.chasesets.com`.

## When Deploy Production refuses before Helm

These refusals change nothing in production, but they hold every later production release until someone acts. Both apply only under `PRODUCTION_ADMIN_APP=admin-corten`.

1. "corten-admin-image is required on production": Deploy Staging deployed no Corten admin image for this release, because staging serves admin-web (`STAGING_ADMIN_APP=admin-web`) or the image was not built. Recover by setting `PRODUCTION_ADMIN_APP=admin-web` (or deleting it) and re-running, or by returning staging to the Corten admin and deploying again.
2. "PROXIES is required on production": the ingress pod CIDRs could not be read, and the Corten admin would take every request as coming from the ingress. Recover by setting `PRODUCTION_ADMIN_APP=admin-web` (or deleting it) and re-running, or by fixing the ingress pod CIDR discovery in the deploy step and deploying again.
