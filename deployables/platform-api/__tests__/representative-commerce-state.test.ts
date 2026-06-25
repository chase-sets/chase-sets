import { describe, expect, it } from "vitest";
import {
  assertRepresentativeCommerceStateRunAllowed,
  selectChromeUatRepresentativePersona,
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
    expect(selection.nextOperatorAction).toBe("complete-private-payout-setup-or-refresh-representative-state");
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

function personaAliasForAccount(accountId: string): string {
  if (accountId.includes("card_vault")) {
    return "card-vault";
  }
  if (accountId.includes("sealed_stockroom")) {
    return "sealed-stockroom";
  }

  return "unknown";
}
