import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { publicPresenceEnglishTranslations } from "@chase-sets/localization/locales/en/public-presence";
import { publicPolicyPublicationRecords } from "@chase-sets/public-docs";
import { afterEach, describe, expect, it, vi } from "vitest";
import FoundersRoute, { loader as foundersLoader, meta as foundersMeta } from "../routes/marketplace/founders";
import { foundersOfferTermsPolicyArtifact } from "../features/policies/domain/founders-offer-terms";
import { renderPublicPolicyPublicationContracts } from "../features/policies/integrations/compile-policy-publications.mjs";
import { publicOpenGraphImages } from "../features/waitlist/ui/social-meta";
import { meta as agentTermsMeta } from "../routes/marketplace/agent-terms";
import { meta as authenticityTermsMeta } from "../routes/marketplace/authenticity-terms";
import { meta as paymentsTermsMeta } from "../routes/marketplace/payments-terms";
import { meta as privacyPolicyMeta } from "../routes/marketplace/privacy";
import { meta as sellerAgreementMeta } from "../routes/marketplace/seller-agreement";
import { meta as termsOfServiceMeta } from "../routes/marketplace/terms";

const corpusRoutes = [
  { routeName: "founders", meta: foundersMeta, policyKey: "founders-offer-terms", noindexWhilePending: false },
  { routeName: "terms", meta: termsOfServiceMeta, policyKey: "terms-of-service", noindexWhilePending: false },
  {
    routeName: "seller-agreement",
    meta: sellerAgreementMeta,
    policyKey: "seller-agreement",
    noindexWhilePending: true,
  },
  { routeName: "payments-terms", meta: paymentsTermsMeta, policyKey: "payments-terms", noindexWhilePending: true },
  { routeName: "privacy", meta: privacyPolicyMeta, policyKey: "privacy-policy", noindexWhilePending: false },
  { routeName: "agent-terms", meta: agentTermsMeta, policyKey: "agent-connector-terms", noindexWhilePending: true },
  {
    routeName: "authenticity-terms",
    meta: authenticityTermsMeta,
    policyKey: "authenticity-service-terms",
    noindexWhilePending: true,
  },
] as const;

describe("policy corpus route metadata", () => {
  for (const route of corpusRoutes) {
    it(`publishes machine policy metadata and counsel-pending posture for ${route.routeName}`, () => {
      const descriptors = route.meta({} as never);

      expect(descriptors).toEqual(
        expect.arrayContaining([
          { name: "chase-sets:policy-key", content: route.policyKey },
          { name: "chase-sets:policy-version", content: "v1" },
          { name: "chase-sets:policy-publication-status", content: "counsel-review-required" },
        ]),
      );
      if (route.noindexWhilePending) {
        expect(descriptors).toEqual(expect.arrayContaining([{ name: "robots", content: "noindex, nofollow" }]));
      } else {
        expect(descriptors).not.toEqual(expect.arrayContaining([expect.objectContaining({ name: "robots" })]));
      }
      expect(descriptors).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ name: "chase-sets:policy-effective-at" })]),
      );
    });
  }
});

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const source = (path: string) => readFileSync(resolve(repoRoot, path), "utf8");
const retiredFoundersKeys = [
  "title",
  "description",
  ...["offer", "feeLock", "buyerEconomics", "afterWindow", "faqForever", "faqSignup", "faqKeep"].flatMap((topic) => [
    `${topic}.title`,
    `${topic}.body`,
  ]),
].map((key) => `publicPresence.info.founders.${key}`);

function assertFoundersSocialMeta(descriptors: ReturnType<typeof foundersMeta>, origin: string) {
  expect(descriptors, "request-derived founders social metadata").toEqual(
    expect.arrayContaining([
      { property: "og:url", content: `${origin}/founders` },
      { property: "og:image", content: new URL(publicOpenGraphImages.founders, origin).toString() },
      { name: "twitter:image", content: new URL(publicOpenGraphImages.founders, origin).toString() },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "chase-sets:policy-key", content: "founders-offer-terms" },
      { name: "chase-sets:policy-version", content: "v1" },
      { name: "chase-sets:policy-publication-status", content: "counsel-review-required" },
    ]),
  );
  expect(descriptors).not.toEqual(expect.arrayContaining([expect.objectContaining({ name: "robots" })]));
}

