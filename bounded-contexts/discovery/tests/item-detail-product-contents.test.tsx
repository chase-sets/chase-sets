// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { buildTransportEvent } from "@chase-sets/event-core/test-support";
import { cleanup, screen } from "@testing-library/react";
import type { TransportEvent } from "@chase-sets/event-core/transport";
import type { PgQueryable, PgQueryResult } from "@chase-sets/event-core-postgres";
import { buildDiscoveryItemDetailProjectionHandlers } from "../features/item-detail/read-model/projection";
import { getDiscoveryItemDetail } from "../features/item-detail/read-model/queries";
import { ItemDetailPage } from "../features/item-detail/ui/item-detail-page";
import { createItem, renderWithDataRouter } from "./item-detail-commerce-panel-test-harness";

type ProductContentRow = Readonly<{
  line_id: string;
  container_catalog_item_id: string;
  container_selected_options: unknown;
  container_product_id: string | null;
  contained_catalog_item_id: string | null;
  contained_selected_options: unknown;
  contained_product_id: string | null;
  quantity: number | null;
  content_type_id: string;
  content_type_display_name: unknown;
  inclusion_policy_id: string | null;
  inclusion_policy_display_name: unknown;
  provenance: unknown;
  resolution_status: "resolved" | "unresolved";
  target_lifecycle_status: string | null;
  resolved_fact_hash: string;
  resolver_version: number;
  resolved_at: string;
  updated_at: string;
}>;

type PageRow = Readonly<{
  catalog_item_id: string;
  slug: string;
  language_code: string;
  title_i18n: unknown;
  title: string;
  subtitle_i18n: unknown;
  subtitle: string | null;
  description_i18n: unknown;
  description: string;
  blueprint_id: string | null;
  blueprint: unknown;
  status: string;
  field_values: unknown;
  categories: unknown;
  tags: unknown;
  image_urls: unknown;
  product_asset_sets: unknown;
  image_fallback: unknown;
  product_schema: unknown;
  updated_at: string;
}>;

const includedItemLabel = { defaultLocale: "en", values: { en: "Included item" } };
const guaranteedLabel = { defaultLocale: "en", values: { en: "Guaranteed" } };

afterEach(() => {
  cleanup();
});

