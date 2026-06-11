# Reference Info Popup

Reference Info is the design-system primitive for optional structured detail behind a visible fact, label, or short explanation.

Use `ReferenceInfoTrigger` with `ReferenceInfoDialog`. Admin, marketplace, and checkout surfaces should not create competing tooltip, popover, or local dialog treatments for this job.

## Purpose

Reference Info keeps primary screens minimal while still giving users enough detail to understand source data, marketplace terms, payout estimates, matching behavior, registration timing, stale-state recovery, and policy context.

The parent UI must keep required decision facts visible. The popup carries the explanation for users who want it.

## When To Use

Use Reference Info for:

- Catalog admin reference-data details, source/status metadata, attributes, and relationships
- marketplace rail fine print such as Buy Cart matching, listing reservation nuance, Sell List matching, registration timing, stale listing or offer recovery, and watch alert mechanics
- payout, fee, shipping allowance, and standard-terms calculation context
- compact provenance, source, or policy explanation that should not become inline fine print

## When Not To Use

Do not use Reference Info for:

- required decision facts such as price, quantity, selected product options, public account identity, reputation, availability, estimated payout, or final totals
- blocking errors, disabled-action recovery, validation feedback, or stale data that prevents the next step
- destructive confirmations or commitment review
- brief hover-only definitions where `Tooltip` is enough
- short anchored action menus where `Popover` or `Menu` is the right taxonomy
- large, scroll-heavy, form-heavy, or route-worthy workflows

## Anatomy

Reference Info has five parts:

- Trigger: concise linked text or equivalent inline control, with a trailing `info` icon and a specific accessible name.
- Title: names the thing being explained, such as `Estimated payout`, not `More info`.
- Summary: one short sentence that explains why the popup exists.
- Facts: compact key/value rows for source, status, fee, allowance, quote time, or reference metadata.
- Body: short plain-language detail. Link to durable policy pages when the explanation becomes legal, long, or high-stakes.

Use at most one visible Reference Info trigger per workflow or action cluster. Group related details inside the popup instead of adding several info icons.

## Admin Pattern

Catalog admin reference values should use the same primitive as marketplace:

```tsx
<ReferenceInfoTrigger
  href="/reference-records/ref_pokemon"
  onClick={(event) => {
    event.preventDefault();
    openReferenceRecord("ref_pokemon");
  }}
  aria-label="View Manufacturer reference details for The Pokemon Company International"
>
  The Pokemon Company International
</ReferenceInfoTrigger>
```

The corresponding popup should use `ReferenceInfoDialog` sections for type, status, key, attributes, and relationships. Catalog-owned wrappers are acceptable when they only adapt Catalog reference data into the shared primitive.

## Marketplace Pattern

Marketplace rails and checkout review should show the decision fact first, then expose detail through Reference Info:

```tsx
<ReferenceInfoTrigger
  tone="subtle"
  aria-label="View estimated payout details"
  onClick={() => setPayoutInfoOpen(true)}
>
  Estimated payout
</ReferenceInfoTrigger>
```

The popup can include facts such as marketplace fee, shipping allowance, terms source, and quote time. Keep final registered terms review, blocking errors, and changed-term confirmation in the owning workflow surface.

## Wrapper Rule

Bounded contexts may define small wrapper components such as `RailReferenceInfo` or a Catalog reference detail adapter, but wrappers must:

- import `ReferenceInfoTrigger` and `ReferenceInfoDialog` from `@chase-sets/design-system`
- keep overlay behavior, focus management, trigger affordance, and visual treatment in the design-system primitive
- own only domain data mapping and localized copy
- avoid raw `Popover`, `Tooltip`, route-local overlay CSS, or cloned dialog behavior for structured reference details

If a local wrapper cannot use the shared primitive, document the exception in the implementation and add a follow-up issue before the milestone closes.

## Responsive Behavior

The design-system primitive owns the overlay behavior. Desktop should open a focused reference-detail dialog. Mobile or cramped layouts should use the design-system dialog or a future design-system-owned sheet/dialog equivalent, not a bounded-context-owned overlay clone.

## Privacy And Telemetry

Reference Info may explain commercial terms, account-adjacent facts, or marketplace policy. Keep it display-safe:

- Guests may see public buyer or seller profile identity/reputation and current standard terms when the workflow permits it.
- Do not expose private contact, shipping destination, account-specific agreement ids, fee quote fingerprints, raw provider payloads, or implementation-only acceptance identifiers.
- Track the topic and open/close outcome when useful. Do not log hidden sensitive values merely because they appear in the popup.

## Acceptance Checklist

- The trigger has a specific accessible name and `aria-haspopup="dialog"`.
- Required decision facts remain visible outside the popup.
- The popup title names the topic.
- Facts use compact key/value rows.
- Body copy is short and plain language.
- There is no more than one visible trigger per workflow or action cluster.
- Catalog admin, marketplace item detail, and checkout review use the shared design-system primitive or documented thin wrappers around it.
