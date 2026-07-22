import { describe, expect, it } from "vitest";
import { publicPolicyPublicationRecords } from "../contracts/public-docs/generated/index.ts";
import {
  LAUNCH_AUDITED_POLICY_PAGES,
  MARKETPLACE_PUBLIC_PRESENCE_COPY_AUDIT_VERSION,
  REQUIRED_PUBLIC_PRESENCE_PAGES,
  auditPublicPresenceCopy,
  parsePublicPresenceCopyAuditArgs,
} from "./marketplace-public-presence-copy-audit.mjs";

function fetchWithPages(pageBodies) {
  return async (url) => {
    const path = new URL(url).pathname;
    const body = pageBodies[path] ?? pageBodies["*"] ?? "";
    return {
      status: body ? 200 : 404,
      url,
      text: async () => body,
    };
  };
}

function html(title, body) {
  return `<html><head><title>${title}</title></head><body>${body}</body></html>`;
}

function publishedTermsHtml(body) {
  return `<html><head><title>terms</title></head><body><main data-policy-key="terms-of-service" data-policy-version="v2" data-policy-publication-status="published" data-policy-effective-at="2026-09-01T00:00:00.000Z">${body}</main></body></html>`;
}

function allPages(body) {
  return Object.fromEntries(REQUIRED_PUBLIC_PRESENCE_PAGES.map((page) => [page.path, html(page.name, body)]));
}