describe("item detail Product Contents", () => {
  it("projects Product Contents updates and retractions from the Catalog resolved fact", async () => {
    const db = new ProductContentsProjectionDb();
    const handlers = buildDiscoveryItemDetailProjectionHandlers(db);

    await handlers["catalog.product-contents.resolved"]?.(
      productContentsResolvedEvent({
        lines: [
          {
            lineId: "pcl_1",
            containerCatalogItemId: "cat_box",
            containerSelectedOptions: null,
            containerProductId: null,
            containedCatalogItemId: "cat_card",
            containedSelectedOptions: [{ dimensionId: "finish", optionId: "foil" }],
            containedProductId: "cat_card::finish:foil",
            quantity: 1,
            contentTypeId: "pct_included_item",
            contentTypeDisplayName: includedItemLabel,
            inclusionPolicyId: "pcp_guaranteed",
            inclusionPolicyDisplayName: guaranteedLabel,
            provenance: { source: "manual" },
            resolutionStatus: "resolved",
            targetLifecycleStatus: "active",
          },
        ],
      }),
    );

    expect(db.rows.get("pcl_1")).toMatchObject({
      container_catalog_item_id: "cat_box",
      contained_catalog_item_id: "cat_card",
      content_type_display_name: includedItemLabel,
      inclusion_policy_display_name: guaranteedLabel,
    });

    await handlers["catalog.product-contents.resolved"]?.(productContentsResolvedEvent({ lines: [] }));

    expect(db.rows.size).toBe(0);
  });

  it("hydrates forward Contents and reverse Included in lines for the item detail API", async () => {
    const db = new ProductContentsQueryDb({
      pages: [
        pageRow({ catalog_item_id: "cat_box", slug: "sealed-box-cat-box", title: "Sealed Box" }),
        pageRow({
          catalog_item_id: "cat_card",
          slug: "foil-card-cat-card",
          title: "Foil Card",
          image_urls: ["/images/foil-card.webp"],
        }),
      ],
      contents: [
        contentRow({
          line_id: "pcl_1",
          container_catalog_item_id: "cat_box",
          contained_catalog_item_id: "cat_card",
          contained_selected_options: [{ dimensionId: "finish", optionId: "foil" }],
          contained_product_id: "cat_card::finish:foil",
          quantity: 1,
        }),
      ],
    });

    const container = await getDiscoveryItemDetail(db, "cat_box");
    const contained = await getDiscoveryItemDetail(db, "cat_card");

    expect(container?.contents[0]).toMatchObject({
      content_type_label: "Included item",
      inclusion_policy_label: "Guaranteed",
      contained_item: {
        title: "Foil Card",
        slug: "foil-card-cat-card",
        image_urls: ["/images/foil-card.webp"],
      },
    });
    expect(contained?.included_in[0]).toMatchObject({
      container_item: { title: "Sealed Box", slug: "sealed-box-cat-box" },
      contained_product_id: "cat_card::finish:foil",
    });
  });

  it("renders active Product Contents links and archived targets without breaking the page", () => {
    renderWithDataRouter(
      <ItemDetailPage
        data={createItem({
          contents: [
            contentLine({
              contained_item: {
                catalog_item_id: "cat_pack",
                slug: "bonus-pack-cat-pack",
                title: "Bonus Pack",
                subtitle: "First wave",
                status: "active",
                image_urls: ["/images/bonus-pack.webp"],
                product_asset_sets: [],
                image_fallback: null,
              },
              contained_selected_options: [{ dimensionId: "language", optionId: "en" }],
              quantity: 2,
            }),
            contentLine({
              line_id: "pcl_archived",
              contained_catalog_item_id: "cat_archived",
              contained_item: {
                catalog_item_id: "cat_archived",
                slug: "retired-insert-cat-archived",
                title: "Retired Insert",
                subtitle: null,
                status: "archived",
                image_urls: [],
                product_asset_sets: [],
                image_fallback: null,
              },
              quantity: null,
              target_lifecycle_status: "archived",
            }),
          ],
          included_in: [
            contentLine({
              line_id: "pcl_parent",
              container_catalog_item_id: "cat_box",
              container_item: {
                catalog_item_id: "cat_box",
                slug: "starter-box-cat-box",
                title: "Starter Box",
                subtitle: null,
                status: "active",
                image_urls: [],
                product_asset_sets: [],
                image_fallback: null,
              },
            }),
          ],
        })}
      />,
    );

    expect(screen.getByText("Contents")).toBeTruthy();
    expect(screen.getByText("Included in")).toBeTruthy();
    expect(screen.getByRole("img", { name: "Bonus Pack — First wave" }).getAttribute("src")).toBe(
      "/images/bonus-pack.webp",
    );
    expect(screen.getByRole("link", { name: "View details for Bonus Pack — First wave" }).getAttribute("href")).toBe(
      "/items/bonus-pack-cat-pack?dimension.language=en",
    );
    expect(document.querySelectorAll('[data-card-layout="search-result"]')).toHaveLength(3);
    expect(screen.getByText("Qty 2 / Guaranteed")).toBeTruthy();
    expect(screen.getByText("Retired Insert")).toBeTruthy();
    expect(screen.getByText("Quantity varies / Guaranteed")).toBeTruthy();
    expect(screen.getByRole("link", { name: "View details for Starter Box" }).getAttribute("href")).toBe(
      "/items/starter-box-cat-box",
    );
  });

  it("leaves item pages without Product Contents unchanged", () => {
    renderWithDataRouter(<ItemDetailPage data={createItem({ contents: [], included_in: [] })} />);

    expect(screen.queryByText("Contents")).toBeNull();
    expect(screen.queryByText("Included in")).toBeNull();
  });
});

class ProductContentsProjectionDb implements PgQueryable {
  public readonly rows = new Map<string, ProductContentRow>();

