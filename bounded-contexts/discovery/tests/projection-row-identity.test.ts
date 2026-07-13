import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { TransportEvent } from "@chase-sets/event-core/transport";
import { buildTransportEvent } from "@chase-sets/event-core/test-support";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { buildDiscoveryCategoryProjectionHandlers } from "../features/categories/read-model/projection";
import { buildDiscoveryItemDetailProjectionHandlers } from "../features/item-detail/read-model/projection";
import { buildProductAlertPageProjectionHandlers } from "../features/product-alerts/read-model/projection";
import { buildDiscoverySearchItemProjectionHandlers } from "../features/search/read-model/projection";
import { buildGoogleShoppingFeedRowProjectionHandlers } from "../features/google-shopping-operations/api/projection";
import { buildDiscoveryMarketProjectionHandlers } from "../support/market-support/projection";
import { discoverySchemaSql } from "../support/runtime-support/schema";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI) {
  throw new Error("TEST_DATABASE_URL is required for database-backed tests in CI.");
}
const describeDb = databaseBaseUrl ? describe : describe.skip;
const contextNames = ["discovery"] as const;

describeDb("discovery projection row identity", () => {
  let pool: PgTransactionalPool;
  let pools: Readonly<Record<(typeof contextNames)[number], PgTransactionalPool>>;

  beforeAll(async () => {
    const databaseUrls = createMultiContextTestDatabaseUrls(
      requireDatabaseBaseUrl(),
      contextNames,
      "discovery_projection_rows",
    );
    await ensureMultiContextTestDatabases(requireDatabaseBaseUrl(), databaseUrls);
    pools = createMultiContextTestPools(databaseUrls);
    pool = pools.discovery;
  });

  beforeEach(async () => {
    nextGlobalPosition = 0;
    await resetMultiContextTestSchemas({ discovery: pool });
    await pool.query(discoverySchemaSql);
  });

  afterAll(async () => {
    await closeMultiContextTestPools(pools);
  });

  it("projects representative discovery rows exactly as the pre-toolkit SQL did", async () => {
    const categoryHandlers = buildDiscoveryCategoryProjectionHandlers(pool);
    const searchHandlers = buildDiscoverySearchItemProjectionHandlers(pool);
    const itemDetailHandlers = buildDiscoveryItemDetailProjectionHandlers(pool);
    const productAlertHandlers = buildProductAlertPageProjectionHandlers(pool);
    const marketHandlers = buildDiscoveryMarketProjectionHandlers(pool);
    const googleShoppingHandlers = buildGoogleShoppingFeedRowProjectionHandlers(pool);
    const catalogHandlers = [categoryHandlers, searchHandlers, itemDetailHandlers, googleShoppingHandlers];

    await projectAll(
      catalogHandlers,
      event("catalog.category.created", "catalog.category-cat_parent", {
        categoryId: "cat_parent",
        key: "pokemon",
        name: text("Pokemon"),
        description: text("Pokemon cards"),
        displayOrder: 1,
      }),
    );
    await projectAll(
      catalogHandlers,
      event("catalog.category.created", "catalog.category-cat_child", {
        categoryId: "cat_child",
        key: "singles",
        name: text("Singles"),
        description: text("Single cards"),
        parentCategoryId: "cat_parent",
        displayOrder: 2,
      }),
    );
    await projectAll(
      catalogHandlers,
      event("catalog.category.revised", "catalog.category-cat_child", {
        key: "featured-singles",
        name: text("Featured Singles"),
        description: text("Featured single cards"),
        parentCategoryId: "cat_parent",
        displayOrder: 3,
      }),
    );
    await projectAll(catalogHandlers, event("catalog.category.published", "catalog.category-cat_parent", {}));
    await projectAll(catalogHandlers, event("catalog.category.published", "catalog.category-cat_child", {}));

    await projectAll(
      catalogHandlers,
      event("catalog.catalog-item.created", "catalog.item-item_1", {
        itemId: "item_1",
        languageCode: "en",
        title: text("Charizard"),
        subtitle: text("Base Set"),
        description: text("Original description"),
      }),
    );
    await projectAll(
      catalogHandlers,
      event("catalog.catalog-item.category-assigned", "catalog.item-item_1", { categoryId: "cat_parent" }),
    );
    await projectAll(
      catalogHandlers,
      event("catalog.catalog-item.category-assigned", "catalog.item-item_1", { categoryId: "cat_child" }),
    );
    await projectAll(
      catalogHandlers,
      event("catalog.catalog-item.category-assigned", "catalog.item-item_1", { categoryId: "cat_child" }),
    );
    await projectAll(
      catalogHandlers,
      event("catalog.catalog-item.category-removed", "catalog.item-item_1", { categoryId: "cat_parent" }),
    );
    await projectAll(catalogHandlers, event("catalog.catalog-item.published", "catalog.item-item_1", {}));

    await projectAll(
      catalogHandlers,
      event("catalog.blueprint.created", "catalog.blueprint-bp_card", {
        blueprintId: "bp_card",
        name: text("Trading Card"),
      }),
    );
    await projectAll(
      catalogHandlers,
      event("catalog.blueprint.revised", "catalog.blueprint-bp_card", {
        name: text("Pokemon Card"),
      }),
    );
    await projectAll(
      catalogHandlers,
      event("catalog.dimension.created", "catalog.dimension-dim_condition", {
        dimensionId: "dim_condition",
        name: text("Condition"),
        valueKind: "ordered",
      }),
    );
    await projectAll(
      catalogHandlers,
      event("catalog.dimension.option-added", "catalog.dimension-dim_condition", {
        optionId: "opt_nm",
        code: "near_mint",
        label: text("Near Mint"),
        displayOrder: 1,
        numericValue: 9,
        status: "active",
      }),
    );
    await projectAll(
      catalogHandlers,
      event("catalog.dimension.option-revised", "catalog.dimension-dim_condition", {
        optionId: "opt_nm",
        code: "near_mint_plus",
        label: text("Near Mint+"),
        displayOrder: 2,
        numericValue: 9.5,
        status: "active",
      }),
    );
    await projectAll(
      catalogHandlers,
      event("catalog.dimension.options-reordered", "catalog.dimension-dim_condition", {
        optionIds: ["opt_nm"],
      }),
    );
    await projectAll(
      catalogHandlers,
      event("catalog.blueprint.dimensions-set", "catalog.blueprint-bp_card", {
        dimensionRules: [
          {
            dimensionId: "dim_condition",
            required: true,
            allowedOptionIds: ["opt_nm"],
            appliesWhen: [],
          },
        ],
      }),
    );
    await projectAll(
      catalogHandlers,
      event("catalog.blueprint.product-resolution-rules-set", "catalog.blueprint-bp_card", {
        canonicalDimensionOrder: ["dim_condition"],
      }),
    );
    await projectAll(
      catalogHandlers,
      event("catalog.catalog-item.blueprint-assigned", "catalog.item-item_1", { blueprintId: "bp_card" }),
    );

    await projectAll(
      catalogHandlers,
      event("catalog.field.created", "catalog.field-fld_character", {
        fieldId: "fld_character",
        name: text("Character"),
        valueType: "reference",
        behavior: { filterable: true, searchable: true, sortable: false },
      }),
    );
    await projectAll(
      catalogHandlers,
      event("catalog.reference-record.created", "catalog.reference-record-ref_charizard", {
        referenceRecordId: "ref_charizard",
        typeKey: "pokemon",
        key: "charizard",
        name: text("Charizard"),
        attributes: { number: "4/102" },
        relationships: [],
      }),
    );
    await projectAll(
      catalogHandlers,
      event("catalog.reference-record.published", "catalog.reference-record-ref_charizard", {}),
    );
    await projectAll(
      catalogHandlers,
      event("catalog.catalog-item.field-value-set", "catalog.item-item_1", {
        fieldId: "fld_character",
        value: { referenceId: "ref_charizard" },
      }),
    );
    await projectAll(
      catalogHandlers,
      event("catalog.catalog-item.field-value-cleared", "catalog.item-item_1", { fieldId: "fld_unused" }),
    );
    await projectAll(
      catalogHandlers,
      event("catalog.catalog-item.metadata-revised", "catalog.item-item_1", {
        description: text("Revised description"),
      }),
    );
    await projectAll(
      catalogHandlers,
      event("catalog.catalog-item.tags-set", "catalog.item-item_1", { tags: ["fire", "holo"] }),
    );
    await projectAll(
      catalogHandlers,
      event("catalog.catalog-item.image-urls-set", "catalog.item-item_1", {
        imageUrls: ["https://assets.example/item_1/front.jpg"],
      }),
    );
    await projectAll(
      catalogHandlers,
      event("catalog.catalog-item.product-asset-sets-set", "catalog.item-item_1", {
        productAssetSets: [
          {
            variants: [
              {
                role: "catalog-detail",
                publicUrl: "https://assets.example/item_1/detail.webp",
                width: 960,
                height: 1344,
              },
            ],
          },
        ],
      }),
    );
    await projectAll(
      catalogHandlers,
      event("catalog.catalog-item.image-fallback-set", "catalog.item-item_1", {
        imageFallback: { url: "https://assets.example/item_1/fallback.jpg" },
      }),
    );
    await projectAll(catalogHandlers, event("catalog.catalog-item.image-fallback-cleared", "catalog.item-item_1", {}));

    await project(
      productAlertHandlers,
      event("discovery.product-alert.created", "discovery.product-alert-alert_1", {
        alertId: "alert_1",
        accountId: "buyer_1",
        marketSide: "listing",
        catalogItemId: "item_1",
        productId: "product_1",
        selectedOptions: [{ dimensionId: "dim_condition", optionId: "opt_nm" }],
        productSummary: "Near Mint Charizard",
        thresholdAmount: "125.00",
      }),
    );
    await project(productAlertHandlers, event("discovery.product-alert.paused", "discovery.product-alert-alert_1", {}));
    await project(
      productAlertHandlers,
      event("discovery.product-alert.resumed", "discovery.product-alert-alert_1", {}),
    );
    await project(
      productAlertHandlers,
      event("discovery.product-alert.deleted", "discovery.product-alert-alert_1", {}),
    );

    await project(
      marketHandlers,
      event("identity.account.created", "identity.account-acc_seller", {
        accountId: "acc_seller",
        displayName: "Seller One",
      }),
    );
    await project(
      marketHandlers,
      event("identity.account.profile-updated", "identity.account-acc_seller", {
        displayName: "Seller Uno",
      }),
    );
    await project(marketHandlers, event("identity.account.suspended", "identity.account-acc_seller", {}));
    await project(marketHandlers, event("identity.account.reactivated", "identity.account-acc_seller", {}));
    await project(
      marketHandlers,
      event("marketplace.seller-listing-availability.disabled", "marketplace.seller-listing-availability-acc_seller", {
        accountId: "acc_seller",
        reasonCategory: "vacation",
        availableAgainOn: "2026-07-01",
      }),
    );
    await project(
      marketHandlers,
      event("marketplace.seller-listing-availability.enabled", "marketplace.seller-listing-availability-acc_seller", {
        accountId: "acc_seller",
      }),
    );
    await project(
      marketHandlers,
      event("marketplace.listing.created", "marketplace.listing-listing_1", {
        listingId: "listing_1",
        accountId: "acc_seller",
        inventoryItemId: "inv_1",
        catalogItemId: "item_1",
        productId: "product_1",
        itemTitle: "Charizard",
        itemSubtitle: "Base Set",
        selectedOptions: [{ dimensionId: "dim_condition", optionId: "opt_nm" }],
        productSummary: "Near Mint Charizard",
        storageLocationName: "Vault A",
        shipFromCode: "US",
        priceAmount: "150.00",
        shippingAllowancePercentageBps: 600,
        quantityCap: 2,
        purchaseLimits: {
          maxUnitsPerOrder: 1,
          maxUnitsPerDay: 2,
          maxUnitsPerCustomerAccount: 3,
        },
      }),
    );
    await project(
      marketHandlers,
      event("marketplace.listing.price-updated", "marketplace.listing-listing_1", {
        priceAmount: "145.00",
        shippingAllowancePercentageBps: 650,
      }),
    );
    await project(
      marketHandlers,
      event("marketplace.listing.purchase-limits-updated", "marketplace.listing-listing_1", {
        purchaseLimits: {
          maxUnitsPerOrder: 2,
          maxUnitsPerDay: 4,
          maxUnitsPerCustomerAccount: 6,
        },
      }),
    );
    await project(marketHandlers, event("marketplace.listing.published", "marketplace.listing-listing_1", {}));
    await project(marketHandlers, event("marketplace.listing.paused", "marketplace.listing-listing_1", {}));
    await project(marketHandlers, event("marketplace.listing.published", "marketplace.listing-listing_1", {}));
    await project(
      marketHandlers,
      event("marketplace.offer.submitted", "marketplace.offer-offer_1", {
        offerId: "offer_1",
        buyerAccountId: "buyer_1",
        catalogItemId: "item_1",
        productId: "product_1",
        itemTitle: "Charizard",
        itemSubtitle: "Base Set",
        selectedOptions: [{ dimensionId: "dim_condition", optionId: "opt_nm" }],
        productSummary: "Near Mint Charizard",
        priceAmount: "130.00",
        quantityRequested: 1,
      }),
    );
    await project(
      marketHandlers,
      event("marketplace.offer.accepted", "marketplace.offer-offer_1", {
        offerId: "offer_1",
        sellerAccountId: "acc_seller",
        acceptedAt: "2026-06-12T13:01:00.000Z",
      }),
    );
    await project(
      marketHandlers,
      event("marketplace.review.submitted", "marketplace.review-review_1", {
        reviewId: "review_1",
        authorAccountId: "buyer_1",
        subjectAccountId: "acc_seller",
        authorRole: "buyer",
        rating: 5,
        feedback: "Packed well.",
        submittedAt: "2026-06-12T13:02:00.000Z",
      }),
    );
    await project(
      marketHandlers,
      event("marketplace.review.updated", "marketplace.review-review_1", {
        reviewId: "review_1",
        rating: 4,
        feedback: "Packed well after update.",
        updatedAt: "2026-06-12T13:03:00.000Z",
      }),
    );
    await project(
      marketHandlers,
      event("marketplace.review.withdrawn", "marketplace.review-review_1", {
        reviewId: "review_1",
        withdrawnAt: "2026-06-12T13:04:00.000Z",
      }),
    );

    const snapshot = await readDiscoveryProjectionSnapshot(pool);

    // Row-identity proof: these expected rows are hand-computed from the pre-toolkit handlers' SQL for this event stream.
    expect(snapshot).toEqual(
      JSON.parse(`{
  "productAlertPages": [
    {
      "alert_id": "alert_1",
      "account_id": "buyer_1",
      "market_side": "listing",
      "catalog_catalog_item_id": "item_1",
      "product_id": "product_1",
      "selected_options": [
        {
          "optionId": "opt_nm",
          "dimensionId": "dim_condition"
        }
      ],
      "product_summary": "Near Mint Charizard",
      "threshold_amount": "125.00",
      "status": "deleted",
      "created_at": "2026-06-12T12:32:00.000Z",
      "updated_at": "2026-06-12T12:35:00.000Z"
    }
  ],
  "categorySources": [
    {
      "category_id": "cat_child",
      "key": "featured-singles",
      "slug": "featured-singles-cat-child-1xgxzwe",
      "name": "Featured Singles",
      "description": "Featured single cards",
      "status": "active",
      "parent_category_id": "cat_parent",
      "display_order": 3,
      "updated_at": "2026-06-12T12:05:00.000Z"
    },
    {
      "category_id": "cat_parent",
      "key": "pokemon",
      "slug": "pokemon-cat-parent-1gy3ipk",
      "name": "Pokemon",
      "description": "Pokemon cards",
      "status": "active",
      "parent_category_id": null,
      "display_order": 1,
      "updated_at": "2026-06-12T12:04:00.000Z"
    }
  ],
  "categoryItemSources": [
    {
      "catalog_item_id": "item_1",
      "category_ids": [
        "cat_child",
        "cat_child"
      ],
      "status": "active",
      "updated_at": "2026-06-12T12:11:00.000Z"
    }
  ],
  "categories": [
    {
      "category_id": "cat_child",
      "key": "featured-singles",
      "slug": "featured-singles-cat-child-1xgxzwe",
      "name": "Featured Singles",
      "description": "Featured single cards",
      "status": "active",
      "parent_category_id": "cat_parent",
      "parent_category": {
        "name": "Pokemon",
        "categoryId": "cat_parent"
      },
      "display_order": 3,
      "item_count": 1,
      "updated_at": "2026-06-12T12:05:00.000Z"
    },
    {
      "category_id": "cat_parent",
      "key": "pokemon",
      "slug": "pokemon-cat-parent-1gy3ipk",
      "name": "Pokemon",
      "description": "Pokemon cards",
      "status": "active",
      "parent_category_id": null,
      "parent_category": null,
      "display_order": 1,
      "item_count": 0,
      "updated_at": "2026-06-12T12:04:00.000Z"
    }
  ],
  "searchCatalogItems": [
    {
      "catalog_item_id": "item_1",
      "slug": "charizard-base-set-item-1-1i58wji",
      "resolved_aliases": {},
      "language_code": "en",
      "title_i18n": {
        "values": {
          "en": "Charizard"
        },
        "defaultLocale": "en"
      },
      "title": "Charizard",
      "subtitle_i18n": {
        "values": {
          "en": "Base Set"
        },
        "defaultLocale": "en"
      },
      "subtitle": "Base Set",
      "display_badges": [],
      "description_i18n": {
        "values": {
          "en": "Revised description"
        },
        "defaultLocale": "en"
      },
      "description": "Revised description",
      "blueprint_id": "bp_card",
      "status": "active",
      "field_values": [
        {
          "value": {
            "referenceId": "ref_charizard"
          },
          "fieldId": "fld_character"
        }
      ],
      "category_ids": [
        "cat_child"
      ],
      "tags": [
        "fire",
        "holo"
      ],
      "image_urls": [
        "https://assets.example/item_1/front.jpg"
      ],
      "product_asset_sets": [
        {
          "variants": [
            {
              "role": "catalog-detail",
              "width": 960,
              "height": 1344,
              "publicUrl": "https://assets.example/item_1/detail.webp"
            }
          ]
        }
      ],
      "image_fallback": null,
      "updated_at": "2026-06-12T12:31:00.000Z"
    }
  ],
  "searchBlueprints": [
    {
      "blueprint_id": "bp_card",
      "name": "Pokemon Card",
      "updated_at": "2026-06-12T12:13:00.000Z"
    }
  ],
  "searchBlueprintDimensions": [
    {
      "blueprint_id": "bp_card",
      "dimension_id": "dim_condition",
      "required": true,
      "allowed_option_ids": [
        "opt_nm"
      ],
      "applies_when": [],
      "display_order": 0,
      "updated_at": "2026-06-12T12:18:00.000Z"
    }
  ],
  "searchFields": [
    {
      "field_id": "fld_character",
      "key": "",
      "name": "Character",
      "value_type": "reference",
      "filterable": true,
      "searchable": true,
      "sortable": false,
      "updated_at": "2026-06-12T12:21:00.000Z"
    }
  ],
  "searchReferenceRecords": [
    {
      "reference_record_id": "ref_charizard",
      "type_key": "pokemon",
      "key": "charizard",
      "slug": "",
      "name": "Charizard",
      "attributes": {
        "number": "4/102"
      },
      "relationships": [],
      "status": "active",
      "updated_at": "2026-06-12T12:23:00.000Z"
    }
  ],
  "searchDimensions": [
    {
      "dimension_id": "dim_condition",
      "name": "Condition",
      "value_kind": "ordered",
      "updated_at": "2026-06-12T12:14:00.000Z"
    }
  ],
  "searchDimensionOptions": [
    {
      "option_id": "opt_nm",
      "dimension_id": "dim_condition",
      "code": "near_mint_plus",
      "label": "Near Mint+",
      "display_order": 0,
      "numeric_value": "9.5",
      "status": "active",
      "updated_at": "2026-06-12T12:17:00.000Z"
    }
  ],
  "searchItems": [
    {
      "catalog_item_id": "item_1",
      "slug": "charizard-base-set-item-1-1i58wji",
      "language_code": "en",
      "title_i18n": {
        "values": {
          "en": "Charizard"
        },
        "defaultLocale": "en"
      },
      "title": "Charizard",
      "subtitle_i18n": {
        "values": {
          "en": "Base Set"
        },
        "defaultLocale": "en"
      },
      "subtitle": "Base Set",
      "display_badges": [],
      "description_i18n": {
        "values": {
          "en": "Revised description"
        },
        "defaultLocale": "en"
      },
      "description": "Revised description",
      "blueprint_id": "bp_card",
      "blueprint_name": "Pokemon Card",
      "status": "active",
      "category_names": [
        "Featured Singles"
      ],
      "category_slugs": [
        "featured-singles-cat-child-1xgxzwe"
      ],
      "tags": [
        "fire",
        "holo"
      ],
      "field_values_text": "Charizard charizard pokemon number 4/102",
      "field_filter_values": [
        {
          "label": "Character",
          "value": "ref_charizard",
          "fieldId": "fld_character",
          "sortKind": null,
          "sortValue": null,
          "valueType": "reference",
          "valueLabel": "Charizard"
        }
      ],
      "reference_filter_values": [
        {
          "label": "Pokemon",
          "typeKey": "pokemon",
          "sortKind": null,
          "sortValue": null,
          "referenceId": "ref_charizard",
          "referenceLabel": "Charizard"
        }
      ],
      "dimension_filter_values": [
        {
          "label": "Condition",
          "optionId": "opt_nm",
          "valueKind": "ordered",
          "dimensionId": "dim_condition",
          "optionLabel": "Near Mint+",
          "displayOrder": 0,
          "numericValue": 9.5
        }
      ],
      "image_urls": [
        "https://assets.example/item_1/front.jpg"
      ],
      "product_asset_sets": [
        {
          "variants": [
            {
              "role": "catalog-detail",
              "width": 960,
              "height": 1344,
              "publicUrl": "https://assets.example/item_1/detail.webp"
            }
          ]
        }
      ],
      "image_fallback": null,
      "updated_at": "2026-06-12T12:31:00.000Z"
    }
  ],
  "itemDetailCatalogItems": [
    {
      "catalog_item_id": "item_1",
      "slug": "charizard-base-set-item-1-1i58wji",
      "language_code": "en",
      "title_i18n": {
        "values": {
          "en": "Charizard"
        },
        "defaultLocale": "en"
      },
      "title": "Charizard",
      "subtitle_i18n": {
        "values": {
          "en": "Base Set"
        },
        "defaultLocale": "en"
      },
      "subtitle": "Base Set",
      "display_badges": [],
      "description_i18n": {
        "values": {
          "en": "Revised description"
        },
        "defaultLocale": "en"
      },
      "description": "Revised description",
      "blueprint_id": "bp_card",
      "status": "active",
      "field_values": [
        {
          "value": {
            "referenceId": "ref_charizard"
          },
          "fieldId": "fld_character"
        }
      ],
      "category_ids": [
        "cat_child"
      ],
      "tags": [
        "fire",
        "holo"
      ],
      "image_urls": [
        "https://assets.example/item_1/front.jpg"
      ],
      "product_asset_sets": [
        {
          "variants": [
            {
              "role": "catalog-detail",
              "width": 960,
              "height": 1344,
              "publicUrl": "https://assets.example/item_1/detail.webp"
            }
          ]
        }
      ],
      "image_fallback": null,
      "updated_at": "2026-06-12T12:31:00.000Z"
    }
  ],
  "itemDetailBlueprints": [
    {
      "blueprint_id": "bp_card",
      "name": "Pokemon Card",
      "dimension_rules": [
        {
          "required": true,
          "appliesWhen": [],
          "dimensionId": "dim_condition",
          "allowedOptionIds": [
            "opt_nm"
          ]
        }
      ],
      "canonical_dimension_order": [
        "dim_condition"
      ],
      "updated_at": "2026-06-12T12:19:00.000Z"
    }
  ],
  "itemDetailCategories": [
    {
      "category_id": "cat_child",
      "slug": "featured-singles-cat-child-1xgxzwe",
      "name": "Featured Singles",
      "updated_at": "2026-06-12T12:03:00.000Z"
    },
    {
      "category_id": "cat_parent",
      "slug": "pokemon-cat-parent-1gy3ipk",
      "name": "Pokemon",
      "updated_at": "2026-06-12T12:01:00.000Z"
    }
  ],
  "itemDetailFields": [
    {
      "field_id": "fld_character",
      "name": "Character",
      "updated_at": "2026-06-12T12:21:00.000Z"
    }
  ],
  "itemDetailReferenceRecords": [
    {
      "reference_record_id": "ref_charizard",
      "type_key": "pokemon",
      "key": "charizard",
      "name": "Charizard",
      "attributes": {
        "number": "4/102"
      },
      "relationships": [],
      "status": "active",
      "updated_at": "2026-06-12T12:23:00.000Z"
    }
  ],
  "itemDetailDimensions": [
    {
      "dimension_id": "dim_condition",
      "name": "Condition",
      "value_kind": "ordered",
      "updated_at": "2026-06-12T12:14:00.000Z"
    }
  ],
  "itemDetailDimensionOptions": [
    {
      "option_id": "opt_nm",
      "dimension_id": "dim_condition",
      "code": "near_mint_plus",
      "label_i18n": {
        "values": {
          "en": "Near Mint+"
        },
        "defaultLocale": "en"
      },
      "label": "Near Mint+",
      "display_order": 0,
      "numeric_value": "9.5",
      "updated_at": "2026-06-12T12:17:00.000Z"
    }
  ],
  "itemDetailPages": [
    {
      "catalog_item_id": "item_1",
      "slug": "charizard-base-set-item-1-1i58wji",
      "language_code": "en",
      "title_i18n": {
        "values": {
          "en": "Charizard"
        },
        "defaultLocale": "en"
      },
      "title": "Charizard",
      "subtitle_i18n": {
        "values": {
          "en": "Base Set"
        },
        "defaultLocale": "en"
      },
      "subtitle": "Base Set",
      "display_badges": [],
      "description_i18n": {
        "values": {
          "en": "Revised description"
        },
        "defaultLocale": "en"
      },
      "description": "Revised description",
      "blueprint_id": "bp_card",
      "blueprint": {
        "name": "Pokemon Card",
        "blueprintId": "bp_card"
      },
      "status": "active",
      "field_values": [
        {
          "value": {
            "referenceId": "ref_charizard"
          },
          "fieldId": "fld_character",
          "fieldName": "Character",
          "reference": {
            "key": "charizard",
            "name": "Charizard",
            "status": "active",
            "typeKey": "pokemon",
            "attributes": {
              "number": "4/102"
            },
            "referenceId": "ref_charizard",
            "relationships": []
          }
        }
      ],
      "categories": [
        {
          "name": "Featured Singles",
          "slug": "featured-singles-cat-child-1xgxzwe",
          "categoryId": "cat_child"
        }
      ],
      "tags": [
        "fire",
        "holo"
      ],
      "image_urls": [
        "https://assets.example/item_1/front.jpg"
      ],
      "product_asset_sets": [
        {
          "variants": [
            {
              "role": "catalog-detail",
              "width": 960,
              "height": 1344,
              "publicUrl": "https://assets.example/item_1/detail.webp"
            }
          ]
        }
      ],
      "image_fallback": null,
      "product_schema": {
        "dimensions": [
          {
            "required": true,
            "valueKind": "ordered",
            "appliesWhen": [],
            "dimensionId": "dim_condition",
            "dimensionName": "Condition",
            "allowedOptions": [
              {
                "code": "near_mint_plus",
                "label": "Near Mint+",
                "optionId": "opt_nm",
                "label_i18n": {
                  "values": {
                    "en": "Near Mint+"
                  },
                  "defaultLocale": "en"
                },
                "displayOrder": 0,
                "numericValue": 9.5
              }
            ]
          }
        ],
        "canonicalDimensionOrder": [
          {
            "dimensionId": "dim_condition",
            "dimensionName": "Condition"
          }
        ]
      },
      "updated_at": "2026-06-12T12:31:00.000Z"
    }
  ],
  "marketAccounts": [
    {
      "account_id": "acc_seller",
      "seller_slug": "seller-uno-acc-seller-1g1h3n4",
      "seller_display_name": "Seller Uno",
      "status": "active",
      "updated_at": "2026-06-12T13:04:00.000Z",
      "seller_listing_availability_status": "available",
      "seller_listing_availability_reason_category": null,
      "seller_listing_available_again_on": null,
      "seller_available_again_at": null,
      "seller_at_capacity": false,
      "seller_at_capacity_changed_at": null,
      "average_rating_as_seller": null,
      "review_count_as_seller": 0,
      "rating_1_count_as_seller": 0,
      "rating_2_count_as_seller": 0,
      "rating_3_count_as_seller": 0,
      "rating_4_count_as_seller": 0,
      "rating_5_count_as_seller": 0,
      "average_rating_as_buyer": null,
      "review_count_as_buyer": 0,
      "rating_1_count_as_buyer": 0,
      "rating_2_count_as_buyer": 0,
      "rating_3_count_as_buyer": 0,
      "rating_4_count_as_buyer": 0,
      "rating_5_count_as_buyer": 0,
      "reputation_updated_at": "2026-06-12T13:04:00.000Z",
      "created_at": "2026-06-12T12:36:00.000Z",
      "badges": [],
      "founder_number": null
    }
  ],
  "marketListings": [
    {
      "listing_id": "listing_1",
      "listing_slug": "charizard-base-set-near-mint-charizard-listing-1-1b58ckj",
      "product_slug": "charizard-base-set-near-mint-charizard-product-1-h4keug",
      "account_id": "acc_seller",
      "inventory_item_id": "inv_1",
      "catalog_catalog_item_id": "item_1",
      "product_id": "product_1",
      "item_title": "Charizard",
      "item_subtitle": "Base Set",
      "selected_options": [
        {
          "optionId": "opt_nm",
          "dimensionId": "dim_condition"
        }
      ],
      "product_summary": "Near Mint Charizard",
      "storage_location_name": "Vault A",
      "ship_from_code": "US",
      "price_amount": "145.00",
      "shipping_allowance_percentage_bps": 650,
      "quantity_cap": 2,
      "max_units_per_order": 2,
      "max_units_per_day": 4,
      "max_units_per_customer_account": 6,
      "status": "active",
      "active_held_quantity": null,
      "graded_card": null,
      "product_measure_snapshot": null,
      "supply_total_quantity": null,
      "created_at": "2026-06-12T12:42:00.000Z",
      "updated_at": "2026-06-12T12:47:00.000Z"
    }
  ],
  "offerDemandMatches": [
    {
      "offer_id": "offer_1",
      "buyer_account_id": "buyer_1",
      "catalog_catalog_item_id": "item_1",
      "product_id": "product_1",
      "item_title": "Charizard",
      "item_subtitle": "Base Set",
      "selected_options": [
        {
          "optionId": "opt_nm",
          "dimensionId": "dim_condition"
        }
      ],
      "product_summary": "Near Mint Charizard",
      "price_amount": "130.00",
      "quantity_requested": 1,
      "status": "accepted",
      "accepted_seller_account_id": "acc_seller",
      "accepted_at": "2026-06-12T13:01:00.000Z",
      "created_at": "2026-06-12T12:48:00.000Z",
      "updated_at": "2026-06-12T13:01:00.000Z"
    }
  ],
  "marketAccountReviews": [
    {
      "review_id": "review_1",
      "author_account_id": "buyer_1",
      "subject_account_id": "acc_seller",
      "author_role": "buyer",
      "rating": 4,
      "feedback": "Packed well after update.",
      "status": "withdrawn",
      "submitted_at": "2026-06-12T13:02:00.000Z",
      "updated_at": "2026-06-12T13:04:00.000Z",
      "revealed_at": null,
      "feedback_redacted_at": null,
      "reply_id": null,
      "reply_feedback": null,
      "reply_status": null,
      "reply_submitted_at": null,
      "reply_withdrawn_at": null
    }
  ]
}`),
    );
  });

  // m87 badge facts, m108 #4271: discovery's own local mirror of Identity's
  // badge-assigned/-removed events, the same add/remove-one-value-from-a-jsonb-array
  // idiom marketplace's marketplace_account_pages.badges already uses.
  it("mirrors account badge-assigned and badge-removed events into a deduplicated jsonb array", async () => {
    const marketHandlers = buildDiscoveryMarketProjectionHandlers(pool);

    await project(
      marketHandlers,
      event("identity.account.created", "identity.account-acc_badged", {
        accountId: "acc_badged",
        displayName: "Badged Seller",
      }),
    );

    const beforeBadges = await pool.query<{ badges: unknown }>(
      `SELECT badges FROM discovery_market_accounts WHERE account_id = $1`,
      ["acc_badged"],
    );
    expect(beforeBadges.rows[0]?.badges).toEqual([]);

    await project(
      marketHandlers,
      event("identity.account.badge-assigned", "identity.account-acc_badged", { badgeKey: "trusted-seller" }),
    );
    // Re-assigning the same badge (e.g. a replayed or redelivered event) must
    // not duplicate the array entry.
    await project(
      marketHandlers,
      event("identity.account.badge-assigned", "identity.account-acc_badged", { badgeKey: "trusted-seller" }),
    );

    const afterAssign = await pool.query<{ badges: unknown }>(
      `SELECT badges FROM discovery_market_accounts WHERE account_id = $1`,
      ["acc_badged"],
    );
    expect(afterAssign.rows[0]?.badges).toEqual(["trusted-seller"]);

    await project(
      marketHandlers,
      event("identity.account.badge-removed", "identity.account-acc_badged", { badgeKey: "trusted-seller" }),
    );

    const afterRemove = await pool.query<{ badges: unknown }>(
      `SELECT badges FROM discovery_market_accounts WHERE account_id = $1`,
      ["acc_badged"],
    );
    expect(afterRemove.rows[0]?.badges).toEqual([]);
  });
});

