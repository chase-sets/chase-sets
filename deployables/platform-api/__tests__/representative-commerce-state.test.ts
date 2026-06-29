import { describe, expect, it } from "vitest";
import {
  assertRepresentativeCommerceStateRunAllowed,
  selectChromeUatRepresentativePersona,
  selectPendingPaymentSaleRepresentativePersona,
} from "../src/representative-commerce-state";

describe("representative commerce state refresh guardrails", () => {
  it("allows confirmed staging runs", () => {
    expect(() =>
      assertRepresentativeCommerceStateRunAllowed({
        deploymentEnvironment: "staging",
        confirmation: "seed staging commerce",
      }),
    ).not.toThrow();
  });

  it("rejects production runs even when confirmed", () => {
    expect(() =>
      assertRepresentativeCommerceStateRunAllowed({
        deploymentEnvironment: "production",
        confirmation: "seed staging commerce",
      }),
    ).toThrow("representative-commerce-state cannot run when DEPLOYMENT_ENVIRONMENT=production.");
  });

  it("requires an explicit confirmation phrase", () => {
    expect(() =>
      assertRepresentativeCommerceStateRunAllowed({
        deploymentEnvironment: "staging",
        confirmation: "yes",
      }),
    ).toThrow("REPRESENTATIVE_COMMERCE_STATE_CONFIRM must exactly equal 'seed staging commerce'");
  });

  it("requires a local override outside dev, test, or staging", () => {
    expect(() =>
      assertRepresentativeCommerceStateRunAllowed({
        deploymentEnvironment: "remote-dev",
        confirmation: "seed staging commerce",
      }),
    ).toThrow(
      "representative-commerce-state requires DEPLOYMENT_ENVIRONMENT=staging, test/dev runtime, or REPRESENTATIVE_COMMERCE_STATE_ALLOW_LOCAL=true.",
    );

    expect(() =>
      assertRepresentativeCommerceStateRunAllowed({
        deploymentEnvironment: "remote-dev",
        confirmation: "seed staging commerce",
        localOverride: "true",
      }),
    ).not.toThrow();
  });
});

describe("representative pending-payment sale selector", () => {
  it("selects a magic-link-ready seller with pending-payment sales without requiring payout readiness", async () => {
    const selection = await selectPendingPaymentSaleRepresentativePersona(
      pendingPaymentSaleSelectorServices({
        aliasesWithPendingPaymentSales: new Map([
          [
            "card-vault",
            {
              pendingPaymentSaleCount: 2,
              pendingPaymentOfferAcceptanceSaleCount: 1,
            },
          ],
        ]),
      }),
    );

    expect(selection).toEqual({
      schemaVersion: "representative-commerce-state.pending-payment-sale-selector/v1",
      status: "ready",
      selectedPersonaAlias: "card-vault",
      checkedPersonaCount: 2,
      evidencePolicy: "support-safe",
      sellerSalesPath: "/account/sales",
      selectedSaleRouteTemplate: "/account/sales/:orderId",
      nextOperatorAction: "use-selected-private-login-open-sales-and-record-redacted-pending-payment-uat",
      personas: [
        {
          personaAlias: "card-vault",
          chromeLogin: "magic-link-ready",
          pendingPaymentSaleCount: 2,
          pendingPaymentOfferAcceptanceSaleCount: 1,
        },
        {
          personaAlias: "sealed-stockroom",
          chromeLogin: "magic-link-ready",
          pendingPaymentSaleCount: 0,
          pendingPaymentOfferAcceptanceSaleCount: 0,
        },
      ],
    });

    const serialized = JSON.stringify(selection);
    expect(serialized).not.toContain("acc_repr_");
    expect(serialized).not.toContain("usr_repr_");
    expect(serialized).not.toContain("ord_");
    expect(serialized).not.toContain("@");
  });

  it("keeps the pending-payment selector unavailable when login or sale state is missing", async () => {
    const selection = await selectPendingPaymentSaleRepresentativePersona(
      pendingPaymentSaleSelectorServices({
        aliasesWithPendingPaymentSales: new Map([
          [
            "card-vault",
            {
              pendingPaymentSaleCount: 1,
              pendingPaymentOfferAcceptanceSaleCount: 1,
            },
          ],
        ]),
        loginReadyAliases: new Set(["sealed-stockroom"]),
      }),
    );

    expect(selection).toMatchObject({
      status: "not-available",
      selectedPersonaAlias: null,
      selectedSaleRouteTemplate: null,
      nextOperatorAction: "refresh-representative-state-and-rerun-selector",
    });
    expect(selection.personas).toEqual([
      {
        personaAlias: "card-vault",
        chromeLogin: "not-ready",
        pendingPaymentSaleCount: 1,
        pendingPaymentOfferAcceptanceSaleCount: 1,
      },
      {
        personaAlias: "sealed-stockroom",
        chromeLogin: "magic-link-ready",
        pendingPaymentSaleCount: 0,
        pendingPaymentOfferAcceptanceSaleCount: 0,
      },
    ]);
  });
});

