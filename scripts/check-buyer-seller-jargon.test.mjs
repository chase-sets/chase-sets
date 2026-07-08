import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findBuyerSellerJargonViolations } from "./check-buyer-seller-jargon.mjs";

const tempRoots = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("buyer/seller jargon check", () => {
  it("flags issue #4422 buyer and seller copy leaks in localization files", () => {
    const rootDir = makeTempRoot({
      "contracts/localization/locales/en/checkout.ts": `
export const checkoutEnglishTranslations = {
  "checkout.copy.offer": "Place purchase intent",
  "checkout.copy.sale": "This sale review is on hold.",
  "checkout.copy.cart": "Your cart intent is saved.",
} as const;
`,
    });

    const violations = findBuyerSellerJargonViolations({
      rootDir,
      files: ["contracts/localization/locales/en/checkout.ts"],
    });

    expect(violations).toEqual([
      expect.stringContaining("purchase-intent copy"),
      expect.stringContaining("cart-intent copy"),
      expect.stringContaining("on-hold sale review copy"),
    ]);
  });

  it("flags public anonymous rail rate-limit codes outside localization", () => {
    const rootDir = makeTempRoot({
      "bounded-contexts/checkout/features/cart/api/route.ts": `
export const error = { code: "anonymous_rail_rate_limited" };
`,
    });

    const violations = findBuyerSellerJargonViolations({
      rootDir,
      files: ["bounded-contexts/checkout/features/cart/api/route.ts"],
    });

    expect(violations).toEqual([expect.stringContaining("anonymous rail rate-limit code")]);
  });

  it("allows customer-safe offer and support-review language", () => {
    const rootDir = makeTempRoot({
      "contracts/localization/locales/en/checkout.ts": `
export const checkoutEnglishTranslations = {
  "checkout.copy.offer": "Submit offer",
  "checkout.copy.sale": "This sale review needs support review.",
  "checkout.copy.cart": "Your Buy Cart is saved.",
} as const;
`,
    });

    expect(
      findBuyerSellerJargonViolations({
        rootDir,
        files: ["contracts/localization/locales/en/checkout.ts"],
      }),
    ).toEqual([]);
  });
});

function makeTempRoot(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "buyer-seller-jargon-"));
  tempRoots.push(root);

  for (const [relativeFile, content] of Object.entries(files)) {
    const absoluteFile = path.join(root, relativeFile);
    fs.mkdirSync(path.dirname(absoluteFile), { recursive: true });
    fs.writeFileSync(absoluteFile, content.trimStart(), "utf8");
  }

  return root;
}
