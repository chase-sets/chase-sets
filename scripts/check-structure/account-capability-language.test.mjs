import { describe, expect, it } from "vitest";
import {
  findAccountCapabilityLanguageViolations,
  isAccountCapabilityLanguageGuardedFile,
} from "./account-capability-language.mjs";

function labelsFor(relativeFile, content) {
  return findAccountCapabilityLanguageViolations({ relativeFile, content }).map((guard) => guard.label);
}

describe("account capability language guard", () => {
  it("guards bounded contexts, contracts, deployables, docs, and packages", () => {
    expect(isAccountCapabilityLanguageGuardedFile("bounded-contexts/identity/README.md", ".md")).toBe(true);
    expect(isAccountCapabilityLanguageGuardedFile("contracts/localization/locales/en.ts", ".ts")).toBe(true);
    expect(isAccountCapabilityLanguageGuardedFile("deployables/marketplace/app/routes.ts", ".ts")).toBe(true);
    expect(isAccountCapabilityLanguageGuardedFile("docs/GLOSSARY.md", ".md")).toBe(true);
    expect(
      isAccountCapabilityLanguageGuardedFile("packages/design-system/src/components/ui/marketplace.tsx", ".tsx"),
    ).toBe(true);
    expect(isAccountCapabilityLanguageGuardedFile("scripts/check-structure/run.mjs", ".mjs")).toBe(false);
  });

  it("rejects buyer and seller account capability surfaces", () => {
    expect(labelsFor("bounded-contexts/marketplace/routes/buyer/cart.ts", "")).toContain("/buyer route namespace");
    expect(labelsFor("deployables/marketplace/app/routes/account-buyer-offers.test.tsx", "")).toContain(
      "account-buyer-offers route test",
    );
    expect(labelsFor("bounded-contexts/marketplace/client.ts", "client.seller.listings()")).toContain("client.seller");
    expect(labelsFor("bounded-contexts/identity/README.md", "seller account type")).toContain(
      "seller account capability classification",
    );
    expect(labelsFor("bounded-contexts/discovery/context.json", "discovery_buyer_offer_matches")).toContain(
      "discovery_buyer_offer_matches",
    );
    expect(
      labelsFor("packages/design-system/src/components/ui/marketplace.tsx", "export function SellerProfileHeader() {}"),
    ).toContain("seller profile primitive");
    expect(
      labelsFor("packages/design-system/src/components/ui/marketplace.tsx", "export function VerifiedSellerBadge() {}"),
    ).toContain("verified seller badge primitive");
    expect(
      labelsFor(
        "packages/design-system/src/components/ui/marketplace.tsx",
        "export function BuyerProtectionModule() {}",
      ),
    ).toContain("buyer protection module primitive");
    expect(
      labelsFor(
        "packages/design-system/src/components/ui/marketplace.tsx",
        "export function SellerQualityIndicator() {}",
      ),
    ).toContain("seller quality indicator primitive");
    expect(labelsFor("bounded-contexts/insights/context.json", "seller-performance-kpi")).toContain(
      "seller-performance-kpi",
    );
    expect(labelsFor("bounded-contexts/public-presence/context.json", "buyer-protection")).toContain(
      "buyer-protection route or module",
    );
  });

  it("allows buyer and seller when they identify transaction endpoints", () => {
    const transactionLanguage = `
      An Order is between a buyer account and a seller account.
      buyerAccountId and sellerAccountId are durable event payload fields.
      A Shipment moves products from the seller account to the buyer account.
      Order Protection and Seller net are transaction-facing labels.
    `;

    expect(labelsFor("bounded-contexts/ordering/GLOSSARY.md", transactionLanguage)).toEqual([]);
  });
});
