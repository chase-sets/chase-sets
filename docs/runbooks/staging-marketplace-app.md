# Staging Marketplace App

`marketplace.staging.chasesets.com` and the staging root `staging.chasesets.com` are served by the Corten marketplace app (`marketplace-corten`). marketplace-web (the `marketplace` component) stays deployed on staging, without a host, so it is one variable change away. While the Corten marketplace runs, `marketplace-corten.staging.chasesets.com` also serves it.

## The switch

The `staging` environment variable `STAGING_MARKETPLACE_APP` selects the app behind `marketplace.staging` and the staging root:

1. Unset or `marketplace-corten`: the Corten marketplace serves them. A release without a Corten marketplace image fails Deploy Staging instead of removing what serves the marketplace.
2. `marketplace`: marketplace-web serves them, and the Corten marketplace is not deployed at all, whether or not the release built its image. The release waits for every enabled workload and rolls back if one never becomes ready, so keeping a broken Corten marketplace out of the release is what lets the rollback itself deploy. The staging ingress wait and the Smoke check skip `marketplace-corten`, and the Advisory Corten marketplace smoke step only says that it was not deployed.

Any other value fails the deploy before Helm runs. Every Deploy Staging run names the app that served the marketplace and whether the variable or the default chose it, in the step summary ("Staging marketplace app"), in the `staging_kubernetes_deploy` step's `marketplace_app` output, and in the deploy record's `stagingMarketplaceApp`, whose `marketplaceCorten` field says `deployed` or `not-deployed`. Production never reads the variable. `/api` paths on the marketplace hosts go to platform-api at the ingress whichever app serves them.

The Smoke check signs in on `marketplace.staging` and opens `/account`, and the Stripe money smoke runs against `marketplace.staging`, so both cover whichever app serves it.

## Roll back to marketplace-web

1. `gh variable set STAGING_MARKETPLACE_APP --repo chase-sets/chase-sets --env staging --body marketplace`
2. Deploy: `gh workflow run platform-production.yml --repo chase-sets/chase-sets --ref main -f release_ref=main -f dispatch_source=manual -f force_deploy=true -f reason="Serve marketplace.staging from marketplace-web"`. A forced Platform Deploy also redeploys production at the same commit; production's marketplace is unaffected by this variable.
3. Check the run: the "Staging marketplace app" summary says marketplace via `STAGING_MARKETPLACE_APP=marketplace` and that marketplace-corten is not deployed, and the Smoke check, which signs in on `marketplace.staging`, passed.

## Return to the Corten marketplace

1. `gh variable delete STAGING_MARKETPLACE_APP --repo chase-sets/chase-sets --env staging` (or set it to `marketplace-corten`).
2. Deploy as in step 2 above, with the reason "Serve marketplace.staging from the Corten marketplace".
3. Check the run: the summary says marketplace-corten (the default, or the variable), the staging ingress wait included `marketplace-corten`, and the Smoke check passed against `marketplace.staging`.
