# Postage Policy

Ordering owns postage policy evaluation because the decision is part of order economics and package-plan creation. The active policy is resolved while checkout previews seller groups, while checkout confirms orders, and while accepted offers become orders.

## Policy Outputs

Each evaluated package plan records a `postagePolicySnapshot` containing:

- `policyVersion`
- `parcelRequired` and `parcelReasons`
- `signatureRequired` and `signatureReasons`

Those fields are immutable order facts. Checkout uses them through delivery preview summaries, and Fulfillment uses them for label enforcement.

## Admin Lifecycle

Admins create draft policies, revise thresholds and rule sets, activate a reviewed policy, and retire superseded policies. Activating a policy retires the previously active policy so the resolver has one deterministic active policy for new orders.

Rollback is operationally handled by activating a prior cloned or recreated policy version. Existing orders are not rewritten; they retain the snapshot created at order time.

## Legacy Cleanup

Legacy package plans without `postagePolicySnapshot` remain fulfillable through compatibility behavior, but they must not become the source of truth for new orders. Cleanup is complete only when:

- Ordering order creation resolves a Postage Policy before package planning.
- Direct runtime `buildPackagePlan` calls pass the resolved policy.
- Checkout copy does not hardcode signature into a shipping option label.
- Fulfillment label purchase uses the order/shipment snapshot instead of current mutable policy state.