  async query<Row = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<PgQueryResult<Row>> {
    if (sql.includes("DELETE FROM discovery_item_detail_product_contents")) {
      for (const [lineId, row] of [...this.rows.entries()]) {
        if (row.container_catalog_item_id === params[0] && row.container_product_id === (params[1] ?? null)) {
          this.rows.delete(lineId);
        }
      }
      return { rows: [] as Row[], rowCount: 0 };
    }

    if (sql.includes("INSERT INTO discovery_item_detail_product_contents")) {
      const row = contentRow({
        line_id: String(params[0]),
        container_catalog_item_id: String(params[1]),
        container_selected_options: parseJson(params[2]),
        container_product_id: stringOrNull(params[3]),
        contained_catalog_item_id: stringOrNull(params[4]),
        contained_selected_options: parseJson(params[5]),
        contained_product_id: stringOrNull(params[6]),
        quantity: typeof params[7] === "number" ? Number(params[7]) : null,
        content_type_id: String(params[8]),
        content_type_display_name: parseJson(params[9]),
        inclusion_policy_id: stringOrNull(params[10]),
        inclusion_policy_display_name: parseJson(params[11]),
        provenance: parseJson(params[12]) ?? {},
        resolution_status: params[13] === "unresolved" ? "unresolved" : "resolved",
        target_lifecycle_status: stringOrNull(params[14]),
        resolved_fact_hash: String(params[15]),
        resolver_version: Number(params[16]),
        resolved_at: String(params[17]),
        updated_at: String(params[18]),
      });
      this.rows.set(row.line_id, row);
      return { rows: [] as Row[], rowCount: 1 };
    }

    throw new Error(`Unexpected query: ${sql}`);
  }
}

class ProductContentsQueryDb implements PgQueryable {
  public constructor(
    private readonly data: Readonly<{
      pages: readonly PageRow[];
      contents: readonly ProductContentRow[];
    }>,
  ) {}

  async query<Row = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<PgQueryResult<Row>> {
    if (sql.includes("FROM discovery_item_detail_pages AS page")) {
      const id = String(params[0]);
      const page = this.data.pages.find((row) => row.catalog_item_id === id || row.slug === id);
      return { rows: (page ? [page] : []) as Row[], rowCount: page ? 1 : 0 };
    }

    if (sql.includes("FROM discovery_market_listings")) {
      return { rows: [] as Row[], rowCount: 0 };
    }

    if (sql.includes("FROM discovery_offer_demand_matches")) {
      return { rows: [] as Row[], rowCount: 0 };
    }

    if (sql.includes("FROM discovery_item_detail_product_contents")) {
      const id = String(params[0]);
      const isReverse = sql.includes("line.contained_catalog_item_id = $1");
      const rows = this.data.contents
        .filter((row) => (isReverse ? row.contained_catalog_item_id === id : row.container_catalog_item_id === id))
        .map((row) => ({
          ...row,
          container_slug: this.data.pages.find((page) => page.catalog_item_id === row.container_catalog_item_id)?.slug,
          container_title: this.data.pages.find((page) => page.catalog_item_id === row.container_catalog_item_id)
            ?.title,
          container_subtitle: this.data.pages.find((page) => page.catalog_item_id === row.container_catalog_item_id)
            ?.subtitle,
          container_status: this.data.pages.find((page) => page.catalog_item_id === row.container_catalog_item_id)
            ?.status,
          container_image_urls: this.data.pages.find((page) => page.catalog_item_id === row.container_catalog_item_id)
            ?.image_urls,
          container_product_asset_sets: this.data.pages.find(
            (page) => page.catalog_item_id === row.container_catalog_item_id,
          )?.product_asset_sets,
          container_image_fallback: this.data.pages.find(
            (page) => page.catalog_item_id === row.container_catalog_item_id,
          )?.image_fallback,
          contained_slug: this.data.pages.find((page) => page.catalog_item_id === row.contained_catalog_item_id)?.slug,
          contained_title: this.data.pages.find((page) => page.catalog_item_id === row.contained_catalog_item_id)
            ?.title,
          contained_subtitle: this.data.pages.find((page) => page.catalog_item_id === row.contained_catalog_item_id)
            ?.subtitle,
          contained_status: this.data.pages.find((page) => page.catalog_item_id === row.contained_catalog_item_id)
            ?.status,
          contained_image_urls: this.data.pages.find((page) => page.catalog_item_id === row.contained_catalog_item_id)
            ?.image_urls,
          contained_product_asset_sets: this.data.pages.find(
            (page) => page.catalog_item_id === row.contained_catalog_item_id,
          )?.product_asset_sets,
          contained_image_fallback: this.data.pages.find(
            (page) => page.catalog_item_id === row.contained_catalog_item_id,
          )?.image_fallback,
        }));
      return { rows: rows as Row[], rowCount: rows.length };
    }

    return { rows: [] as Row[], rowCount: 0 };
  }
}

