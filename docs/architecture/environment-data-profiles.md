# Environment Data Profiles

Environment data setup is split by purpose, not by deployable.

## Profiles

`critical-bootstrap` is for operating data required before users can safely administer the system. Examples include platform admin identity/auth when configured and default commercial terms schedules.

`catalog-integration-bootstrap` is for Catalog-owned integration structure. For TCGdex, this includes Pokemon TCG fields, dimensions, options, components, blueprints, categories, reference types, and reference records required to import Source Observations and promote them into Catalog Items.

`scenario-seed` is for fake or demo data. It is allowed only in dev, preview, and tests. It includes demo accounts, inventory, listings, offers, carts, purchases, shipments, payments, settlement entries, reviews, support cases, and pricing examples.

`representative-commerce-state` is explicit staging commerce state. It is production-like, internally controlled marketplace activity for staging review and operational validation. It does not create fake Catalog Items. It keeps Catalog integration output in place, selects active current Catalog Items with product measurement snapshots that have not yet received marketplace activity, then creates representative internal accounts, inventory, listings, offers, purchases, sales, shipments, payments, settlement, payouts, reviews, support requests, notifications, and edge cases around those products. It must be run only by staging reset or an operator-confirmed staging refresh workflow, never as implicit deployment bootstrap.

`admin-qa-actor-fixtures` is explicit staging Identity fixtures for the m65 Admin Workflows Staging QA actor matrix (issue #3016). It provisions the support-safe `admin-qa-*` staging actor aliases that map to real, whole-role Identity grants (`platform-admin`, `owner`, `manager`, `fulfillment`, `viewer`), each magic-link only and idempotent. It does not attempt to provision the single-permission partial-actor rows because Identity has no scoped single-permission membership grant; those stay proven by local regression guardrails only. It must be run only by an operator-confirmed staging fixture workflow, never as implicit deployment bootstrap.

## Environment Policy

| Environment | Data profiles |
| --- | --- |
| Dev | `critical-bootstrap`, `catalog-integration-bootstrap`, `scenario-seed` |
| Test | `critical-bootstrap`, `catalog-integration-bootstrap`, `scenario-seed` |
| Preview | `critical-bootstrap`, `catalog-integration-bootstrap`, `scenario-seed` |
| Staging | `critical-bootstrap`, `catalog-integration-bootstrap` |
| Production | `critical-bootstrap`, `catalog-integration-bootstrap` |

Staging may additionally run `representative-commerce-state` and `admin-qa-actor-fixtures` through an explicit operator action after deployment or reset.

Staging and production are long-lived. They should receive real operator actions and provider imports. Staging may receive synthetic commerce usage, but the synthetic layer must be clearly internal, idempotent, and derived from current Catalog integration data instead of replacing it.

## Provider Imports

Provider imports are Catalog behavior. TCGdex and future TCG integrations should install the Catalog structure they need through a Catalog-owned integration profile.

Staging and production imports are operator-triggered only. Bootstrap should not auto-import, auto-promote, or auto-publish provider content in those environments.

Dev, preview, and tests may auto-create a small provider-backed scenario set so cross-context workflows can be exercised without a huge dataset.

## Operational Checks

- Staging and production bootstrap must not create fake accounts.
- Staging and production bootstrap must not create fake Catalog Items, listings, purchases, reviews, or support cases.
- Staging and production may create Catalog authoring structure and default commercial terms schedules.
- Scenario seeds must remain replay-safe and idempotent in non-production.
- Representative commerce state must remain blocked in production and must require an explicit staging confirmation phrase.
- Representative commerce state must query current active Catalog Items and prefer items with no existing listings or offers.
- Admin QA actor fixtures must remain blocked in production and must require an explicit staging confirmation phrase.
- Admin QA actor fixture evidence must never include emails, account ids, user ids, membership ids, or credentials.
