import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validateGlossaryCoverage } from "./glossary-coverage.mjs";

const tempRoots = [];

function createTempRepo() {
  const root = mkdtempSync(path.join(tmpdir(), "cs-glossary-coverage-"));
  tempRoots.push(root);
  return root;
}

function writeSource(root, relativeFile, content) {
  const absolute = path.join(root, relativeFile);
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, `${content.trim().replace(/^ {6}/gm, "")}\n`, "utf8");
}

function contextManifests({ checkoutOwnedNouns = ["cart"], marketplaceGlossaryTerm = "Cart" } = {}) {
  return new Map([
    [
      "bounded-contexts/checkout",
      {
        root: "bounded-contexts/checkout",
        manifest: {
          contextName: "checkout",
          packageName: "@chase-sets/checkout",
          ownedNouns: checkoutOwnedNouns,
          eventSubscriptions: [
            {
              sourceContextName: "checkout",
              projectionName: "checkout-cart-projection",
              eventTypes: ["checkout.cart.created"],
            },
            {
              sourceContextName: "marketplace",
              projectionName: "checkout-listing-projection",
              eventTypes: ["marketplace.listing.created"],
            },
          ],
        },
        packageName: "@chase-sets/checkout",
      },
    ],
    [
      "bounded-contexts/marketplace",
      {
        root: "bounded-contexts/marketplace",
        manifest: {
          contextName: "marketplace",
          packageName: "@chase-sets/marketplace",
          ownedNouns: ["listing"],
        },
        packageName: "@chase-sets/marketplace",
        marketplaceGlossaryTerm,
      },
    ],
  ]);
}

function writeBaseline(root, allowlist = [], aliases = []) {
  writeSource(
    root,
    "scripts/check-structure/glossary-coverage-baseline.json",
    JSON.stringify(
      {
        issue: "#4419",
        owner: "bounded context owners",
        reviewBy: "2026-08-31",
        reason: "Test baseline.",
        aliases,
        allowlist,
      },
      null,
      2,
    ),
  );
}

function writeGlossaries(
  root,
  { checkoutCartBody = "A **Cart** is a saved purchase-intent surface.", marketplaceTerm = "Listing" } = {},
) {
  writeSource(
    root,
    "bounded-contexts/checkout/GLOSSARY.md",
    `
      # Checkout Glossary

      ## Cart

      ${checkoutCartBody}
    `,
  );
  writeSource(
    root,
    "bounded-contexts/marketplace/GLOSSARY.md",
    `
      # Marketplace Glossary

      ## ${marketplaceTerm}

      A **${marketplaceTerm}** is a seller-published ask before an order exists.
    `,
  );
  writeSource(
    root,
    "docs/GLOSSARY.md",
    `
      # Marketplace Glossary

      ## Cross-Context Disambiguation

      No overlapping test terms.
    `,
  );
}

function validate(root, options = {}) {
  return validateGlossaryCoverage({
    repoRoot: root,
    contextManifests: contextManifests(options),
  });
}

afterEach(() => {
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop(), { recursive: true, force: true });
  }
});

describe("glossary coverage guard", () => {
  it("accepts owned nouns and event nouns that resolve to glossary term headings", () => {
    const root = createTempRepo();
    writeBaseline(root);
    writeGlossaries(root);

    const result = validate(root);

    expect(result.violations).toEqual([]);
  });

  it("fails when an owned noun has no glossary term heading", () => {
    const root = createTempRepo();
    writeBaseline(root);
    writeGlossaries(root);

    const result = validate(root, { checkoutOwnedNouns: ["cart", "checkout-session"] });

    expect(result.violations).toContain(
      "bounded-contexts/checkout/context.json ownedNouns 'checkout-session' is not defined by a term heading in bounded-contexts/checkout/GLOSSARY.md",
    );
  });

  it("fails when an event noun has no source-context glossary term heading", () => {
    const root = createTempRepo();
    writeBaseline(root);
    writeGlossaries(root, { marketplaceTerm: "Offer" });

    const result = validate(root);

    expect(result.violations).toContain(
      "marketplace.listing event noun is referenced by checkout (marketplace.listing.created) but bounded-contexts/marketplace/GLOSSARY.md has no term heading for 'listing'; event noun segments must resolve to the source context glossary",
    );
  });

  it("requires cross-context heading collisions to be disambiguated in the master glossary", () => {
    const root = createTempRepo();
    writeBaseline(root);
    writeGlossaries(root, { marketplaceTerm: "Cart" });
    writeSource(
      root,
      "docs/GLOSSARY.md",
      `
        # Marketplace Glossary
      `,
    );

    const result = validate(root, { marketplaceGlossaryTerm: "Cart" });

    expect(result.violations).toContain(
      "Cart appears in multiple context glossaries (checkout, marketplace) but docs/GLOSSARY.md has no Cross-Context Disambiguation entry for it",
    );
  });

  it("requires matched glossary term headings to have definition bodies", () => {
    const root = createTempRepo();
    writeBaseline(root);
    writeGlossaries(root, { checkoutCartBody: "" });

    const result = validate(root);

    expect(result.violations).toContain(
      "bounded-contexts/checkout/GLOSSARY.md:3: glossary term heading 'Cart' must have a definition body",
    );
  });

  it("fails broken wiki-style glossary references", () => {
    const root = createTempRepo();
    writeBaseline(root);
    writeGlossaries(root, { checkoutCartBody: "A **Cart** can reference [[Missing Term]]." });

    const result = validate(root);

    expect(result.violations).toEqual(
      expect.arrayContaining([
        expect.stringContaining("glossary cross-reference [[Missing Term]] does not resolve to a known glossary term"),
      ]),
    );
  });

  it("allows seeded gaps but fails stale allowlist rows so the ratchet shrinks", () => {
    const root = createTempRepo();
    writeBaseline(root, [
      {
        id: "owned-noun:checkout:checkout-session",
        kind: "owned-noun",
        issue: "#4419",
        justification: "Fixture gap.",
      },
    ]);
    writeGlossaries(root);

    const gapResult = validate(root, { checkoutOwnedNouns: ["cart", "checkout-session"] });
    expect(gapResult.violations).toEqual([]);

    const staleResult = validate(root);
    expect(staleResult.violations).toContain(
      "scripts/check-structure/glossary-coverage-baseline.json: stale glossary coverage allowlist entry 'owned-noun:checkout:checkout-session' no longer matches a current gap; remove it as the ratchet shrinks",
    );
  });

  it("supports explicit alias entries for legitimate stream noun variants", () => {
    const root = createTempRepo();
    writeBaseline(
      root,
      [],
      [
        {
          contextName: "checkout",
          noun: "basket",
          terms: ["Cart"],
          reason: "Fixture alias.",
        },
      ],
    );
    writeGlossaries(root);

    const result = validate(root, { checkoutOwnedNouns: ["basket"] });

    expect(result.violations).toEqual([]);
  });
});