describe("founders origin-sensitive metadata", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("uses the non-default request origin through the real loader and rejects fallback data", () => {
    vi.stubEnv("CHASE_SETS_PUBLIC_ORIGIN", undefined);
    const data = foundersLoader({ request: new Request("https://non-default.example.test/founders") } as never);
    expect(data.publicOrigin).toBe("https://non-default.example.test");
    assertFoundersSocialMeta(foundersMeta({ data } as never), "https://non-default.example.test");
    expect(() => assertFoundersSocialMeta(foundersMeta({} as never), "https://non-default.example.test")).toThrow(
      "request-derived founders social metadata",
    );
  });
  it("lets the explicit public-origin override win over the request origin", () => {
    vi.stubEnv("CHASE_SETS_PUBLIC_ORIGIN", " https://override.example.test ");
    const data = foundersLoader({ request: new Request("https://non-default.example.test/founders") } as never);
    expect(data.publicOrigin).toBe("https://override.example.test");
    assertFoundersSocialMeta(foundersMeta({ data } as never), "https://override.example.test");
  });
});

type FoundersMigrationObservation = Readonly<{
  subjects: readonly { id: string; draftText: string }[];
  routeHtml: string;
  fingerprint: string;
  expectedFingerprint: string;
  localeKeys: readonly string[];
  localeRebaseline: boolean;
  routes: readonly string[];
}>;

function migrationErrors(observation: FoundersMigrationObservation): string[] {
  const errors: string[] = [];
  if (observation.subjects.some((section) => section.draftText.trim().length === 0)) errors.push("blank-subject");
  const page = document.createElement("div");
  page.innerHTML = observation.routeHtml;
  if (
    !page.querySelector(
      '[data-policy-key="founders-offer-terms"][data-policy-version="v1"][data-policy-publication-status="counsel-review-required"]',
    ) ||
    observation.subjects.some(
      (section) =>
        page.querySelectorAll(`a[href="#${section.id}"]`).length !== 1 ||
        !page.textContent?.includes(section.draftText),
    )
  ) {
    errors.push("artifact-route");
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(observation.fingerprint)) errors.push("fingerprint-format");
  if (observation.fingerprint !== observation.expectedFingerprint) errors.push("publication-currentness");
  if (retiredFoundersKeys.some((key) => observation.localeKeys.includes(key))) errors.push("locale-retirement");
  if (!observation.localeRebaseline) errors.push("locale-rebaseline");
  if (!observation.routes.includes("founders")) errors.push("corpus-membership");
  return errors;
}

async function observeFoundersMigration(): Promise<FoundersMigrationObservation> {
  const modules = await renderPublicPolicyPublicationContracts();
  const module = modules.find(
    (candidate: { relativePath: string }) => candidate.relativePath === "founders-offer-terms-publication.ts",
  )!;
  const expectedFingerprint = /contentFingerprint: "(sha256:[0-9a-f]{64})"/.exec(module.content)![1]!;
  const localeKeys = Object.keys(publicPresenceEnglishTranslations).sort();
  const keySetTest = source("contracts/localization/public-presence-key-set.test.ts");
  const digest = createHash("sha256").update(JSON.stringify(localeKeys)).digest("hex");
  return {
    subjects: foundersOfferTermsPolicyArtifact.sections,
    routeHtml: renderToStaticMarkup(createElement(MemoryRouter, null, createElement(FoundersRoute))),
    fingerprint: publicPolicyPublicationRecords["founders-offer-terms"].contentFingerprint,
    expectedFingerprint,
    localeKeys,
    localeRebaseline: keySetTest.includes(`count: ${localeKeys.length},`) && keySetTest.includes(`sha256: "${digest}"`),
    routes: corpusRoutes.map((route) => route.routeName),
  };
}

