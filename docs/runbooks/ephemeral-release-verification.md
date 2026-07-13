# Ephemeral Release Verification

`Platform Ephemeral Verification` proves the first staging-elimination workload without changing the persistent staging deploy gate. After a successful `Platform Deploy` run on `main`, it verifies the same release image in a new `chase-sets-verify-<run>-<attempt>` namespace on the staging DOKS cluster. Operators may also dispatch a specific release ref.

The workflow uses the preview Helm path and its containerized Postgres. It resets the namespace, registers test-mode Stripe account/Connect and EasyPost webhooks for the namespace host, applies namespace-local runtime secrets, deploys the promoted image, runs `representative-commerce-state`, platform smoke, and Stripe money smoke, uploads `ephemeral-verification/v1` evidence, deletes the provider registrations, and tears down the namespace. Persistent staging remains deployed and remains the release gate in phase 1.

Teardown is mandatory. Both provider deletion and namespace teardown use `if: always()`, and a surviving namespace fails the run. The scheduled `Platform Preview Cleanup` sweep is the backstop: it selects only namespaces that both match `chase-sets-verify-<run>-<attempt>` and carry `chasesets.com/purpose=release-verification`, waits six hours, deletes exact-host provider registrations, and then performs the same verified Kubernetes teardown. Never make either namespace deletion step best-effort.

## Evidence and retirement decision

The release-health report exposes `persistentStagingCatchRate`, the fraction of measured deployable release attempts that persistent staging stopped, plus ephemeral verification success/failure counts. The phase-1 decision remains `retain-persistent-staging` until all of these are true:

- at least ten measured deployable release attempts are available;
- the persistent staging-only catch count is zero across that window;
- at least one release has successful `ephemeral-verification/v1` evidence;
- the evidence window has no ephemeral verification failure.

Meeting those thresholds changes the report to `eligible-for-explicit-retirement-review`; it does not delete staging or change the production workflow. Retiring persistent staging requires a separate approved change after reviewing the failure modes and cost evidence.

For a failed run, inspect the uploaded representative-commerce evidence and the workflow's Kubernetes diagnostics. Confirm the final provider and namespace deletion steps ran. If either cleanup step failed, rerun `Platform Preview Cleanup` after correcting access; do not manually delete unrelated preview or staging resources.
