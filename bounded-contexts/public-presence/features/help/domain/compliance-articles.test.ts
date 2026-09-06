import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  publicHelpArticlePolicyCitations,
  publicPolicyHrefsByKey,
  publicPolicyKeys,
  publicPolicyPublicationRecords,
} from "@chase-sets/public-docs";
import { describe, expect, it } from "vitest";
import { publicPresenceHasTranslation } from "../../waitlist/ui/public-presence-translator";
import { compileHelpArticleCorpus, compileHelpArticleSource } from "../integrations/compile-help-articles.mjs";
import {
  listHelpArticlesByCategory,
  listHelpCategoriesByAudience,
  publicHelpArticlePaths,
  publicHelpArticles,
} from "./article-catalog";
import {
  complianceLegalReviewArticleSlugs,
  complianceLegalReviewLocale,
  dmcaComplianceArticleSlug,
  dmcaUnverifiedRegistrationMarker,
  incorporatedHelpArticleSlugs,
} from "./compliance-legal-review-corpus";
import type { HelpArticle } from "./article-model";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../..");
const articlesDirectory = join(dirname(fileURLToPath(import.meta.url)), "articles");
const dmcaDirectoryUrl = "https://dmca.copyright.gov/osp/";
const unverifiedRegistrationToken = "registration-status-unverified";

const complianceArticles = [
  {
    slug: "community-guidelines-and-enforcement",
    audience: "buyer",
    category: "buying",
    bodySha256: "fde175eef4ac26a3d7d48163027e2d6ee6de6786b35e5cfe925ed8ca0a5cc450",
  },
  {
    slug: "intellectual-property-and-dmca",
    audience: "seller",
    category: "selling",
    bodySha256: "39d90002ac81cd7a5a8a45d5ca1ea9b47a617a0361c2c553e790fb044dabd40d",
  },
  {
    slug: "prohibited-and-restricted-items",
    audience: "seller",
    category: "selling",
    bodySha256: "96f232639db1f8bb961926953a9a709843e6f06c7c018286dc30d1b976de0a86",
  },
  {
    slug: "sales-tax",
    audience: "seller",
    category: "selling",
    bodySha256: "2f6962e43c3a4921d498ae9ce52ba6c880df9a236c4ea27892a297113931300e",
  },
  {
    slug: "tax-reporting-1099k",
    audience: "seller",
    category: "selling",
    bodySha256: "45170b5493e4ffe63e58ded0069f7f791e97d1ad0cd8d08964ef635702964b98",
  },
] as const;

/**
 * The independent test-only oracle for #5695's source-owned legal-review
 * manifest. This literal tuple is the exact reviewed membership and order, held
 * here and NEVER exported, so a deletion or reorder in
 * `compliance-legal-review-corpus.ts` is detectable by something that does not
 * read that module. The packet and the launch audit consume the manifest; they
 * never consume this list, so there is still exactly one production membership
 * source.
 */
const reviewedComplianceMembershipOracle = complianceArticles.map(({ slug }) => slug);

function assertManifestMatchesReviewedMembership(candidate: readonly string[]) {
  if (candidate.length !== reviewedComplianceMembershipOracle.length) {
    throw new Error(
      `legal-review manifest must carry exactly ${reviewedComplianceMembershipOracle.length} reviewed compliance members`,
    );
  }
  candidate.forEach((slug, index) => {
    if (slug !== reviewedComplianceMembershipOracle[index]) {
      throw new Error(`legal-review manifest member ${index} must be '${reviewedComplianceMembershipOracle[index]}'`);
    }
  });
}

function corpusSources() {
  return readdirSync(articlesDirectory)
    .filter((fileName) => fileName.endsWith(".md"))
    .sort()
    .map((fileName) => ({ fileName, source: readFileSync(join(articlesDirectory, fileName), "utf8") }));
}

function complianceSource(slug: string) {
  const fileName = `${slug}.en.md`;
  return { fileName, source: readFileSync(join(articlesDirectory, fileName), "utf8") };
}