function productContentsResolvedEvent(
  overrides: Partial<{
    lines: TransportEvent["data"][];
  }>,
): TransportEvent {
  return buildTransportEvent(
    "catalog.product-contents.resolved",
    {
      containerCatalogItemId: "cat_box",
      containerSelectedOptions: null,
      containerProductId: null,
      lines: overrides.lines ?? [],
      resolvedFactHash: "hash_1",
      resolverVersion: 1,
      resolvedAt: "2026-07-01T00:00:00.000Z",
    },
    {
      id: "evt_contents",
      streamId: "catalog.product-contents-cat_box",
      streamVersion: 2,
      globalPosition: "2",
      tenantId: "tnt_test",
      audit: { performedByUserId: "usr_test", forAccountId: "acc_test" },
      timing: {
        occurredAt: "2026-07-01T00:00:00.000Z",
        recordedAt: "2026-07-01T00:00:00.000Z",
      },
    },
  );
}

function pageRow(overrides: Partial<PageRow>): PageRow {
  return {
    catalog_item_id: "cat_item",
    slug: "item-cat-item",
    language_code: "en",
    title_i18n: {},
    title: "Item",
    subtitle_i18n: {},
    subtitle: null,
    description_i18n: {},
    description: "",
    blueprint_id: null,
    blueprint: null,
    status: "active",
    field_values: [],
    categories: [],
    tags: [],
    image_urls: [],
    product_asset_sets: [],
    image_fallback: null,
    product_schema: null,
    updated_at: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

function contentRow(overrides: Partial<ProductContentRow>): ProductContentRow {
  return {
    line_id: "pcl_1",
    container_catalog_item_id: "cat_box",
    container_selected_options: null,
    container_product_id: null,
    contained_catalog_item_id: "cat_card",
    contained_selected_options: null,
    contained_product_id: null,
    quantity: 1,
    content_type_id: "pct_included_item",
    content_type_display_name: includedItemLabel,
    inclusion_policy_id: "pcp_guaranteed",
    inclusion_policy_display_name: guaranteedLabel,
    provenance: {},
    resolution_status: "resolved",
    target_lifecycle_status: "active",
    resolved_fact_hash: "hash_1",
    resolver_version: 1,
    resolved_at: "2026-07-01T00:00:00.000Z",
    updated_at: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

function contentLine(overrides: Partial<ReturnType<typeof createItem>["contents"][number]> = {}) {
  return {
    line_id: "pcl_1",
    container_catalog_item_id: "cat_charizard",
    container_selected_options: null,
    container_product_id: null,
    container_item: null,
    contained_catalog_item_id: "cat_pack",
    contained_selected_options: null,
    contained_product_id: null,
    contained_item: null,
    quantity: 1,
    content_type_id: "pct_included_item",
    content_type_label: "Included item",
    inclusion_policy_id: "pcp_guaranteed",
    inclusion_policy_label: "Guaranteed",
    resolution_status: "resolved" as const,
    target_lifecycle_status: "active",
    updated_at: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

function parseJson(value: unknown) {
  return typeof value === "string" ? JSON.parse(value) : value;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
