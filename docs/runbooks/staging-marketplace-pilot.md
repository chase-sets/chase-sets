# Staging Marketplace Pilot

The Corten marketplace pilot (`marketplace-corten`) runs on staging beside marketplace-web and serves only `marketplace-corten.staging.chasesets.com`. It is an advisory pilot: `marketplace.staging` is still served by marketplace-web, and the Advisory Corten marketplace smoke never fails Deploy Staging.

## The switch

Staging deploys every enabled workload in one Helm release that waits for each pod and rolls back if one never becomes ready. A marketplace pilot that crashes on start would therefore fail Deploy Staging and hold Deploy Production. The `staging` environment variable `STAGING_MARKETPLACE_PILOT` drops it without a revert:

1. Unset or `deployed`: the pilot is deployed when the release built its image, and smoked advisorily. With no image it is deployed disabled, as before.
2. `withheld`: the pilot is rendered disabled whether or not its image was built. The release neither runs nor waits for it, and the Advisory Corten marketplace smoke only says that it was withheld.

Any other value fails the deploy before Helm runs. Every Deploy Staging run says whether the pilot was deployed and what chose it, in the step summary ("Staging marketplace pilot"), in the `staging_kubernetes_deploy` step's `marketplace_pilot` output, and in the deploy record's `stagingMarketplacePilot`. Production never reads the variable.

## Withhold the pilot

1. `gh variable set STAGING_MARKETPLACE_PILOT --repo chase-sets/chase-sets --env staging --body withheld`
2. Re-run the failed Deploy Staging job, or dispatch a Platform Deploy. A forced Platform Deploy also redeploys production at the same commit.
3. Check the run: the "Staging marketplace pilot" summary says it is not deployed via `STAGING_MARKETPLACE_PILOT=withheld`, and the Smoke check passed.

## Deploy it again

1. `gh variable delete STAGING_MARKETPLACE_PILOT --repo chase-sets/chase-sets --env staging` (or set it to `deployed`).
2. Deploy once the pilot's fix has landed.
3. Check the run: the summary says it is deployed, and the Advisory Corten marketplace smoke passed against `marketplace-corten.staging`.
