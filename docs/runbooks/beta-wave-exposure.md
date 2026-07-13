# Beta Wave Exposure

Public Presence controls **who** enters beta. Argo Rollouts controls the deployment blast radius while a wave-day release is observed. These are separate controls joined by the active `public-presence.beta-waves` policy document.

## Before admitting a wave

1. Open Campaign Analytics and confirm the active policy revision. Wave 1 requires at least 500 total signups, 50 Qualified Seller Signups, and all five supported games at five or more Qualified Seller Signups each.
2. For waves 2 and 3, record checkout failure rate below 2%, near-real-time projections with no sustained backlog, and support load within solo-operator capacity. A date alone never clears these gates.
3. Confirm the policy's `inviteCount` and `rolloutExposurePercent` for the wave. The launch policy pairs 100/10%, 250/25%, and 500/50%; revisions must keep the exposure on an analyzed Argo weight.

## Admit and deploy

Call `POST /api/public-presence/admin/waitlist/waves/{1|2|3}/admit`. For waves 2 and 3, provide:

```json
{
  "checkoutFailureRatePercent": 1.2,
  "projectionsNearRealTime": true,
  "supportWithinSoloOperatorCapacity": true
}
```

The command deterministically ranks signups that are unadmitted or already in the requested wave, while excluding earlier waves. That stable candidate set prevents projection catch-up during a retry from expanding the cohort. Wave 1 prioritizes Qualified Seller Signups before the referral queue; wave 2 prioritizes qualified sellers with live store links, then qualified sellers and referral-queue leaders; wave 3 follows referral-queue order. Each selected signup records one admission event and emits an outbox-backed invitation with a stable idempotency key. Retrying the operation cannot admit the signup to another wave or enqueue a second invite.

Set the staging/production environment variables from the command response:

```text
BETA_WAVE_SIZE=<configuredInviteCount>
BETA_WAVE_ROLLOUT_EXPOSURE_PERCENT=<rolloutExposurePercent>
```

The Kubernetes deployment helper requires the pair together, stamps it on each Rollout, and pauses at that analyzed weight. A mismatch or an unsupported exposure fails before Helm changes the release.

## Observe, promote, halt, or roll back

- While paused, monitor checkout failure rate, projection freshness/backlog, support load, readiness AnalysisRuns, and the wave dashboard/probes.
- Promote only while all application and operations gates remain green: `pnpm run platform:kubernetes-deployment -- promote --namespace <namespace> --release <release> --rollouts-enabled true`.
- Halt new-release exposure immediately with the corresponding `abort` command. Admission events and already-issued invites remain durable; do not attempt to erase the cohort.
- If the stable release must be restored, run `rollback` with the captured Helm revision after aborting. Follow the diagnostics and rollback-target steps in [DOKS platform operations](./doks-platform-operations.md).
