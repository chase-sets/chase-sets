# Staging Public App

`www.staging.chasesets.com` is served by the Corten public app (`public-corten`). public-web stays deployed on staging, without a host, so it is one variable change away. While the Corten public app runs, `public-corten.staging.chasesets.com` also serves it. The staging root `staging.chasesets.com` is the marketplace's (docs/runbooks/staging-marketplace-app.md), not public's.

## The switch

The `staging` environment variable `STAGING_PUBLIC_APP` selects the app behind `www.staging`:

1. Unset or `public-corten`: the Corten public app serves it. A release without a Corten public image fails Deploy Staging instead of removing what serves `www.staging`.
2. `public-web`: public-web serves it, and the Corten public app is not deployed at all, whether or not the release built its image. The release waits for every enabled workload and rolls back if one never becomes ready, so keeping a broken Corten public app out of the release is what lets the rollback itself deploy. The staging ingress wait and the Smoke check skip `public-corten`, and the Advisory Corten public smoke step only says that it was not deployed.

Any other value fails the deploy before Helm runs. Every Deploy Staging run names the app that served `www.staging` and whether the variable or the default chose it, in the step summary ("Staging public app"), in the `staging_kubernetes_deploy` step's `public_app` output, and in the deploy record's `stagingPublicApp`, whose `publicCorten` field says `deployed` or `not-deployed`. Production never reads the variable. `/api`, `/ucp`, `/mcp` and `/.well-known` on `www.staging` go to platform-api at the ingress whichever app serves it.

The Smoke check's landing smoke runs the derived public route walk (`smoke:public-web-routes --mode healthy`) against `www.staging`, so it covers whichever app serves it.

## Roll back to public-web

1. `gh variable set STAGING_PUBLIC_APP --repo chase-sets/chase-sets --env staging --body public-web`
2. Deploy: `gh workflow run platform-production.yml --repo chase-sets/chase-sets --ref main -f release_ref=main -f dispatch_source=manual -f force_deploy=true -f reason="Serve www.staging from public-web"`. A forced Platform Deploy also redeploys production at the same commit; production's public site is unaffected by this variable.
3. Check the run: the "Staging public app" summary says public-web via `STAGING_PUBLIC_APP=public-web` and that public-corten is not deployed, and the Smoke check, which walks `www.staging`'s public routes, passed.

## Return to the Corten public app

1. `gh variable delete STAGING_PUBLIC_APP --repo chase-sets/chase-sets --env staging` (or set it to `public-corten`).
2. Deploy as in step 2 above, with the reason "Serve www.staging from the Corten public app".
3. Check the run: the summary says public-corten (the default, or the variable), the staging ingress wait included `public-corten`, and the Smoke check passed against `www.staging`.
