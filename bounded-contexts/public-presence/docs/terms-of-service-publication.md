# Terms of Service Publication

Public Presence owns the durable Terms of Service artifact and publishes it at `/terms`. Settlement remains the semantic source for Wallet and Wallet Adjustment behavior. Identity remains the acceptance owner and consumes only generated policy key/version metadata through `@chase-sets/public-docs`.

The Terms of Service is one tenant of the public policy registry (`features/policies/domain/policy-registry.ts`), which enumerates every launch legal document as a Public Policy Artifact. The corpus compiler (`pnpm --filter @chase-sets/public-presence run compile:public-policies`, staleness-checked with `check:public-policies`) emits one generated metadata module per document into `contracts/public-docs/generated/` plus a content-insensitive index.

## Current posture

The checked-in `v1` artifact is intentionally marked `counsel-review-required`. Its required subject taxonomy, stable link, locale, consent key, and version are implemented; its effective timestamp, counsel approval reference, reviewed rollout jurisdictions or product limits, and operative legal wording are intentionally unset. The visible page labels every subject as requiring counsel-approved language and does not represent the placeholder as effective terms.

Qualified counsel must review the actual launch jurisdictions and wallet purchase/payout capabilities, including prepaid access, money transmission, stored value, unclaimed property, consumer notice and error resolution, and state-specific cash-refund implications. Store the resulting non-privileged approval reference in the artifact metadata; do not commit privileged advice.

## Publication procedure

1. Replace each subject placeholder with the counsel-approved wording without changing Settlement product truth silently.
2. Record `counsel-approved` on every required subject and add the external approval reference.
3. Record the reviewed rollout jurisdictions or product limits and an ISO effective timestamp.
4. Change the artifact publication status to `published`, regenerate the `@chase-sets/public-docs` metadata contract with the corpus compile script, and activate the same version through Identity's `identity.terms-of-service-active-version` policy.
5. Run the Public Presence and Identity suites, the public-copy launch audit in launch mode, script tests, and static checks before production promotion.

If counsel requires a product behavior change, keep the artifact non-effective and create a fixed-scope issue in the behavior-owning bounded context. Do not reshape Settlement behavior inside Public Presence policy copy.

## Launch and change guard

`evaluateTermsOfServicePublicationReadiness` rejects missing subjects, unreviewed copy, a non-published status, a missing or invalid effective timestamp, a placeholder approval reference, and an empty rollout-scope record. The deployed public-copy audit independently reads `/terms` machine metadata and rejects launch mode unless the canonical key, canonical version, published status, and effective timestamp are present.

A material revision receives a new monotonically increasing `vN` artifact. Historical versions remain immutable in git history; publication and Identity activation use the same generated metadata so the consent gate cannot drift from the linked public artifact.
