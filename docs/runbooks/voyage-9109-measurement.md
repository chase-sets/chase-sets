# Temporary Voyage measurement for #9109

One manually enabled measurement, then remove the workflow, harness, test and this
runbook after preserving results with the issue. This is not a permanent CI gate.
No deploy, database writes, hybrid enablement or new credentials are involved.

## Scope and custody

The workflow uses the existing repository VOYAGE_API_KEY only within the staging
GitHub environment. Staging permits main only; normal review/merge protections
must be honored. Do not weaken them or copy the key into local agent secrets.
The subject checkout is pinned to 5177c88d76eceab88ebcb9b21a1088664ef1ff66.
Only synthetic fixture inputs are sent to https://api.voyageai.com/v1/embeddings.

One snapshot plus 30 sequential direct, uncached attempts uses voyage-4-lite,
1024 dimensions, and the pinned query timeout default of 800 ms. The live staging
override is unverified; results explicitly do not represent staging owner-load
p50/p95. All attempts and successful-only distributions are separate. No retries.

## Reviewed cost bound (2026-11-11)

Voyage lists $0.02/million input tokens and a 32,000-token model context:
https://docs.voyageai.com/docs/pricing
https://docs.voyageai.com/docs/embeddings

Reserve the entire 32,000-token context per input before sending, including any
failed/timed-out request. The pinned fixture has 24 documents and at most 72
queries before deduplication, plus 30 timing inputs: <=126 inputs, <=$0.08064 in
provider charges before tax. No free-credit assumption or credit purchase.
The job is standard Linux, limited to 10 minutes (listed $0.006/minute), with
allowlisted small synthetic artifacts retained seven days. $2 is reserved for
non-token charges; the process refuses before estimated total exceeds $20.
https://docs.github.com/en/billing/reference/actions-runner-pricing

This is a run-level bound, not an account-wide cap. Todd's $20 authorization is a
TOTAL, not per run. Record prior spend, dispatch exactly once, and remove the
VOYAGE_9109_APPROVED_SHA enable variable after the measurement job has started (not merely after dispatch acceptance). Automatic reruns are
refused. Do not initiate another run before reconciling prior spend. Ordinary PR
admission/cleanup CI costs must also remain within the total allowance.

## Enable, execute and clean up

After reviewed admission to main, set repository variable
VOYAGE_9109_APPROVED_SHA to the exact reviewed main commit. Dispatch manually on
main with cost_review `9109-reviewed-cost-and-synthetic-inputs`. Do not enable or
dispatch a different code revision. Preserve existing staging protections.

Download and preserve the three synthetic artifact files (snapshot, SHA-256 and
timings) before their seven-day expiry. Record actual usage and failures. Remove
the enable variable and disable the temporary workflow; remove all four introduced
files in a follow-up reviewed cleanup PR. Keep the preserved evidence and normal
repository credential/configuration unchanged. No irreversible artifact deletion.

## Verification and limits

Six offline focused tests and a mocked end-to-end run against the pinned source
validate snapshot creation, 32 mocked requests and 30 timings without real secrets
or network calls. These do not establish live provider behavior or staging config.

Same-head baseline/lexical+rescue/hybrid reports, the S9 matrix and staging owner
telemetry are separate #9109 requirements; this job does not claim to finish them.
