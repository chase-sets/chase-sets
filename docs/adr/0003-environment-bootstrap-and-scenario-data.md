# ADR 0003: Environment Bootstrap And Scenario Data

## Status

Accepted, amended by [ADR 0005: Representative Staging Commerce State](./0005-representative-staging-commerce-state.md)

## Context

Catalog is now populated through provider integrations such as TCGdex instead of only hand-authored sample records. Staging and production are long-lived environments, so app bootstrap must not create fake accounts, listings, purchases, reviews, or support cases there.

Before this decision, platform API bootstrap invoked every bounded context seed. Those seeds mixed operating data, Catalog authoring structure, and fake marketplace scenarios. That made it impossible to give staging and production a fresh but real starting point without also creating demo data.

## Decision

Chase Sets uses explicit environment data profiles:

- `critical-bootstrap`: required operating data such as platform admin bootstrap and default commercial terms policy.
- `catalog-integration-bootstrap`: Catalog-owned provider integration structure such as fields, dimensions, categories, reference data, components, and blueprints needed to import and promote provider facts.
- `scenario-seed`: non-production fake/demo accounts, inventory, listings, purchases, fulfillment, payments, settlement, reviews, support cases, and example pricing activity.

Production and staging deployment bootstrap run only `critical-bootstrap` and `catalog-integration-bootstrap`. TCGdex imports in staging and production are operator-triggered. Bootstrap creates import capability and Catalog structure, but does not import, promote, or publish provider content there.

DOKS staging release verification may reconcile `scenario-seed` only through a separate, bounded post-deploy Job after Helm has completed and the worker fleet is available. This exception exists for the deployed browser E2E contract and does not change the staging bootstrap profiles. The Job is forbidden in production.

ADR 0005 adds `representative-commerce-state` as an explicit staging-only operator action. It does not run as normal deployment bootstrap, remains blocked in production, and layers synthetic accounts/commerce usage over real current Catalog integration output rather than creating fake Catalog Items.

Dev, preview, and test may run all three profiles so they can represent real workflows with a small scenario dataset.

## Consequences

- The deploy-critical path for long-lived environments remains bounded to operating data and integration structure.
- DOKS staging's synthetic E2E layer is explicit in release history and isolated from the Helm hook; production remains free of scenario data.
- Non-production environments can still exercise cross-context marketplace behavior.
- Catalog provider integrations own the structure they require instead of relying on fake Catalog Item seeds.
- Scenario seeds must not be used as cross-context contracts. They may depend on scenario aliases or provider-backed facts, but not on production bootstrap.
- Future TCG integrations should add a Catalog integration profile rather than modifying deployables or adding broad shared seed helpers.