function requireDatabaseBaseUrl(): string {
  if (!databaseBaseUrl) {
    throw new Error("TEST_DATABASE_URL is required for discovery projection row identity tests.");
  }

  return databaseBaseUrl;
}

let nextGlobalPosition = 0;

function event(type: string, streamId: string, data: TransportEvent["data"]): TransportEvent {
  nextGlobalPosition += 1;
  const recordedAt = new Date(Date.UTC(2026, 5, 12, 12, nextGlobalPosition, 0)).toISOString();

  return buildTransportEvent(type, data, {
    id: `evt_${nextGlobalPosition}`,
    streamId,
    streamVersion: nextGlobalPosition,
    globalPosition: String(nextGlobalPosition),
    tenantId: "tnt_test",
    audit: { performedByUserId: "usr_actor", forAccountId: "acc_actor" },
    timing: { occurredAt: recordedAt, recordedAt },
  });
}

async function projectAll(handlers: readonly ProjectorHandlerMap[], projectedEvent: TransportEvent): Promise<void> {
  for (const handlerMap of handlers) {
    await projectIfPresent(handlerMap, projectedEvent);
  }
}

async function project(handlers: ProjectorHandlerMap, projectedEvent: TransportEvent): Promise<void> {
  const handler = handlers[projectedEvent.type];
  if (!handler) {
    throw new Error(`Missing projection handler for ${projectedEvent.type}.`);
  }

  await handler(projectedEvent);
}