function sourceBody(source: string) {
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n([\s\S]*)$/.exec(source);
  if (!match) throw new Error("article source must contain frontmatter and a body");
  return match[1].replace(/\r\n/g, "\n");
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function findArticle(slug: string, articles: readonly HelpArticle[] = publicHelpArticles) {
  const article = articles.find((candidate) => candidate.slug === slug && candidate.locale === "en");
  if (!article) throw new Error(`missing compliance article '${slug}'`);
  return article;
}

function articleText(article: HelpArticle) {
  return JSON.stringify(article.blocks);
}

function articleLinks(article: HelpArticle) {
  return article.blocks.flatMap((block) => {
    const groups = block.type === "list" ? block.items : [block.content];
    return groups.flatMap((group) => group.flatMap((inline) => (inline.type === "link" ? [inline] : [])));
  });
}

function assertCompleteComplianceCorpus(fileNames: readonly string[], articles: readonly HelpArticle[]) {
  for (const { slug } of complianceArticles) {
    const ownedSources = fileNames.filter((fileName) => fileName.startsWith(`${slug}.`));
    if (ownedSources.length !== 1 || ownedSources[0] !== `${slug}.en.md`) {
      throw new Error(`${slug} must have exactly one owned English source`);
    }
    if (articles.filter((article) => article.slug === slug && article.locale === "en").length !== 1) {
      throw new Error(`${slug} must compile exactly once`);
    }
  }
}

const executableEvidenceNeedles: Readonly<Record<string, readonly RegExp[]>> = {
  "bounded-contexts/marketplace/features/offers/api/runtime.test.ts": [/cannot offer on their own listings/i],
  "bounded-contexts/checkout/features/cart/domain/domain.test.ts": [/own listing to cart/i],
  "bounded-contexts/ordering/features/orders/domain/domain.test.ts": [
    /same-account self-dealing order creation/i,
    /Order total must equal item subtotal, Shipping, sales tax/i,
  ],
  "bounded-contexts/marketplace/features/reviews/domain/domain.test.ts": [
    /submits reviews in both transaction directions/i,
    /rejects self-review submission/i,
    /requires a reason for operator withdrawal/i,
    /redacts review feedback/i,
  ],
  "bounded-contexts/marketplace/features/reviews/domain/directional-review-disposition.test.ts": [
    /both directions for a normally completed order/i,
  ],
  "bounded-contexts/marketplace/features/reports/api/runtime.test.ts": [
    /auto-unlists an active listing only when the distinct reporter/i,
    /rejects duplicate reports/i,
    /reports a revealed review into the same queue/i,
  ],
  "bounded-contexts/platform-operations/features/reported-content/read-model/projection.test.ts": [
    /marks the queue item auto-unlisted/i,
    /reported-content\.action-recorded/i,
  ],
  "bounded-contexts/identity/features/accounts/domain/domain.test.ts": [/creates and suspends an account/i],
  "bounded-contexts/identity/tests/api-mutation-snapshots.test.ts": [
    /accounts\/acc_1\/reactivate/i,
    /accounts\/acc_1\/close/i,
  ],
  "bounded-contexts/inventory/tests/account-inventory-routes.test.ts": [/catalogItemId/i, /create-item/i],
  "bounded-contexts/marketplace/features/listings/api/runtime.test.ts": [
    /creates batch draft listings from committed inventory snapshots/i,
  ],
  "bounded-contexts/marketplace/features/listings/domain/listing-evidence-readiness.test.ts": [
    /photo coverage/i,
    /seller-trust-requirement-unmet/i,
  ],
  "bounded-contexts/marketplace/features/listing-evidence-policy/domain/policy.test.ts": [
    /photo and seller-trust thresholds as policy data/i,
  ],
  "bounded-contexts/ordering/tests/tax-nexus-tracking.test.ts": [
    /marks registration required after the threshold is crossed/i,
    /keeps no-statewide-sales-tax states out of provider requirements/i,
    /keeps complex local-admin jurisdictions in manual review/i,
  ],
  "deployables/platform-api/__tests__/tax-readiness.test.ts": [
    /blocks production tax quotes when collection requires a provider-backed resolver/i,
  ],
  "bounded-contexts/settlement/features/payout-readiness/domain/domain.test.ts": [/tax-id/i, /status: "restricted"/i],
  "bounded-contexts/settlement/features/payouts/api/runtime.test.ts": [
    /blocks payout requests until payout readiness is ready/i,
  ],
};

function assertShippedPromiseBoundary(article: HelpArticle) {
  const forbidden =
    /automated takedown|seller notification|1099-k form generation|graduated enforcement|in-product appeal/i;
  for (const promise of article.promiseTable) {
    if (forbidden.test(promise.claim)) throw new Error(`${article.slug} promises unshipped behavior`);
    if (promise.issues.some((issue) => ["#5987", "#5988", "#5989", "#5990"].includes(issue))) {
      throw new Error(`${article.slug} delegates a present promise to a future-gap issue`);
    }
    if (promise.tests.length === 0) throw new Error(`${article.slug} promise lacks executable evidence`);
  }
}

const statutoryEvidence = {
  "intellectual-property-and-dmca": {
    urls: ["https://www.copyright.gov/512/", dmcaDirectoryUrl],
    propositions: [/penalty of perjury/i, /ten and no more than fourteen business days/i],
  },
  "sales-tax": {
    urls: ["https://www.streamlinedsalestax.org/for-businesses/marketplace-facilitator"],
    propositions: [/\$100,000 in sales or 200 transactions/i, /seller may still be required to register and file/i],
  },
  "tax-reporting-1099k": {
    urls: [
      "https://www.irs.gov/businesses/understanding-your-form-1099-k",
      "https://www.irs.gov/newsroom/form-1099-k-faqs",
    ],
    propositions: [/exceeds \$20,000/i, /exceeds 200/i, /must report income/i],
  },
} as const;

function assertStatutoryEvidence(article: HelpArticle) {
  const evidence = statutoryEvidence[article.slug as keyof typeof statutoryEvidence];
  if (!evidence) throw new Error(`${article.slug} has no statutory evidence contract`);
  const links = new Set(articleLinks(article).map(({ href }) => href));
  for (const url of evidence.urls) {
    if (!links.has(url)) throw new Error(`${article.slug} is missing authoritative citation ${url}`);
  }
  const text = articleText(article);
  for (const proposition of evidence.propositions) {
    if (!proposition.test(text)) throw new Error(`${article.slug} is missing its cited proposition`);
  }
  const renderedReviewDate = new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${article.reviewedAt}T00:00:00.000Z`));
  if (!text.includes(renderedReviewDate)) throw new Error(`${article.slug} reviewedAt lacks a captured source review`);
}

type DmcaDirectoryProbe = Readonly<{
  authority: string;
  capturedAt: string;
  queriedIdentity: string;
  matchingCurrentRecord: boolean;
  recordReference?: string;
}>;

function selectDmcaRegistrationState(source: string, probe: DmcaDirectoryProbe) {
  if (probe.authority !== dmcaDirectoryUrl || !/^2026-08-02T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(probe.capturedAt)) {
    throw new Error("DMCA registration requires a captured Copyright Office directory probe");
  }
  if (probe.queriedIdentity !== "Todd Skelton | Chase Sets Limited | PO Box 164 | Maize KS 67101-0164 US") {
    throw new Error("DMCA directory probe identity does not match the settled contact");
  }
  if (!probe.matchingCurrentRecord) {
    if (!source.includes(unverifiedRegistrationToken)) throw new Error("unmatched probe must fail closed");
    return unverifiedRegistrationToken;
  }
  if (
    !probe.recordReference ||
    !source.includes(probe.recordReference) ||
    source.includes(unverifiedRegistrationToken)
  ) {
    throw new Error("registered copy requires the matching current directory record");
  }
  return "registered";
}

describe("#5693 compliance policy articles", () => {
  it("enforces five-source corpus completeness with a deletion predecessor control", () => {
    const sources = corpusSources();
    const compiled = compileHelpArticleCorpus(sources, { allowedAudiences: ["buyer", "seller"] });
    expect(() =>
      assertCompleteComplianceCorpus(
        sources.map(({ fileName }) => fileName),
        compiled,
      ),
    ).not.toThrow();

    const missingOne = sources.filter(({ fileName }) => fileName !== "sales-tax.en.md");
    expect(() =>
      assertCompleteComplianceCorpus(
        missingOne.map(({ fileName }) => fileName),
        compiled,
      ),
    ).toThrow("sales-tax must have exactly one owned English source");
  });

  it.each(complianceArticles)("freezes $slug body content independently of frontmatter", ({ slug, bodySha256 }) => {
    const { source } = complianceSource(slug);
    expect(sha256(sourceBody(source))).toBe(bodySha256);
  });

  it.each(complianceArticles)(
    "discovers $slug through the generated catalog with localized audience/category chrome",
    ({ slug, audience, category }) => {
      const article = findArticle(slug);
      expect(article).toMatchObject({
        slug,
        locale: "en",
        audience,
        category,
        reviewedAt: "2026-08-02",
        href: `/help/${category}/${slug}`,
      });
      expect(publicHelpArticlePaths.filter((path) => path === article.href)).toHaveLength(1);
      expect(listHelpArticlesByCategory(category).map((candidate) => candidate.slug)).toContain(slug);
      expect(listHelpCategoriesByAudience(audience)).toContain(category);
      expect(publicPresenceHasTranslation(`publicPresence.help.audience.${audience}.title`)).toBe(true);
      expect(publicPresenceHasTranslation(`publicPresence.help.category.${category}.title`)).toBe(true);
    },
  );

  it("maps every promise to discriminating executable assertions and rejects future-gap promises", () => {
    for (const { slug } of complianceArticles) {
      const article = findArticle(slug);
      expect(article.promiseTable.length).toBeGreaterThan(0);
      expect(() => assertShippedPromiseBoundary(article)).not.toThrow();
      for (const promise of article.promiseTable) {
        for (const testPath of promise.tests) {
          const needles = executableEvidenceNeedles[testPath];
          expect(needles, `${slug}: ${testPath} must have a discriminating evidence contract`).toBeDefined();
          if (!needles) throw new Error(`${testPath} lacks a discriminating evidence contract`);
          const absolutePath = resolve(repoRoot, testPath);
          expect(existsSync(absolutePath), testPath).toBe(true);
          const testSource = readFileSync(absolutePath, "utf8");
          for (const needle of needles) expect(testSource, `${testPath} must match ${needle}`).toMatch(needle);
        }
      }
    }

    const article = findArticle("intellectual-property-and-dmca");
    const mutant = {
      ...article,
      promiseTable: [
        { ...article.promiseTable[0], claim: "Automated takedown removes every reported listing immediately." },
        ...article.promiseTable.slice(1),
      ],
    };
    expect(() => assertShippedPromiseBoundary(mutant)).toThrow("promises unshipped behavior");
  });

  it("rejects non-entailing or stale statutory evidence", () => {
    for (const slug of Object.keys(statutoryEvidence))
      expect(() => assertStatutoryEvidence(findArticle(slug))).not.toThrow();

    const taxSource = complianceSource("tax-reporting-1099k");
    const nonEntailing = compileHelpArticleSource(
      taxSource.fileName,
      taxSource.source.replace(
        "https://www.irs.gov/businesses/understanding-your-form-1099-k",
        "https://www.irs.gov/businesses/small-businesses-self-employed",
      ),
    );
    expect(() => assertStatutoryEvidence(nonEntailing)).toThrow("missing authoritative citation");

    const stale = compileHelpArticleSource(
      taxSource.fileName,
      taxSource.source.replace('reviewedAt: "2026-08-02"', 'reviewedAt: "2026-08-03"'),
    );
    expect(() => assertStatutoryEvidence(stale)).toThrow("reviewedAt lacks a captured source review");
  });

  it("fails closed to registration-status-unverified", () => {
    const dmcaSource = complianceSource("intellectual-property-and-dmca").source;
    const state = selectDmcaRegistrationState(dmcaSource, {
      authority: dmcaDirectoryUrl,
      capturedAt: "2026-08-02T04:00:00Z",
      queriedIdentity: "Todd Skelton | Chase Sets Limited | PO Box 164 | Maize KS 67101-0164 US",
      matchingCurrentRecord: false,
    });
    expect(state).toBe(unverifiedRegistrationToken);
    expect(dmcaSource).toContain("Todd Skelton, Chase Sets Limited, PO Box 164, Maize, KS 67101-0164, US");
  });

  it("selects registered DMCA copy from a matching current directory probe", () => {
    const recordReference = "synthetic-directory-record-control";
    const dmcaSource = complianceSource("intellectual-property-and-dmca").source;
    const registeredSource = dmcaSource.replace(
      /As of the August 2, 2026 review,[\s\S]*?This marker is removed only when a current directory record is verified\./,
      `The matching current Copyright Office directory record is ${recordReference}.`,
    );
    expect(
      selectDmcaRegistrationState(registeredSource, {
        authority: dmcaDirectoryUrl,
        capturedAt: "2026-08-02T04:00:00Z",
        queriedIdentity: "Todd Skelton | Chase Sets Limited | PO Box 164 | Maize KS 67101-0164 US",
        matchingCurrentRecord: true,
        recordReference,
      }),
    ).toBe("registered");

    expect(() =>
      selectDmcaRegistrationState(registeredSource, {
        authority: "https://github.com/chase-sets/chase-sets/issues/5682",
        capturedAt: "2026-08-02T04:00:00Z",
        queriedIdentity: "Todd Skelton | Chase Sets Limited | PO Box 164 | Maize KS 67101-0164 US",
        matchingCurrentRecord: true,
        recordReference,
      }),
    ).toThrow("requires a captured Copyright Office directory probe");
  });

  it("keeps counsel-gated drafts out of publication activation and the public-doc review queue", () => {
    const citedSlugs = publicHelpArticlePolicyCitations.map(({ slug }) => slug);
    const policyHrefs = new Set(Object.values(publicPolicyHrefsByKey));
    expect(publicPolicyKeys.length).toBeGreaterThan(0);
    expect(Object.keys(publicPolicyPublicationRecords)).toHaveLength(publicPolicyKeys.length);
    expect(publicHelpArticlePolicyCitations).toEqual(
      expect.arrayContaining([expect.objectContaining({ slug: "condition-and-photo-standards" })]),
    );

    for (const { slug } of complianceArticles) {
      const article = findArticle(slug);
      expect(article.citedPolicies).toEqual([]);
      expect(article.policyValueKeys).toEqual([]);
      expect(citedSlugs).not.toContain(slug);
      expect(publicPolicyKeys).not.toContain(slug as never);
      expect(policyHrefs.has(article.href as never)).toBe(false);
      expect(article).not.toHaveProperty("publicationStatus");
      expect(article).not.toHaveProperty("effectiveAt");
      expect(article).not.toHaveProperty("consentActivatable");
    }
    expect(articleText(findArticle("intellectual-property-and-dmca"))).toContain(unverifiedRegistrationToken);
  });
});

describe("#5695 source-owned legal-review corpus manifest", () => {
  it("carries the exact reviewed compliance membership and order, and fails on a deletion or reorder", () => {
    expect(() => assertManifestMatchesReviewedMembership([...complianceLegalReviewArticleSlugs])).not.toThrow();
    expect(complianceLegalReviewLocale).toBe("en");

    const deleted = complianceLegalReviewArticleSlugs.filter((slug) => slug !== "sales-tax");
    expect(() => assertManifestMatchesReviewedMembership(deleted)).toThrow(
      "must carry exactly 5 reviewed compliance members",
    );

    const reordered = [
      complianceLegalReviewArticleSlugs[1],
      complianceLegalReviewArticleSlugs[0],
      ...complianceLegalReviewArticleSlugs.slice(2),
    ];
    expect(() => assertManifestMatchesReviewedMembership(reordered)).toThrow(
      "member 0 must be 'community-guidelines-and-enforcement'",
    );
  });

  it("declares three summary-only incorporated references that resolve once and never overlap the members", () => {
    expect([...incorporatedHelpArticleSlugs]).toEqual([
      "condition-and-photo-standards",
      "order-protection",
      "refunds-and-returns",
    ]);
    for (const slug of incorporatedHelpArticleSlugs) {
      expect(complianceLegalReviewArticleSlugs).not.toContain(slug as never);
      expect(
        publicHelpArticles.filter((article) => article.slug === slug && article.locale === complianceLegalReviewLocale),
      ).toHaveLength(1);
      const fileNames = readdirSync(articlesDirectory).filter((fileName) => fileName.startsWith(`${slug}.`));
      expect(fileNames).toEqual([`${slug}.en.md`]);
    }
  });

  it("keeps the DMCA marker constants bound to the checked-in fail-closed source", () => {
    expect(dmcaComplianceArticleSlug).toBe("intellectual-property-and-dmca");
    expect(dmcaUnverifiedRegistrationMarker).toBe(unverifiedRegistrationToken);
    expect(complianceSource(dmcaComplianceArticleSlug).source).toContain(dmcaUnverifiedRegistrationMarker);
  });
});
