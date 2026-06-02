import { describe, expect, it } from "vitest";
import {
  getCatalogProviderIntegrationProfile,
  listCatalogProviderIntegrationProfiles,
  tcgplayerAutomationClientProviderProfile,
} from "./provider-integration-profiles";

describe("catalog provider integration profiles", () => {
  it("registers TCGplayer as a planned automation-client connector sourced from the automation app", () => {
    const profile = getCatalogProviderIntegrationProfile("TCGPLAYER");

    expect(profile).toBe(tcgplayerAutomationClientProviderProfile);
    expect(profile).toMatchObject({
      providerKey: "tcgplayer",
      status: "planned",
      connector: {
        kind: "tcgplayer-automation-client",
        sourceRepository: {
          owner: "todd-skelton",
          name: "tcgplayer-automation-app",
          commit: "bf42aa8",
        },
        authentication: {
          scheme: "tcgplayer-production-cookie",
          cookieName: "TCGAuthTicket_Production",
          userAgentRequired: true,
        },
        domains: {
          search: "mp-search-api.tcgplayer.com",
          marketplaceApi: "mpapi.tcgplayer.com",
          infiniteApi: "infinite-api.tcgplayer.com",
          marketplaceGateway: "mpgateway.tcgplayer.com",
        },
        retryStatusCodes: [403, 429, 502, 503, 504],
        throttling: {
          strategy: "domain-adaptive",
          controls: ["request-delay", "cooldown", "max-concurrency", "learned-min-delay"],
        },
        externalReferencePolicy: {
          catalogItemReferencePrefix: "product:",
          productReferencePrefix: "sku:",
          productConditionIdSource: "sku-product-condition-id",
        },
      },
    });
  });

  it("keeps TCGplayer pricing and seller workflow evidence outside Catalog truth", () => {
    const connector = tcgplayerAutomationClientProviderProfile.connector;

    expect(connector.kind).toBe("tcgplayer-automation-client");
    expect(connector.catalogBoundary.acceptedEvidence).toEqual([
      "product-id",
      "sku-id",
      "product-condition-id",
      "set-name",
      "product-line",
    ]);
    expect(connector.catalogBoundary.excludedEvidence).toEqual([
      "listing-price",
      "sales-history",
      "order",
      "message",
      "seller-inventory",
    ]);
    expect(tcgplayerAutomationClientProviderProfile.externalReferenceExtractionRules.rules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          providerKey: "tcgplayer",
          target: "catalog-item-reference",
          externalKeyPrefix: "product:",
        }),
        expect.objectContaining({
          providerKey: "tcgplayer",
          target: "product-reference",
          externalKeyPrefix: "sku:",
        }),
      ]),
    );
  });

  it("lists active and planned providers through the same provider catalog", () => {
    expect(listCatalogProviderIntegrationProfiles().map((profile) => [profile.providerKey, profile.status])).toEqual([
      ["tcgdex", "active"],
      ["tcgplayer", "planned"],
    ]);
  });
});