async function projectIfPresent(handlers: ProjectorHandlerMap, projectedEvent: TransportEvent): Promise<void> {
  const handler = handlers[projectedEvent.type];
  if (handler) {
    await handler(projectedEvent);
  }
}

function text(value: string) {
  return { defaultLocale: "en", values: { en: value } };
}

async function readDiscoveryProjectionSnapshot(pool: PgTransactionalPool) {
  const [
    productAlertPages,
    categorySources,
    categoryItemSources,
    categories,
    searchCatalogItems,
    searchBlueprints,
    searchBlueprintDimensions,
    searchFields,
    searchReferenceRecords,
    searchDimensions,
    searchDimensionOptions,
    searchItems,
    itemDetailCatalogItems,
    itemDetailBlueprints,
    itemDetailCategories,
    itemDetailFields,
    itemDetailReferenceRecords,
    itemDetailDimensions,
    itemDetailDimensionOptions,
    itemDetailPages,
    marketAccounts,
    marketListings,
    offerDemandMatches,
    marketAccountReviews,
  ] = await Promise.all([
    pool.query(`SELECT * FROM discovery_product_alert_pages ORDER BY alert_id`),
    pool.query(`SELECT * FROM discovery_category_catalog_categories ORDER BY category_id`),
    pool.query(`SELECT * FROM discovery_category_catalog_items ORDER BY catalog_item_id`),
    pool.query(`SELECT * FROM discovery_categories ORDER BY category_id`),
    pool.query(`SELECT * FROM discovery_search_catalog_items ORDER BY catalog_item_id`),
    pool.query(`SELECT * FROM discovery_search_catalog_blueprints ORDER BY blueprint_id`),
    pool.query(`SELECT * FROM discovery_search_catalog_blueprint_dimensions ORDER BY blueprint_id, dimension_id`),
    pool.query(`SELECT * FROM discovery_search_catalog_fields ORDER BY field_id`),
    pool.query(`SELECT * FROM discovery_search_catalog_reference_records ORDER BY reference_record_id`),
    pool.query(`SELECT * FROM discovery_search_catalog_dimensions ORDER BY dimension_id`),
    pool.query(`SELECT * FROM discovery_search_catalog_dimension_options ORDER BY option_id`),
    pool.query(
      `SELECT
         catalog_item_id,
         slug,
         language_code,
         title_i18n,
         title,
         subtitle_i18n,
         subtitle,
         display_badges,
         description_i18n,
         description,
         blueprint_id,
         blueprint_name,
         status,
         category_names,
         category_slugs,
         tags,
         field_values_text,
         field_filter_values,
         reference_filter_values,
         dimension_filter_values,
         image_urls,
         product_asset_sets,
         image_fallback,
         updated_at
       FROM discovery_search_items
       ORDER BY catalog_item_id`,
    ),
    pool.query(`SELECT * FROM discovery_item_detail_catalog_items ORDER BY catalog_item_id`),
    pool.query(`SELECT * FROM discovery_item_detail_catalog_blueprints ORDER BY blueprint_id`),
    pool.query(`SELECT * FROM discovery_item_detail_catalog_categories ORDER BY category_id`),
    pool.query(`SELECT * FROM discovery_item_detail_catalog_fields ORDER BY field_id`),
    pool.query(`SELECT * FROM discovery_item_detail_catalog_reference_records ORDER BY reference_record_id`),
    pool.query(`SELECT * FROM discovery_item_detail_catalog_dimensions ORDER BY dimension_id`),
    pool.query(`SELECT * FROM discovery_item_detail_catalog_dimension_options ORDER BY option_id`),
    pool.query(`SELECT * FROM discovery_item_detail_pages ORDER BY catalog_item_id`),
    pool.query(`SELECT * FROM discovery_market_accounts ORDER BY account_id`),
    pool.query(`SELECT * FROM discovery_market_listings ORDER BY listing_id`),
    pool.query(`SELECT * FROM discovery_offer_demand_matches ORDER BY offer_id`),
    pool.query(`SELECT * FROM discovery_market_account_reviews ORDER BY review_id`),
  ]);

  return normalizeRows({
    productAlertPages: productAlertPages.rows,
    categorySources: categorySources.rows,
    categoryItemSources: categoryItemSources.rows,
    categories: categories.rows,
    searchCatalogItems: searchCatalogItems.rows,
    searchBlueprints: searchBlueprints.rows,
    searchBlueprintDimensions: searchBlueprintDimensions.rows,
    searchFields: searchFields.rows,
    searchReferenceRecords: searchReferenceRecords.rows,
    searchDimensions: searchDimensions.rows,
    searchDimensionOptions: searchDimensionOptions.rows,
    searchItems: searchItems.rows,
    itemDetailCatalogItems: itemDetailCatalogItems.rows,
    itemDetailBlueprints: itemDetailBlueprints.rows,
    itemDetailCategories: itemDetailCategories.rows,
    itemDetailFields: itemDetailFields.rows,
    itemDetailReferenceRecords: itemDetailReferenceRecords.rows,
    itemDetailDimensions: itemDetailDimensions.rows,
    itemDetailDimensionOptions: itemDetailDimensionOptions.rows,
    itemDetailPages: itemDetailPages.rows,
    marketAccounts: marketAccounts.rows,
    marketListings: marketListings.rows,
    offerDemandMatches: offerDemandMatches.rows,
    marketAccountReviews: marketAccountReviews.rows,
  });
}

function normalizeRows<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