describe("atomic founders migration at the candidate head", () => {
  it("observes the real artifact, route, generated record, retired locale/rebaseline and corpus together", async () => {
    const real = await observeFoundersMigration();
    expect(migrationErrors(real)).toEqual([]);
    expect(retiredFoundersKeys).toHaveLength(16);
    expect(real.localeKeys.filter((key) => key.startsWith("publicPresence.info.founders."))).toEqual([
      "publicPresence.info.founders.eyebrow",
    ]);
    for (const key of [
      "publicPresence.routes.founders.meta.title",
      "publicPresence.routes.founders.meta.description",
      "publicPresence.nav.foundersTerms",
    ])
      expect(real.localeKeys).toContain(key);
  });

  it("rejects each independently incomplete migration with its corresponding reason", async () => {
    const real = await observeFoundersMigration();
    for (const draftText of ["", " \t\n"]) {
      const subjects = real.subjects.map((section, index) => (index === 0 ? { ...section, draftText } : section));
      expect(migrationErrors({ ...real, subjects })).toContain("blank-subject");
    }
    expect(
      migrationErrors({ ...real, routeHtml: "<main><h1>Founders offer terms</h1><p>Legacy info page</p></main>" }),
    ).toEqual(["artifact-route"]);
    const old = "sha256:483dda004c66223ca7dc76bd280e96e8261ee625c6f45676acaf09112ed51c30";
    expect(migrationErrors({ ...real, fingerprint: old })).toEqual(["publication-currentness"]);
    for (const key of retiredFoundersKeys)
      expect(migrationErrors({ ...real, localeKeys: [...real.localeKeys, key] })).toEqual(["locale-retirement"]);
    expect(migrationErrors({ ...real, localeRebaseline: false })).toEqual(["locale-rebaseline"]);
    expect(migrationErrors({ ...real, routes: real.routes.filter((route) => route !== "founders") })).toEqual([
      "corpus-membership",
    ]);
  });

  it("rejects a valid digest tail mutation that defeats an eight-hex-prefix comparator", async () => {
    const real = await observeFoundersMigration();
    const hex = "0123456789abcdef";
    const tail = hex[(hex.indexOf(real.fingerprint[70]!) + 1) % hex.length]!;
    const mutant = `${real.fingerprint.slice(0, 70)}${tail}`;
    expect(mutant).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(mutant.slice(0, 70)).toBe(real.fingerprint.slice(0, 70));
    expect(mutant[70]).not.toBe(real.fingerprint[70]);
    expect(mutant).not.toBe(real.expectedFingerprint);
    const defectiveEightHexComparator = (left: string, right: string) => left.slice(7, 15) === right.slice(7, 15);
    expect(defectiveEightHexComparator(mutant, real.expectedFingerprint)).toBe(true);
    expect(migrationErrors({ ...real, fingerprint: mutant })).toEqual(["publication-currentness"]);
    expect(migrationErrors({ ...real, fingerprint: real.fingerprint.slice(0, -1) })).toEqual([
      "fingerprint-format",
      "publication-currentness",
    ]);
  });

  it("preserves the footer, both CTA tuples, email identity, canonical links and sitemap entry", () => {
    const pages = source("bounded-contexts/public-presence/features/waitlist/ui/public-pages.tsx");
    expect(pages).toContain('{ href: "/founders", label: t("publicPresence.nav.foundersTerms") }');
    for (const section of ["founders_offer", "final_cta"])
      expect(pages).toContain(`trackCtaClick("${section}", "founders_terms", landingExperimentVariant)`);
    expect(pages.match(/"founders_terms"/g)).toHaveLength(2);
    const email = source(
      "bounded-contexts/public-presence/features/waitlist/integrations/transactional-email/transactional-email-intents.ts",
    );
    expect(email).toContain('trackedPublicUrl("/founders", step, "founders_terms")');
    expect(email.match(/"founders_terms"/g)).toHaveLength(1);
    const sitemap = source("deployables/public-web/app/routes/sitemap.ts");
    const stablePaths = /STABLE_PUBLIC_PATHS\s*=\s*\[([\s\S]*?)\]/.exec(sitemap)![1]!;
    expect(stablePaths.match(/"\/founders"/g)).toHaveLength(1);
    expect(source("bounded-contexts/public-presence/docs/landing-page-analytics.md")).not.toMatch(
      /founders.*faq|faq.*founders/i,
    );
    for (const path of [
      "bounded-contexts/public-presence/features/waitlist/ui/fee-comparison-calculator.tsx",
      "bounded-contexts/public-presence/features/waitlist/ui/success-page.tsx",
      "bounded-contexts/public-presence/features/help/domain/articles/creators-and-press.en.md",
      "bounded-contexts/public-presence/features/help/domain/articles/seller-migration-tcgplayer-ebay.en.md",
      "bounded-contexts/public-presence/features/policies/domain/terms-of-service.ts",
      "contracts/public-docs/policy-corpus.ts",
    ])
      expect(source(path), path).toContain("/founders");
    const manifest = source("bounded-contexts/public-presence/context.json");
    expect(manifest).toContain("founders");
  });
});