describe("marketplace public presence copy audit", () => {
  it("passes the current prelaunch posture when every page is gated and avoids uncertified claims", async () => {
    const audit = await auditPublicPresenceCopy(
      {
        baseUrl: "https://chasesets.com",
        mode: "prelaunch",
        checkedAt: "2026-05-30T15:00:00.000Z",
      },
      {
        fetch: fetchWithPages(
          allPages("Public marketplace checkout opens only after production promotion approval. Request early access."),
        ),
      },
    );

    expect(audit).toMatchObject({
      schemaVersion: MARKETPLACE_PUBLIC_PRESENCE_COPY_AUDIT_VERSION,
      baseUrl: "https://chasesets.com",
      mode: "prelaunch",
      checkedAt: "2026-05-30T15:00:00.000Z",
      requiredPageCount: REQUIRED_PUBLIC_PRESENCE_PAGES.length,
      publicPresenceLaunchCopyReviewed: true,
      futureOnlyLaunchCopyRemoved: false,
      policyPagesReviewed: true,
      uncertifiedClaimsAbsent: true,
      passesPublicPresenceCopyAudit: true,
    });
  });

  it("fails prelaunch posture when a required page does not say checkout is gated", async () => {
    const pages = allPages("Public marketplace checkout opens only after production promotion approval.");
    pages["/privacy"] = html("privacy", "Privacy notice.");

    const audit = await auditPublicPresenceCopy(
      {
        baseUrl: "https://chasesets.com",
        mode: "prelaunch",
        checkedAt: "2026-05-30T15:00:00.000Z",
      },
      { fetch: fetchWithPages(pages) },
    );

    expect(audit.passesPublicPresenceCopyAudit).toBe(false);
    expect(audit.errors).toContain(
      "Public Presence page /privacy must keep explicit prelaunch/gated-checkout posture.",
    );
  });

  it("passes launch posture only after future-only copy is removed", async () => {
    const pages = allPages("Live marketplace policies are available. Support is available.");
    pages["/terms"] = publishedTermsHtml("Live marketplace policies are available. Support is available.");
    const audit = await auditPublicPresenceCopy(
      {
        baseUrl: "https://chasesets.com",
        mode: "launch",
        checkedAt: "2026-05-30T15:00:00.000Z",
      },
      {
        fetch: fetchWithPages(pages),
      },
    );

    expect(audit.passesPublicPresenceCopyAudit).toBe(true);
    expect(audit.futureOnlyLaunchCopyRemoved).toBe(true);
    expect(audit.termsPublicationReady).toBe(true);
  });

  it("fails launch posture while the terms artifact is still awaiting counsel review", async () => {
    const pages = allPages("Live marketplace policies are available. Support is available.");
    pages["/terms"] =
      `<html><head><title>terms</title></head><body><main data-policy-key="terms-of-service" data-policy-version="v1" data-policy-publication-status="counsel-review-required" data-policy-effective-at="">Counsel-approved language required.</main></body></html>`;

    const audit = await auditPublicPresenceCopy(
      {
        baseUrl: "https://chasesets.com",
        mode: "launch",
        checkedAt: "2026-05-30T15:00:00.000Z",
      },
      { fetch: fetchWithPages(pages) },
    );

    expect(audit.passesPublicPresenceCopyAudit).toBe(false);
    expect(audit.termsPublicationReady).toBe(false);
    expect(audit.errors).toEqual(
      expect.arrayContaining([
        "Public Presence /terms policy artifact must be published before launch.",
        "Public Presence /terms policy artifact must expose an effective ISO timestamp before launch.",
      ]),
    );
  });

  it("fails launch posture while future-only copy remains live", async () => {
    const audit = await auditPublicPresenceCopy(
      {
        baseUrl: "https://chasesets.com",
        mode: "launch",
        checkedAt: "2026-05-30T15:00:00.000Z",
      },
      {
        fetch: fetchWithPages(allPages("Request early access before public checkout opens.")),
      },
    );

    expect(audit.passesPublicPresenceCopyAudit).toBe(false);
    expect(audit.errors).toContain(
      "Public Presence page / still includes future-only launch copy: early access, Request early access.",
    );
  });

  it("fails launch posture when copy still frames checkout as gated by production promotion", async () => {
    const audit = await auditPublicPresenceCopy(
      {
        baseUrl: "https://chasesets.com",
        mode: "launch",
        checkedAt: "2026-05-30T15:00:00.000Z",
      },
      {
        fetch: fetchWithPages(allPages("Marketplace checkout is gated until production promotion approval.")),
      },
    );

    expect(audit.passesPublicPresenceCopyAudit).toBe(false);
    expect(audit.errors).toContain(
      "Public Presence page / still includes future-only launch copy: production promotion approval, production promotion, \\bgated\\b.",
    );
  });

  it("fails when uncertified agent-commerce claims are present", async () => {
    const pages = allPages("Public marketplace checkout opens only after production promotion approval.");
    pages["/faq"] = html("faq", "AP2 headless checkout is launch-ready.");

    const audit = await auditPublicPresenceCopy(
      {
        baseUrl: "https://chasesets.com",
        mode: "prelaunch",
        checkedAt: "2026-05-30T15:00:00.000Z",
      },
      { fetch: fetchWithPages(pages) },
    );

    expect(audit.passesPublicPresenceCopyAudit).toBe(false);
    expect(audit.errors).toContain("Public Presence page /faq includes uncertified agent-commerce claim: \\bAP2\\b.");
    expect(audit.errors).toContain(
      "Public Presence page /faq includes uncertified agent-commerce claim: headless checkout.",
    );
  });

  it("fails when launch copy uses AP2/UCP synonym claims from sales collateral", async () => {
    const pages = allPages("Public marketplace checkout opens only after production promotion approval.");
    pages["/faq"] = html("faq", "Agentic checkout with an AI agent can complete headless completion using SPT.");

    const audit = await auditPublicPresenceCopy(
      {
        baseUrl: "https://chasesets.com",
        mode: "prelaunch",
        checkedAt: "2026-05-30T15:00:00.000Z",
      },
      { fetch: fetchWithPages(pages) },
    );

    expect(audit.passesPublicPresenceCopyAudit).toBe(false);
    expect(audit.errors).toContain(
      "Public Presence page /faq includes uncertified agent-commerce claim: \\bagentic\\b.",
    );
    expect(audit.errors).toContain(
      "Public Presence page /faq includes uncertified agent-commerce claim: \\bAI agent\\b.",
    );
    expect(audit.errors).toContain(
      "Public Presence page /faq includes uncertified agent-commerce claim: headless completion.",
    );
    expect(audit.errors).toContain("Public Presence page /faq includes uncertified agent-commerce claim: \\bSPT\\b.");
  });

  it("fails when a required policy page is not reachable", async () => {
    const pages = allPages("Public marketplace checkout opens only after production promotion approval.");
    delete pages["/contact"];

    const audit = await auditPublicPresenceCopy(
      {
        baseUrl: "https://chasesets.com",
        mode: "prelaunch",
        checkedAt: "2026-05-30T15:00:00.000Z",
      },
      { fetch: fetchWithPages(pages) },
    );

    expect(audit.passesPublicPresenceCopyAudit).toBe(false);
    expect(audit.errors).toContain("Public Presence page /contact returned status 404.");
  });

  it("fails when checkedAt is a date-only value", async () => {
    const audit = await auditPublicPresenceCopy(
      {
        baseUrl: "https://chasesets.com",
        mode: "launch",
        checkedAt: "2026-05-30",
      },
      {
        fetch: fetchWithPages(allPages("Live marketplace policies are available. Support is available.")),
      },
    );

    expect(audit.passesPublicPresenceCopyAudit).toBe(false);
    expect(audit.errors).toContain("Public Presence copy audit checkedAt must be an ISO timestamp.");
  });

  it("keeps the explicit launch-audit set consistent with the generated policy corpus", () => {
    expect(LAUNCH_AUDITED_POLICY_PAGES).toEqual([{ name: "terms", path: "/terms", policyKey: "terms-of-service" }]);
    for (const policyPage of LAUNCH_AUDITED_POLICY_PAGES) {
      const record = publicPolicyPublicationRecords[policyPage.policyKey];
      expect(record).toBeDefined();
      expect(record.href).toBe(policyPage.path);
      expect(record.launchRequired).toBe(true);
    }
  });

  it("fails launch mode when a launch-required corpus document in the audit set is still counsel-pending", async () => {
    const pages = allPages("Live marketplace policies are available. Support is available.");
    pages["/terms"] = publishedTermsHtml("Live marketplace policies are available. Support is available.");
    pages["/seller-agreement"] =
      `<html><head><title>seller agreement</title></head><body><main data-policy-key="seller-agreement" data-policy-version="v1" data-policy-publication-status="counsel-review-required" data-policy-effective-at="">Live marketplace policies are available. Counsel-approved language required.</main></body></html>`;

    const audit = await auditPublicPresenceCopy(
      {
        baseUrl: "https://chasesets.com",
        mode: "launch",
        checkedAt: "2026-05-30T15:00:00.000Z",
      },
      {
        fetch: fetchWithPages(pages),
        launchAuditedPolicyPages: [
          ...LAUNCH_AUDITED_POLICY_PAGES,
          { name: "sellerAgreement", path: "/seller-agreement", policyKey: "seller-agreement" },
        ],
      },
    );

    expect(audit.passesPublicPresenceCopyAudit).toBe(false);
    expect(audit.errors).toEqual(
      expect.arrayContaining([
        "Public Presence /seller-agreement policy artifact must be published before launch.",
        "Public Presence /seller-agreement policy artifact must expose an effective ISO timestamp before launch.",
      ]),
    );
    expect(audit.errors).not.toContain("Public Presence /terms policy artifact must be published before launch.");
  });

  it("parses operator arguments from flags and environment", () => {
    expect(
      parsePublicPresenceCopyAuditArgs(
        ["--base-url", "https://chasesets.com", "--mode", "launch", "--checked-at", "2026-05-30T15:00:00.000Z"],
        {},
      ),
    ).toEqual({
      baseUrl: "https://chasesets.com",
      mode: "launch",
      checkedAt: "2026-05-30T15:00:00.000Z",
    });

    expect(
      parsePublicPresenceCopyAuditArgs([], {
        PUBLIC_PRESENCE_COPY_AUDIT_BASE_URL: "https://chasesets.com",
      }),
    ).toMatchObject({
      baseUrl: "https://chasesets.com",
      mode: "prelaunch",
    });
  });
});
