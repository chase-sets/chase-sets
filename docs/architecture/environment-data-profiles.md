# Environment Data Profiles

Environment data setup is split by purpose, not by deployable.

## Profiles

`critical-bootstrap` is for operating data required before users can safely administer the system. Examples include platform admin identity/auth when configured and default commercial terms schedules.

`catalog-integration-bootstrap` is for Catalog-owned integration structure. For TCGdex, this includes Pokemon TCG fields, dimensions, options, components, blueprints, categories, reference types, and reference records required to import Source Observations and promote them into Catalog Items.

`scenario-seed` is for fake or demo data. It is allowed only in dev, preview, and tests. It includes demo accounts, inventory, listings, offers, carts, purchases, shipments, payments, settlement entries, reviews, support cases, and pricing examples.

## Environment Policy

| Environment | Data profiles |
| --- | --- |
| Dev | `critical-bootstrap`, `catalog-integration-bootstrap`, `scenario-seed` |
| Test | `critical-bootstrap`, `catalog-integration-bootstrap`, `scenario-seed` |
| Preview | `critical-bootstrap`, `catalog-integration-bootstrap`, `scenario-seed` |
| Staging | `critical-bootstrap`, `catalog-integration-bootstrap` |
| Production | `critical-bootstrap`, `catalog-integration-bootstrap` |

Staging and production are long-lived. They should receive real operator actions and provider imports, not fake marketplace activity.

## Provider Imports

Provider imports are Catalog behavior. TCGdex and future TCG integrations should install the Catalog structure they need through a Catalog-owned integration profile.

Staging and production imports are operator-triggered only. Bootstrap should not auto-import, auto-promote, or auto-publish provider content in those environments.

Dev, preview, and tests may auto-create a small provider-backed scenario set so cross-context workflows can be exercised without a huge dataset.

## Operational Checks

- Staging and production bootstrap must not create fake accounts.
- Staging and production bootstrap must not create fake Catalog Items, listings, purchases, reviews, or support cases.
- Staging and production may create Catalog authoring structure and default commercial terms schedules.
- Scenario seeds must remain replay-safe and idempotent in non-production.
