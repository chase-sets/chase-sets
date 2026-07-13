# Listing Evidence Policy

Marketplace owns the versioned Listing Evidence Policy because the policy governs Listing behavior. The shared `platform-policy` machinery supplies event-sourced documents, effective windows, history projection, overlap protection, and deterministic point-in-time resolution; Marketplace owns the typed policy value, evaluation, validation, guided API, and admin UI.

## Policy contract

Each policy document contains stable rule IDs and explanation codes. A rule may select Catalog Item, Product, Blueprint, Category, Dimension and Option identities, the graded-item trait, a price band, or seller trust and risk facts. Outcomes may require a minimum photo count, named evidence slots, pixel dimensions, maximum age, seller trust, and buyer acknowledgment.

Selectors never infer meaning from labels such as “Mint” or “Pristine.” The launch rules store the Catalog seed Option IDs for those conditions. Graded-item and high-dollar behavior use typed Marketplace facts.

All matching rules apply. Evaluation orders matches by priority and stable rule ID, takes the greatest numeric minimum, unions named slots and accepted badges, preserves every seller-trust clause, and lets required buyer acknowledgment win. Within a seller-trust clause, meeting the review threshold or holding any accepted badge satisfies the clause; separate matched clauses remain additive. Validation rejects duplicate rule IDs, invalid ranges, missing stable references, and incompatible view kinds for one slot ID instead of choosing a winner silently.

Every evaluation exposes the policy document ID, stream version, policy hash, matched rule IDs, resolved requirements, effective interval, and explanation codes. The same policy JSON and facts therefore reproduce the same result after a projection rebuild.

## Guided lifecycle

The admin surface uses typed controls rather than a raw JSON editor. Operators can:

1. create a draft from stable selector choices and requirement fields;
2. validate structural rules and projected Catalog references;
3. inspect a semantic rule diff plus exact impacted-Listing count and bounded sample;
4. activate only after selecting an explicit effective time and acknowledging the current impact-preview hash;
5. reject a draft or create a new rollback draft from any retained active version.

Lifecycle labels are Draft, Validated, Scheduled, Active, Superseded, and Rejected. View, draft/edit, validate, and activate are separate permissions. Active history is retained; rollback creates another version and never edits history in place.

## Seed and projection discipline

The Marketplace seed installs the launch policy only when no active Listing Evidence Policy exists. It includes stable Mint and Pristine Option rules, slab/front/back slots for graded items, and the high-dollar photo-plus-trust rule.

Marketplace's existing Catalog projection subscription is versioned for Category identities and Catalog Item category assignments. Marketplace already declares Catalog as a seed requirement, so the projection is mounted only with the Catalog seed gate and rebuilds those stable selector facts from Catalog events.

## Slice boundary

This slice defines and administers policy. The Listings slice resolves and records an immutable requirement snapshot at Listing creation and refreshes it before publication and Offer Acceptance. Those gates call the shared pure coverage evaluator with the recorded generic requirements and current typed evidence; they never infer policy from condition text. Seller evidence UI, Sell List behavior, and Ordering handoff consume the same contracts without moving policy ownership into a deployable.
