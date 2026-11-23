# Postage Policy

Ordering owns postage policy evaluation because the decision is part of order economics and package-plan creation. The active policy is resolved while checkout previews seller groups, while checkout confirms orders, and while accepted offers become orders.

## Policy Outputs

Each evaluated package plan records a `postagePolicySnapshot` containing:

- `policyVersion`
- `parcelRequired` and `parcelReasons`
- `signatureRequired` and `signatureReasons`
- `insuranceRequired`, `insuranceReasons`, and `insuredValueAmount`
- `shippingEvidenceTier`

Those fields are immutable order facts. Checkout uses them through delivery preview summaries, and Fulfillment uses them for label enforcement.

## Physical Flags

A Postage Policy decides letter eligibility from the Physical Flags on each line's Resolved Product Measure. A Physical Flag names a physical property: `rigid`, `bendable`, `metal`, `jumbo`, or `irregular`. It never names a product kind.

- A line is letter eligible only when it carries every flag in `letterRequiredPhysicalFlags` and none in `parcelRequiredPhysicalFlags`.
- The default policy, `default-postage-policy-v3`, requires `bendable` for a letter and forces a parcel for `rigid`, `metal`, `jumbo`, and `irregular`. An unflagged line needs a parcel.
- `signatureRequiredPhysicalFlags` requires signature delivery confirmation when any line carries one of its flags.

Measures and policies stored while product kinds were Physical Flags may still carry `raw-card`, `slab`, or `sealed`. They stay readable and are evaluated as stored, with no mapping from a kind to a property. Create and revise commands reject a kind in any flag list, so revising such a policy means choosing properties: the Admin Web form names the stored values it no longer offers, by rule, and checks nothing in their place. Cloning such a policy is refused, because a clone creates a policy from the stored payload unchanged; revise the policy first when it is not retired, or recreate it with properties.

The Ordering scenario seed keeps its seeded "Default postage policy" on the compiled default. When that policy is not retired and stores a different `policyVersion`, the seed revises it in place with the stored label and dates. Policies an operator created are never revised by the seed.

## Default Value Tiers

The default platform Postage Policy is runtime-configurable through Admin Web and starts with these value rules:

- Letter mailpiece handling is refused above $50.
- Signature delivery confirmation is required at $250 or more.
- Carrier insurance is required at $500 or more, using the order item subtotal as the insured value.

The evaluated Shipping Evidence Tier is `letter-untracked`, `tracked-parcel`, `signature-confirmed`, or `carrier-insured`. The tier is stored with the order snapshot so Fulfillment, Support, and future dispute-evidence assembly cite the same committed facts.

## Admin Lifecycle

Admins create draft policies, revise thresholds and rule sets, activate a reviewed policy, and retire superseded policies. Activating a policy retires the previously active policy so the resolver has one deterministic active policy for new orders.

Rollback is operationally handled by activating a prior cloned or recreated policy version. Existing orders are not rewritten; they retain the snapshot created at order time.

## Snapshot Coverage

Current package plans without `postagePolicySnapshot` are invalid for Ordering previews and order creation. Historical order and shipment rows may still retain their immutable stored shape, but they must not create active runtime decisions. Cleanup is complete only when:

- Ordering order creation resolves a Postage Policy before package planning.
- Direct runtime `buildPackagePlan` calls pass the resolved policy.
- Checkout previews and order creation fail when a new draft lacks `postagePolicySnapshot`.
- Checkout copy does not hardcode signature or insurance into a shipping option label.
- Fulfillment label purchase uses the order/shipment snapshot instead of current mutable policy state.
