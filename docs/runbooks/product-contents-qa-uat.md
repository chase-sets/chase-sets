# Product Contents QA/UAT

Product Contents QA closes only after the implementation PRs for Catalog authoring, provider evidence, Discovery detail, and Discovery search are merged and deployed to the target environment. Do not use this runbook to invent launch proof from local code alone.

## Seeded Scenario

Catalog bootstrap reconciles Product Content Type and Product Content Inclusion Policy configuration during `catalog-integration-bootstrap`. Non-production `scenario-seed` and the explicit staging `representative-commerce-state` refresh both reconcile one representative relationship:

- container: Prismatic Evolutions Booster Pack
- contained: Pikachu, Prismatic Evolutions
- content type: Card
- inclusion policy: Randomized
- provenance: the active seed profile (`scenario-seed` or `representative-commerce-state`)

This scenario proves the configured-label path without repurposing seeded sealed-product identity fields such as `pack-count` or `sealed-product-form`.

Local development and PR previews receive the scenario through `scenario-seed`. Long-lived staging receives only this curated Catalog fixture through the explicitly confirmed `Platform Staging Representative Commerce State` workflow; normal staging deploy bootstrap still does not create it. The refresh creates any missing fixture item streams, projects the Catalog Items, reconciles Product Contents, synchronizes Catalog and Discovery detail/search projections, and prioritizes both items outside the ordinary untouched-item budget.

When `scenario-seed` is enabled, host seed reconciliation drains projections and reruns the seed after Catalog Item projections settle. If the first pass logs that the Product Contents scenario was skipped until Catalog Item projections are available, that is not terminal by itself; the later reconciliation pass should write the relationship after `catalog.catalog-item-projection` catches up.

## Staging Scenario Selection

For long-lived staging Marketplace UAT, first run the confirmed representative commerce refresh and use the Prismatic Evolutions fixture. A support-safe provider/imported or admin-authored pair remains a valid fallback for additional coverage. Do not use private account IDs, provider payloads, tokens, raw Source Observation JSON, or unpublished provider IDs in public evidence.

1. Confirm the release containing Product Contents detail/search support is deployed to staging.
2. Confirm the container and contained Catalog Items are visible on public staging Marketplace after the representative refresh. Public evidence may name titles and public item slugs only.
3. For the curated fixture, confirm the seeded Card/Randomized relationship. For a fallback pair, use staging Admin Catalog to author the Product Contents line.
4. Confirm the Catalog API read model returns the relationship:

```http
GET /api/catalog/product-contents/containers/:containerCatalogItemId
GET /api/catalog/product-contents/contained/:containedCatalogItemId
```

5. Wait for projection catch-up or use Platform Operations to refresh these projection groups:

```text
catalog.catalog-product-contents-projection
discovery.discovery-item-detail-projection
discovery.discovery-search-item-projection
```

6. Recheck public staging Marketplace:

- container detail shows `Contents`
- contained detail shows `Included in`
- search for the contained item returns the container as a lower-ranked related result

If public staging search returns zero results for both fixture items while a control search succeeds after a green representative refresh, inspect the refresh evidence and its Catalog/Discovery projection steps; the fixture is no longer subject to the ordinary Catalog Item budget. A separate visible pair may still be used to continue UAT while that refresh failure is diagnosed.

## Required Evidence

Record the target environment, deployed commit, data profile, and each command or UI route used. Public issue comments and PR bodies must not include account IDs, bearer tokens, provider payloads, private URLs, or raw Source Observation JSON.

| Surface | Evidence to collect |
| --- | --- |
| API | Catalog Product Contents routes list configured types and policies, replace/read canonical contents, read reverse containers, reject invalid content types/policies, and keep provider evidence out of canonical contents until reviewed. |
| MCP | Native `/mcp` and UCP `/ucp/mcp` negotiate the same protocol baseline. Product Contents are visible only through already-supported marketplace/search/detail reads unless a dedicated Product Contents MCP tool is added. Any future write tool must require the same auth, validation, idempotency, and audit evidence as API/Admin. |
| Admin | An operator can use configured content types to author or review contents, distinguish provider evidence from canonical contents, and verify reverse `Included in` lookup without raw JSON or direct API calls. |
| Marketplace | A container item detail shows `Contents`, a contained item detail shows `Included in`, and search for the contained item returns the container as a lower-ranked related result. |
| Cross-surface copy | Display labels come from Product Content Type and Inclusion Policy configuration. Code must not hardcode product-line terms such as promo, booster, deck, accessory, or insert outside seed/configuration data. |

## Suggested Checks

Run scoped checks first:

```powershell
pnpm --filter @chase-sets/catalog run test:fast
pnpm --filter @chase-sets/discovery run test:fast
pnpm run test:e2e:suite marketplace_browse,catalog_admin_modeling,catalog_admin_integrations
pnpm run test:scripts
```

Use the MCP smoke checks in [UCP Agent Commerce](./ucp-agent-commerce.md) for native `/mcp` and UCP `/ucp/mcp` protocol parity. Use [Playwright E2E](./playwright-e2e.md) for local or deployed browser evidence.

## Closeout

The final closeout should link the PRs or issue comments containing:

- seeded configuration and representative scenario proof
- API route or contract-test evidence
- MCP protocol/discovery evidence and an explicit statement of whether Product Contents has dedicated MCP write/read tools
- Admin UI evidence for authoring/review and provider-evidence isolation
- Marketplace item-detail and search evidence