describe("representative Chrome UAT persona selector", () => {
  it("selects the first support-safe persona with Chrome login, payout readiness, inventory, and listings", async () => {
    const selection = await selectChromeUatRepresentativePersona(
      selectorServices({
        readyAliases: new Set(["card-vault"]),
      }),
    );

    expect(selection).toEqual({
      schemaVersion: "representative-commerce-state.chrome-uat-selector/v1",
      status: "ready",
      selectedPersonaAlias: "card-vault",
      recommendedOperatorActionPersonaAlias: "card-vault",
      checkedPersonaCount: 2,
      evidencePolicy: "support-safe",
      nextOperatorAction: "use-selected-private-login-and-record-redacted-uat",
      personas: [
        {
          personaAlias: "card-vault",
          chromeLogin: "magic-link-ready",
          payoutReadiness: "ready",
          listingState: "owned-mutable",
          activeListingCount: 2,
          mutableListingCount: 3,
          inventoryItemCount: 4,
          blockerCategories: [],
        },
        expect.objectContaining({
          personaAlias: "sealed-stockroom",
          payoutReadiness: "not-ready",
          blockerCategories: ["payout-not-ready"],
        }),
      ],
    });

    const serialized = JSON.stringify(selection);
    expect(serialized).not.toContain("acc_repr_");
    expect(serialized).not.toContain("usr_repr_");
    expect(serialized).not.toContain("lst_repr_");
    expect(serialized).not.toContain("inv_repr_");
    expect(serialized).not.toContain("acct_");
    expect(serialized).not.toContain("@");
  });

  it("reports the private operator action when no persona is payout-ready", async () => {
    const selection = await selectChromeUatRepresentativePersona(
      selectorServices({
        readyAliases: new Set(),
      }),
    );

    expect(selection.status).toBe("operator-action-required");
    expect(selection.selectedPersonaAlias).toBeNull();
    expect(selection.recommendedOperatorActionPersonaAlias).toBe("card-vault");
    expect(selection.nextOperatorAction).toBe("complete-private-payout-setup-for-recommended-persona");
    expect(selection.personas.map((persona) => persona.blockerCategories)).toEqual([
      ["payout-not-ready"],
      ["payout-not-ready"],
    ]);
  });

  it("identifies missing owned listing state without exposing the underlying ids", async () => {
    const selection = await selectChromeUatRepresentativePersona(
      selectorServices({
        readyAliases: new Set(["card-vault"]),
        aliasesWithListings: new Set(),
      }),
    );

    expect(selection.status).toBe("operator-action-required");
    expect(selection.personas[0]).toMatchObject({
      personaAlias: "card-vault",
      payoutReadiness: "ready",
      listingState: "missing",
      activeListingCount: 0,
      mutableListingCount: 0,
      blockerCategories: ["owned-active-listing-missing"],
    });
  });

  it("counts auto-managed Inventory stock referenced by representative listings", async () => {
    const inventoryQueries: [string, readonly unknown[] | undefined][] = [];
    const selection = await selectChromeUatRepresentativePersona({
      identityDb: {
        query: async <Row>() => ({
          rows: [{ account_ready: true, membership_ready: true, magic_link_ready: true }] as Row[],
        }),
      },
      settlementDb: {
        query: async <Row>() => ({
          rows: [
            {
              status: "ready",
              has_provider_reference: true,
              onboarding_status: "complete",
              payout_capability_status: "active",
              payout_destination_status: "ready",
            },
          ] as Row[],
        }),
      },
      marketplaceDb: {
        query: async <Row>() => ({
          rows: [
            {
              active_listing_count: "1",
              mutable_listing_count: "1",
              representative_inventory_item_ids: ["inv_listing_stock_representative"],
            },
          ] as Row[],
        }),
      },
      inventoryDb: {
        query: async <Row>(sql: string, params?: readonly unknown[]) => {
          inventoryQueries.push([sql, params]);

          return {
            rows: [
              {
                inventory_item_count:
                  Array.isArray(params?.[1]) && params[1].includes("inv_listing_stock_representative") ? "1" : "0",
              },
            ] as Row[],
          };
        },
      },
    });

    expect(selection.status).toBe("ready");
    expect(selection.personas[0]).toMatchObject({
      personaAlias: "card-vault",
      listingState: "owned-mutable",
      inventoryItemCount: 1,
      blockerCategories: [],
    });
    expect(String(inventoryQueries[0]?.[0])).toContain("item_id = ANY($2::text[])");
    expect(String(inventoryQueries[0]?.[0])).not.toContain("inv$_repr$_%");
  });
});

