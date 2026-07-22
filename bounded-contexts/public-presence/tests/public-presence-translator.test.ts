import { describe, expect, it } from "vitest";
import { publicPresenceEnglishTranslations } from "@chase-sets/localization/locales/en/public-presence";
import { developerArticles } from "../features/developer-portal/domain/developer-article-catalog";
import { publicHelpArticles } from "../features/help/domain/article-catalog";
import { assertPublicCopyGuard } from "../features/help/domain/public-copy-guard.mjs";
import { publicPresenceHasTranslation, publicPresenceT } from "../features/waitlist/ui/public-presence-translator";

describe("public presence translator", () => {
  it("resolves public presence copy without the global localization runtime", () => {
    expect(publicPresenceHasTranslation("publicPresence.brand")).toBe(true);
    expect(publicPresenceT("publicPresence.brand")).toBe("Chase Sets");
  });

  it("keeps missing keys explicit", () => {
    expect(publicPresenceHasTranslation("adminWeb.app.title")).toBe(false);
    expect(publicPresenceT("adminWeb.app.title")).toBe("[missing:en:adminWeb.app.title]");
  });

  it("keeps launch-critical public policy copy out of placeholder language", () => {
    const launchPolicyKeys = [
      "publicPresence.faq.description",
      "publicPresence.faq.fees.answer",
      "publicPresence.faq.fees.question",
      "publicPresence.faq.launch.answer",
      "publicPresence.faq.safety.answer",
      "publicPresence.faq.safety.question",
      "publicPresence.faq.shipping.answer",
      "publicPresence.faq.shipping.question",
      "publicPresence.faq.title",
      "publicPresence.footer.description",
      "publicPresence.info.contact.description",
      "publicPresence.info.contact.status.body",
      "publicPresence.info.privacy.description",
      "publicPresence.routes.privacy.meta.description",
      "publicPresence.routes.terms.meta.description",
    ];

    expect(launchPolicyKeys.every((key) => publicPresenceHasTranslation(key))).toBe(true);

    const copy = `${launchPolicyKeys.map((key) => publicPresenceT(key)).join(" ")} ${JSON.stringify(publicHelpArticles)}`;

    expect(() => assertPublicCopyGuard({ corpus: "consumer", copy, guard: "launch-language" })).not.toThrow();
    expect(copy).not.toMatch(/\b(future|intended|planned|expected)\b/i);
    expect(copy).not.toContain("will be published");
    expect(copy).not.toContain("production promotion approval");
    expect(copy).toContain("Marketplace checkout opens at launch.");
  });

  it("keeps uncertified UCP and AP2 agent-commerce claims out of public launch copy", () => {
    const publicLaunchCopy = `${Object.entries(publicPresenceEnglishTranslations)
      .filter(([key]) => {
        return (
          key.startsWith("publicPresence.faq.") ||
          key.startsWith("publicPresence.footer.") ||
          key.startsWith("publicPresence.home.") ||
          key.startsWith("publicPresence.info.") ||
          key.startsWith("publicPresence.nav.") ||
          key.startsWith("publicPresence.preview.") ||
          key.startsWith("publicPresence.routes.") ||
          key.startsWith("publicPresence.waitlist.")
        );
      })
      .map(([key, value]) => `${key}: ${value}`)
      .join("\n")}\n${JSON.stringify(publicHelpArticles)}`;

    const restrictedClaims = [
      /\bUCP\b/i,
      /\bAP2\b/i,
      /\bagentic\b/i,
      /\bAI agent\b/i,
      /\bagent[-\s]?commerce\b/i,
      /\bagent checkout\b/i,
      /\bautonomous payment\b/i,
      /\bheadless checkout\b/i,
      /\bheadless completion\b/i,
      /\bpayment handler\b/i,
      /\bShared Payment Token\b/i,
      /\bSPT\b/i,
    ];

    expect(() =>
      assertPublicCopyGuard({ corpus: "consumer", copy: publicLaunchCopy, guard: "agent-commerce" }),
    ).not.toThrow();
    for (const restrictedClaim of restrictedClaims) {
      expect(publicLaunchCopy).not.toMatch(restrictedClaim);
    }
  });

  it("exempts developer UCP and planned copy without weakening consumer guards", () => {
    const developerCopy = JSON.stringify(developerArticles);
    expect(developerCopy).toMatch(/\bUCP\b/);
    expect(developerCopy).toMatch(/\bplanned\b/i);
    expect(() =>
      assertPublicCopyGuard({ corpus: "developer", copy: developerCopy, guard: "launch-language" }),
    ).not.toThrow();
    expect(() =>
      assertPublicCopyGuard({ corpus: "developer", copy: developerCopy, guard: "agent-commerce" }),
    ).not.toThrow();

    const forbiddenConsumerCopy = "A planned UCP agent-commerce integration.";
    expect(() =>
      assertPublicCopyGuard({ corpus: "consumer", copy: forbiddenConsumerCopy, guard: "launch-language" }),
    ).toThrow("consumer launch-language copy violations");
    expect(() =>
      assertPublicCopyGuard({ corpus: "consumer", copy: forbiddenConsumerCopy, guard: "agent-commerce" }),
    ).toThrow("consumer agent-commerce copy violations");
  });
});
