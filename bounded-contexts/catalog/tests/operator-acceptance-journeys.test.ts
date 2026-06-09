import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const journeyDocPath = resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "../docs/catalog-integration-operator-acceptance-journeys.md",
);

describe("Catalog integration operator acceptance journeys", () => {
  const doc = readFileSync(journeyDocPath, "utf8");

  it("keeps every issue-required operator journey in the acceptance matrix", () => {
    const requiredJourneyIds = [
      "J01",
      "J02",
      "J03",
      "J04",
      "J05",
      "J06",
      "J07",
      "J08",
      "J09",
      "J10",
      "J11",
      "J12",
      "J13",
      "J14",
    ];

    for (const journeyId of requiredJourneyIds) {
      expect(doc).toContain(`| ${journeyId} |`);
    }

    expect(doc).toContain("Integration health triage");
    expect(doc).toContain("Draft profile creation");
    expect(doc).toContain("Guided section editing");
    expect(doc).toContain("Fixture validation failure");
    expect(doc).toContain("Dry-run evidence review");
    expect(doc).toContain("Semantic profile comparison");
    expect(doc).toContain("Activation readiness blocked");
    expect(doc).toContain("Provider import and job diagnostics");
    expect(doc).toContain("Source Observation provenance review");
    expect(doc).toContain("Promote, reject, or defer observations");
    expect(doc).toContain("Reapply mapping changes");
    expect(doc).toContain("Bad activation rollback");
    expect(doc).toContain("Retirement and deprecation");
    expect(doc).toContain("Audit and release evidence");
  });

  it("requires happy-path, failure, recovery, destructive, and audit evidence before signoff", () => {
    expect(doc).toContain("happy path");
    expect(doc).toContain("failure");
    expect(doc).toContain("recovery");
    expect(doc).toContain("destructive recovery");
    expect(doc).toContain("audit");
    expect(doc).toContain("At least three failure/recovery paths");
    expect(doc).toContain("Any raw JSON editor or profile snapshot workaround discovered during acceptance");
    expect(doc).toContain("post-merge deploy or no-runtime-deploy verification result");
  });

  it("anchors acceptance to existing automated operator coverage", () => {
    expect(doc).toContain("deployables/admin-web/e2e/catalog-integrations.spec.ts");
    expect(doc).toContain("integration-management-page.test.tsx");
    expect(doc).toContain("provider-profile-sections.test.ts");
    expect(doc).toContain("route.test.ts");
    expect(doc).toContain("runtime.test.ts");
  });
});
