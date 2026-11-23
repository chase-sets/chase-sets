# Staging Admin App

`admin.staging.chasesets.com` is served by the Corten admin app (`admin-corten`). admin-web stays deployed on staging, without a host, so it is one variable change away. While the Corten admin runs, `admin-corten.staging.chasesets.com` also serves it.

## The switch

The `staging` environment variable `STAGING_ADMIN_APP` selects the app behind `admin.staging`:

1. Unset or `admin-corten`: the Corten admin serves it. A release without a Corten admin image fails Deploy Staging instead of removing what serves admin.
2. `admin-web`: admin-web serves it, and the Corten admin is not deployed at all, whether or not the release built its image. The release waits for every enabled workload and rolls back if one never becomes ready, so keeping a broken Corten admin out of the release is what lets the rollback itself deploy. The staging ingress wait and the Smoke check skip `admin-corten`, and the Advisory Corten admin smoke step only says that it was not deployed.

Any other value fails the deploy before Helm runs. Every Deploy Staging run names the app that served admin and whether the variable or the default chose it, in the step summary ("Staging admin app"), in the `staging_kubernetes_deploy` step's and the job's `admin_app` output, and in the deploy record's `stagingAdminApp`, whose `adminCorten` field says `deployed` or `not-deployed`. `/api` paths on the admin host go to platform-api at the ingress whichever app serves admin.

## Roll back to admin-web

1. `gh variable set STAGING_ADMIN_APP --repo chase-sets/chase-sets --env staging --body admin-web`
2. Deploy: `gh workflow run platform-production.yml --repo chase-sets/chase-sets --ref main -f release_ref=main -f dispatch_source=manual -f force_deploy=true -f reason="Serve admin.staging from admin-web"`. A forced Platform Deploy also redeploys production at the same commit; production admin is unaffected by this variable, except that while `PRODUCTION_ADMIN_APP=admin-corten` production has no staged Corten admin image to deploy and refuses before Helm (see [Production Admin App](./production-admin-app.md)).
3. Check the run: the "Staging admin app" summary says admin-web via `STAGING_ADMIN_APP=admin-web` and that admin-corten is not deployed, and the Smoke check, which runs the authenticated admin smoke against `admin.staging`, passed.

## Return to the Corten admin

1. `gh variable delete STAGING_ADMIN_APP --repo chase-sets/chase-sets --env staging` (or set it to `admin-corten`).
2. Deploy as in step 2 above, with the reason "Serve admin.staging from the Corten admin".
3. Check the run: the summary says admin-corten (the default, or the variable), the staging ingress wait included `admin-corten`, and the Smoke check passed against `admin.staging`.
