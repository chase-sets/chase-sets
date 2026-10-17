// Admin catalog workspace goals. Every goal is read-only for the participant:
// catalog sync, promotion, provider commands, and credential entry stay banned,
// and the moderator signs in. Oracles name the bootstrap seed symbol or read
// model the moderator checks; the participant never sees them.
const catalogRoute = (name) => `bounded-contexts/catalog/routes/admin/${name}.tsx`;

export default {
  id: "operator-catalog",
  routeScope: [
    "^bounded-contexts/catalog/routes/",
    "^bounded-contexts/auth/routes/catalog-admin/",
    "^deployables/admin-web/app/routes/catalog-",
  ],
  goals: [
    {
      id: "catalog-item-status",
      version: 1,
      startPath: "/catalog",
      role: "operator",
      host: "admin-web",
      goal: "Find the English Base Set Charizard in the catalog and report its current lifecycle status, its card number, and the rarity recorded for it. Do not create, edit, publish, or archive anything.",
      checks: ["item-found", "item-facts"],
      oracle: {
        "item-found":
          "The Catalog Item row for catalogSeedIds.items.charizardBaseSet (cat_seed_charizard_base_set) in the catalog_items read model; the Japanese Charizard is not a match.",
        "item-facts":
          "Lifecycle status from the catalog_items read model, and card-number 4 plus rarity Holo Rare from the item definition in bounded-contexts/catalog/features/catalog-items/api/seed.ts.",
      },
      routes: {
        [catalogRoute("catalog-items")]: "item-found",
        [catalogRoute("catalog-items-detail")]: "item-facts",
      },
      paths: [
        "bounded-contexts/catalog/features/catalog-items/",
        "bounded-contexts/catalog/routes/admin/catalog-items",
      ],
    },
    {
      id: "catalog-condition-and-fields",
      version: 1,
      startPath: "/catalog",
      role: "operator",
      host: "admin-web",
      goal: "Find out which condition grades a card can be assigned, in the order they are offered, and whether the Card Name field can be searched and sorted. Do not create or change any dimension, option, or field.",
      checks: ["condition-options", "card-name-behavior"],
      oracle: {
        "condition-options":
          "Ordered option names of catalogSeedIds.dimensions.condition in bounded-contexts/catalog/features/dimensions/api/seed.ts, compared with the dimension read model.",
        "card-name-behavior":
          "The searchable and sortable behavior flags of catalogSeedIds.fields.cardName in bounded-contexts/catalog/features/fields/api/seed.ts, compared with the field read model.",
      },
      routes: {
        [catalogRoute("dimensions")]: "condition-options",
        [catalogRoute("dimensions-detail")]: "condition-options",
        [catalogRoute("fields")]: "card-name-behavior",
        [catalogRoute("fields-detail")]: "card-name-behavior",
      },
      paths: [
        "bounded-contexts/catalog/features/dimensions/",
        "bounded-contexts/catalog/features/fields/",
        "bounded-contexts/catalog/routes/admin/dimensions",
        "bounded-contexts/catalog/routes/admin/fields",
      ],
    },
    {
      id: "catalog-blueprint-assembly",
      version: 1,
      startPath: "/catalog",
      role: "operator",
      host: "admin-web",
      goal: "Work out how a Pokémon single card is modeled: name the components that make up its blueprint, the fields its identity component requires, and the display template that presents it together with that template's title pattern. Do not create or change any blueprint, component, or template.",
      checks: ["blueprint-components", "identity-component-fields", "display-template"],
      oracle: {
        "blueprint-components":
          "Component keys attached to catalogSeedIds.blueprints.pokemonCardSingle in bounded-contexts/catalog/features/blueprints/api/seed.ts, compared with the blueprint read model.",
        "identity-component-fields":
          "Field rules of catalogSeedIds.components.singleCardIdentity in bounded-contexts/catalog/features/components/api/seed.ts, compared with the component read model.",
        "display-template":
          "The template targeting that blueprint, catalogSeedIds.displayTemplates.pokemonSingleCardDefault, and its titleTemplate in bounded-contexts/catalog/features/display-templates/api/seed.ts, compared with the display template read model.",
      },
      routes: {
        [catalogRoute("blueprints")]: "blueprint-components",
        [catalogRoute("blueprints-detail")]: "blueprint-components",
        [catalogRoute("components")]: "identity-component-fields",
        [catalogRoute("components-detail")]: "identity-component-fields",
        [catalogRoute("display-templates")]: "display-template",
        [catalogRoute("display-templates-detail")]: "display-template",
      },
      paths: [
        "bounded-contexts/catalog/features/blueprints/",
        "bounded-contexts/catalog/features/components/",
        "bounded-contexts/catalog/features/display-templates/",
        "bounded-contexts/catalog/routes/admin/blueprints",
        "bounded-contexts/catalog/routes/admin/components",
        "bounded-contexts/catalog/routes/admin/display-templates",
      ],
    },
    {
      id: "catalog-category-and-reference",
      version: 1,
      startPath: "/catalog",
      role: "operator",
      host: "admin-web",
      goal: "Find which category the Elite Trainer Boxes category sits under. Then find the Base Set expansion in reference data and report its abbreviation, its release date, and which attribute keys the reference type it belongs to defines. Do not create or change categories, records, or types.",
      checks: ["category-parent", "expansion-record", "reference-type-attributes"],
      oracle: {
        "category-parent":
          "parentKey of catalogSeedIds.categories.eliteTrainerBoxes in bounded-contexts/catalog/features/categories/api/seed.ts, compared with the category read model.",
        "expansion-record":
          "Attributes of catalogSeedIds.referenceRecords.expansions.baseSet in bounded-contexts/catalog/features/reference-data/api/seed.ts (abbreviation, release-date), compared with the reference record read model.",
        "reference-type-attributes":
          "attributeKeys of the expansion type (catalogSeedIds.referenceTypes.expansion) in bounded-contexts/catalog/features/reference-data/api/seed.ts, compared with the reference type read model.",
      },
      routes: {
        [catalogRoute("categories")]: "category-parent",
        [catalogRoute("categories-detail")]: "category-parent",
        [catalogRoute("reference-records")]: "expansion-record",
        [catalogRoute("reference-records-detail")]: "expansion-record",
        [catalogRoute("reference-types")]: "reference-type-attributes",
        [catalogRoute("reference-types-detail")]: "reference-type-attributes",
      },
      paths: [
        "bounded-contexts/catalog/features/categories/",
        "bounded-contexts/catalog/features/reference-data/",
        "bounded-contexts/catalog/routes/admin/categories",
        "bounded-contexts/catalog/routes/admin/reference-",
      ],
    },
    {
      id: "catalog-scope-facts",
      version: 1,
      startPath: "/catalog",
      role: "operator",
      host: "admin-web",
      goal: "Find the Base Set expansion scope and report its set code, its release date, and whether any provider currently covers it. Do not map, sync, review, or change anything.",
      checks: ["scope-found", "scope-facts", "provider-coverage"],
      oracle: {
        "scope-found":
          "The catalog_scope_records row the scope-registry projection derives from catalogSeedIds.referenceRecords.expansions.baseSet.",
        "scope-facts":
          "official_set_code and release_date on that row, seeded as abbreviation and release-date in bounded-contexts/catalog/features/reference-data/api/seed.ts.",
        "provider-coverage":
          "catalog_provider_scope_mappings has no row for that scope in the bootstrap seed, so the coverage matrix lists no provider; confirm on a clean-route revisit of the scope.",
      },
      routes: {
        [catalogRoute("scope-landing")]: "scope-found",
        [catalogRoute("scope-detail")]: "scope-facts",
      },
      paths: [
        "bounded-contexts/catalog/features/scope-registry/",
        "bounded-contexts/catalog/features/provider-scope-mapping/",
        "bounded-contexts/catalog/features/source-observations/ui/admin-control-plane/scope-",
        "bounded-contexts/catalog/routes/admin/scope-",
      ],
    },
    {
      id: "catalog-sync-batch-status",
      version: 1,
      startPath: "/catalog/scopes/sync-batches",
      role: "operator",
      host: "admin-web",
      goal: "You have been asked whether a batch sync of catalog scopes is in progress. Report whether one is running, and which product domains a new batch could target. Do not preview or start a batch, and do not upload anything.",
      checks: ["batch-status", "domain-options"],
      oracle: {
        "batch-status":
          "The scope sync batch route loader returns no batch in the bootstrap seed (no batch is seeded); compare with the scope-sync-batches read model.",
        "domain-options":
          "catalogScopeProductDomains in bounded-contexts/catalog/features/scope-registry/domain/contract.ts, the product-domain choices the new-batch form offers.",
      },
      routes: {
        [catalogRoute("scope-sync-batches")]: "batch-status",
      },
      paths: [
        "bounded-contexts/catalog/features/scope-sync-batches/",
        "bounded-contexts/catalog/routes/admin/scope-sync-batches",
      ],
    },
    {
      id: "catalog-promoted-observation",
      version: 1,
      startPath: "/catalog/integrations",
      role: "operator",
      host: "admin-web",
      goal: "A Pikachu card pulled from the TCGdex provider has already been promoted into the catalog. Find that provider record, confirm it is shown as promoted, and report the source address its data came from. Do not run a sync, promote, reject, defer, reapply, or replay anything.",
      checks: ["promoted-row", "source-evidence"],
      oracle: {
        "promoted-row":
          "catalogBrowserE2ePromotedObservation (tcgdex_en_base2_60) in bounded-contexts/catalog/features/source-observations/api/seeding/seed.ts, status promoted in the source observation read model.",
        "source-evidence":
          "source_url of that observation in the source observation read model, as served by the observation-evidence resource route into the evidence sheet; a row summary or toast is not the evidence sheet.",
      },
      routes: {
        [catalogRoute("integrations")]: "promoted-row",
        [catalogRoute("integrations-observation-evidence")]: "source-evidence",
      },
      paths: [
        "bounded-contexts/catalog/features/source-observations/ui/",
        "bounded-contexts/catalog/support/route-support/admin-integrations/",
        "bounded-contexts/catalog/routes/admin/integrations",
      ],
    },
    {
      id: "catalog-observation-origin",
      version: 1,
      startPath: "/catalog/source-observations/tcgdex_en_base2_60",
      role: "operator",
      host: "admin-web",
      goal: "You followed a link to a provider record for a Pikachu card. Report which catalog item it was promoted into, which provider it came from, and the address its data was read from. Do not promote, reject, or change anything.",
      checks: ["promotion-target", "provider-and-source"],
      oracle: {
        "promotion-target":
          "promotionCommand.catalogItemId (catalogSeedIds.items.pikachuJungle) in bounded-contexts/catalog/features/source-observations/api/seeding/seed.ts, compared with promoted_catalog_item_id in the source observation read model.",
        "provider-and-source":
          "provider_key tcgdex and source_url for tcgdex_en_base2_60 in the source observation read model.",
      },
      routes: {
        [catalogRoute("source-observations-detail")]: "promotion-target",
      },
      paths: [
        "bounded-contexts/catalog/features/source-observations/ui/source-observation-detail-page",
        "bounded-contexts/catalog/routes/admin/source-observations-detail",
      ],
    },
    {
      id: "catalog-provider-readiness",
      version: 1,
      startPath: "/catalog/providers/tcgdex",
      role: "operator",
      host: "admin-web",
      goal: "You are checking on the TCGdex provider. Report which profile version is currently active and whether the provider is reported ready to import. Do not create a draft, edit a section, activate, deprecate, retire, save evidence, or start anything.",
      checks: ["active-profile", "readiness"],
      oracle: {
        "active-profile":
          "The tcgdex entry of catalogProviderIntegrationProfileVersions in bounded-contexts/catalog/features/source-observations/api/providers/registry.ts (profileVersion 2026.06.03, active), seeded by seedCatalogProviderIntegrationProfileVersions.",
        readiness:
          "Provider readiness in the provider-detail read model (bounded-contexts/catalog/support/route-support/admin-integrations/provider-detail-loader.ts).",
      },
      routes: {
        [catalogRoute("catalog-provider-detail")]: "active-profile",
      },
      paths: [
        "bounded-contexts/catalog/features/source-observations/ui/admin-control-plane/provider-detail/",
        "bounded-contexts/catalog/routes/admin/catalog-provider-detail",
      ],
    },
    {
      id: "catalog-integration-controls",
      version: 1,
      startPath: "/catalog/integrations/governance",
      role: "operator",
      host: "admin-web",
      goal: "An older note linked you to this page. Report whether the import kill switch and the promotion kill switch are currently on or off and what rollout mode is in effect, then find where this same information now lives in the current navigation so you can update your bookmark. Finally, report whether any provider import jobs are active or failed right now. Do not change any control and do not start, retry, resume, or cancel anything.",
      checks: ["kill-switches", "rollout-mode", "current-location", "job-status"],
      oracle: {
        "kill-switches":
          "importKillSwitchActive and promotionKillSwitchActive in the governance controls read model (bounded-contexts/catalog/support/route-support/admin-integrations/governance-loader.ts).",
        "rollout-mode": "rolloutMode.state in the same governance controls read model.",
        "current-location":
          "The canonical Settings child renders the identical governance surface; the governance path is a retained alias (bounded-contexts/catalog/routes/admin/integrations-settings.tsx). Confirm the participant ended on the Settings child, not only the alias.",
        "job-status":
          "import-job-progress-summary in the health read model (bounded-contexts/catalog/support/route-support/admin-integrations/health-loader.ts); the bootstrap seed runs no import job.",
      },
      routes: {
        [catalogRoute("integrations-governance")]: "kill-switches",
        [catalogRoute("integrations-settings")]: "current-location",
        [catalogRoute("integrations-health")]: "job-status",
      },
      paths: [
        "bounded-contexts/catalog/features/source-observations/ui/admin-control-plane/settings/",
        "bounded-contexts/catalog/features/source-observations/ui/admin-control-plane/evidence/",
        "bounded-contexts/catalog/features/source-observations/api/governance/",
        "bounded-contexts/catalog/routes/admin/integrations-",
      ],
    },
    {
      id: "catalog-admin-sign-in",
      version: 1,
      startPath: "/catalog/sign-in",
      role: "operator",
      host: "admin-web",
      startSignedIn: false,
      goal: "You need to get into the catalog workspace. Reach the point where you would enter your credentials, report what the sign-in form asks for and any alternative sign-in options it offers, then stop. Do not enter or submit a password, code, or passkey.",
      checks: ["sign-in-form", "no-credential-submitted"],
      oracle: {
        "sign-in-form":
          "The catalog-admin sign-in route re-exports the shared access sign-in form (bounded-contexts/auth/routes/catalog-admin/sign-in.tsx); compare the reported fields and options against that form.",
        "no-credential-submitted":
          "The action recorder shows no text typed into a password or code field and no form submit; a clean-route revisit confirms the session is still signed out.",
      },
      routes: {
        "bounded-contexts/auth/routes/catalog-admin/sign-in.tsx": "sign-in-form",
      },
      paths: ["bounded-contexts/auth/routes/catalog-admin/", "bounded-contexts/auth/routes/access-admin/sign-in"],
    },
  ],
  excludedRoutes: [
    { path: "deployables/admin-web/app/routes/catalog-home.tsx", reason: "redirect-only" },
    { path: "deployables/admin-web/app/routes/catalog-layout.tsx", reason: "layout-only" },
    {
      path: catalogRoute("scope-coverage"),
      reason:
        "fixture-gap: no proposed Provider Scope Mapping in the bootstrap seed, so the unmapped-scope inbox is empty",
    },
    {
      path: catalogRoute("scope-coverage-detail"),
      reason:
        "fixture-gap: no proposed Provider Scope Mapping in the bootstrap seed; an inbox row is the only in-product link to a scope's coverage page",
    },
  ],
};