function selectorServices(
  options: Readonly<{
    readyAliases: ReadonlySet<string>;
    aliasesWithListings?: ReadonlySet<string>;
    aliasesWithInventory?: ReadonlySet<string>;
  }>,
): Parameters<typeof selectChromeUatRepresentativePersona>[0] {
  const aliasesWithListings = options.aliasesWithListings ?? new Set(["card-vault", "sealed-stockroom"]);
  const aliasesWithInventory = options.aliasesWithInventory ?? new Set(["card-vault", "sealed-stockroom"]);

  return {
    identityDb: {
      query: async <Row>() => ({
        rows: [{ account_ready: true, membership_ready: true, magic_link_ready: true }] as Row[],
      }),
    },
    settlementDb: {
      query: async <Row>(_sql: string, params?: readonly unknown[]) => {
        const alias = personaAliasForAccount(String(params?.[0] ?? ""));
        const ready = options.readyAliases.has(alias);

        return {
          rows: [
            {
              status: ready ? "ready" : "pending",
              has_provider_reference: ready,
              onboarding_status: ready ? "complete" : "pending",
              payout_capability_status: ready ? "active" : "pending",
              payout_destination_status: ready ? "ready" : "missing",
            },
          ] as Row[],
        };
      },
    },
    marketplaceDb: {
      query: async <Row>(_sql: string, params?: readonly unknown[]) => {
        const alias = personaAliasForAccount(String(params?.[0] ?? ""));
        const hasListings = aliasesWithListings.has(alias);

        return {
          rows: [
            {
              active_listing_count: hasListings ? "2" : "0",
              mutable_listing_count: hasListings ? "3" : "0",
              representative_inventory_item_ids: hasListings ? [`inv_listing_stock_${alias}`] : [],
            },
          ] as Row[],
        };
      },
    },
    inventoryDb: {
      query: async <Row>(_sql: string, params?: readonly unknown[]) => {
        const alias = personaAliasForAccount(String(params?.[0] ?? ""));

        return {
          rows: [{ inventory_item_count: aliasesWithInventory.has(alias) ? "4" : "0" }] as Row[],
        };
      },
    },
  };
}

function pendingPaymentSaleSelectorServices(
  options: Readonly<{
    aliasesWithPendingPaymentSales: ReadonlyMap<
      string,
      Readonly<{ pendingPaymentSaleCount: number; pendingPaymentOfferAcceptanceSaleCount: number }>
    >;
    loginReadyAliases?: ReadonlySet<string>;
  }>,
): Parameters<typeof selectPendingPaymentSaleRepresentativePersona>[0] {
  const loginReadyAliases = options.loginReadyAliases ?? new Set(["card-vault", "sealed-stockroom"]);

  return {
    identityDb: {
      query: async <Row>(_sql: string, params?: readonly unknown[]) => {
        const alias = personaAliasForUser(String(params?.[1] ?? ""));
        const ready = loginReadyAliases.has(alias);

        return {
          rows: [{ account_ready: ready, membership_ready: ready, magic_link_ready: ready }] as Row[],
        };
      },
    },
    orderingDb: {
      query: async <Row>(_sql: string, params?: readonly unknown[]) => {
        const alias = personaAliasForAccount(String(params?.[0] ?? ""));
        const sale = options.aliasesWithPendingPaymentSales.get(alias);

        return {
          rows: [
            {
              pending_payment_sale_count: sale?.pendingPaymentSaleCount ?? 0,
              pending_payment_offer_acceptance_sale_count: sale?.pendingPaymentOfferAcceptanceSaleCount ?? 0,
            },
          ] as Row[],
        };
      },
    },
  };
}

function personaAliasForAccount(accountId: string): string {
  if (accountId.includes("card_vault")) {
    return "card-vault";
  }
  if (accountId.includes("sealed_stockroom")) {
    return "sealed-stockroom";
  }

  return "unknown";
}

function personaAliasForUser(userId: string): string {
  if (userId.includes("card_vault")) {
    return "card-vault";
  }
  if (userId.includes("sealed_stockroom")) {
    return "sealed-stockroom";
  }

  return "unknown";
}
