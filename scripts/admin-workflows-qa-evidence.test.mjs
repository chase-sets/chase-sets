import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  ADMIN_WORKFLOWS_QA_CROSS_CUTTING_REQUIRED_FIELDS,
  ADMIN_WORKFLOWS_QA_EVIDENCE_VERSION,
  findAdminWorkflowsQaEvidenceFindings,
  parseAdminWorkflowsQaEvidenceArgs,
  runAdminWorkflowsQaEvidence,
} from "./admin-workflows-qa-evidence.mjs";

const checkedAt = "2026-06-30T17:30:00.000Z";

describe("admin workflows QA evidence", () => {
  it("passes support-safe public evidence", async () => {
    const directory = await mkdtemp(join(tmpdir(), "chase-sets-admin-qa-evidence-"));
    const evidenceFile = join(directory, "issue-3027.md");
    await writeFile(
      evidenceFile,
      [
        "Environment: staging admin-web",
        "Actor alias: admin-qa-platform-admin",
        "Route or workflow: /platform/projections/:operationId/events",
        "Observed: event stream opened or returned controlled JSON.",
        "Evidence artifact: artifacts/admin-qa/3027/account-realtime",
      ].join("\n"),
    );

    const evidence = await runAdminWorkflowsQaEvidence({
      evidenceFiles: [evidenceFile],
      environment: "staging",
      issue: "3027",
      checkedAt,
    });

    expect(evidence).toMatchObject({
      schemaVersion: ADMIN_WORKFLOWS_QA_EVIDENCE_VERSION,
      checkedAt,
      environment: "staging",
      issue: "#3027",
      verdict: "pass",
      summary: {
        email: 0,
        cookie_or_session: 0,
        authorization_token: 0,
        raw_recovery_token: 0,
        raw_domain_id: 0,
        full_url: 0,
      },
      files: [
        {
          path: "issue-3027.md",
          status: "pass",
          findings: [],
        },
      ],
      completeness: {
        mode: "redaction-only",
        status: "pass",
        requiredFields: [],
        missingFields: [],
      },
    });
  });

  it("passes complete cross-cutting responsive and state evidence", async () => {
    const directory = await mkdtemp(join(tmpdir(), "chase-sets-admin-qa-evidence-"));
    const evidenceFile = join(directory, "issue-3027.md");
    await writeFile(
      evidenceFile,
      [
        "Environment: staging admin-web",
        "Actor alias: admin-qa-platform-admin",
        "Sign-in host: /access/sign-in",
        "Route or workflow: /platform/projections/:operationId/events",
        "Expected: route returns controlled JSON or event stream.",
        "Observed: controlled JSON response; no host HTML fallback.",
        "Evidence artifact: artifacts/admin-qa/3027/platform-projection-events",
        "Redaction review: passed",
        "Security/PII review: no raw ids, cookies, tokens, emails, or full URLs recorded.",
        "Responsive coverage: desktop 1280x900 and mobile 390x900 screenshots captured.",
        "State coverage: empty, error, and loading states captured or marked controlled-unavailable.",
      ].join("\n"),
    );

    const evidence = await runAdminWorkflowsQaEvidence({
      evidenceFiles: [evidenceFile],
      environment: "staging",
      issue: "3027",
      checkedAt,
      requireCrossCuttingCoverage: true,
    });

    expect(evidence).toMatchObject({
      verdict: "pass",
      completeness: {
        mode: "cross-cutting-coverage",
        status: "pass",
        requiredFields: ADMIN_WORKFLOWS_QA_CROSS_CUTTING_REQUIRED_FIELDS.map(({ key, labels }) => ({
          key,
          labels,
        })),
        missingFields: [],
      },
    });
  });

  it("fails strict cross-cutting evidence when responsive or state coverage is missing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "chase-sets-admin-qa-evidence-"));
    const evidenceFile = join(directory, "issue-3027.md");
    await writeFile(
      evidenceFile,
      [
        "Environment: staging admin-web",
        "Actor alias: admin-qa-platform-admin",
        "Sign-in host: /access/sign-in",
        "Route or workflow: /platform/projections/:operationId/events",
        "Expected: route returns controlled JSON or event stream.",
        "Observed: controlled JSON response; no host HTML fallback.",
        "Evidence artifact: artifacts/admin-qa/3027/platform-projection-events",
        "Redaction review: passed",
        "Security/PII review: no raw ids, cookies, tokens, emails, or full URLs recorded.",
      ].join("\n"),
    );

    const evidence = await runAdminWorkflowsQaEvidence({
      evidenceFiles: [evidenceFile],
      checkedAt,
      requireCrossCuttingCoverage: true,
    });

    expect(evidence.verdict).toBe("fail");
    expect(evidence.completeness).toMatchObject({
      mode: "cross-cutting-coverage",
      status: "fail",
      missingFields: [
        {
          key: "responsiveCoverage",
          severity: "blocker",
        },
        {
          key: "stateCoverage",
          severity: "blocker",
        },
      ],
    });
    expect(evidence.guidance).toContain(
      "Add the missing cross-cutting evidence fields before using this packet to close #3027.",
    );
  });

  it("finds sensitive evidence categories without returning raw matched values", async () => {
    const directory = await mkdtemp(join(tmpdir(), "chase-sets-admin-qa-evidence-"));
    const evidenceFile = join(directory, "unsafe.md");
    await writeFile(
      evidenceFile,
      [
        "Actor email: operator@example.com",
        "Cookie: chase_sets_session=secret-session",
        "Authorization: Bearer raw-token-value",
        "Route: https://admin.chasesets.test/access/accounts/account_01KXYZ99999999999999999999?afterWrite=raw",
        "Payment: pay_01KXYZ99999999999999999999",
      ].join("\n"),
    );

    const evidence = await runAdminWorkflowsQaEvidence({
      evidenceFiles: [evidenceFile],
      checkedAt,
    });
    const serialized = JSON.stringify(evidence);

    expect(evidence.verdict).toBe("fail");
    expect(evidence.summary).toMatchObject({
      email: 1,
      cookie_or_session: 1,
      authorization_token: 1,
      raw_recovery_token: 1,
      raw_domain_id: 2,
      full_url: 1,
    });
    expect(evidence.files[0].findings.map((finding) => finding.category)).toEqual([
      "email",
      "cookie_or_session",
      "authorization_token",
      "raw_recovery_token",
      "raw_domain_id",
      "full_url",
      "raw_domain_id",
    ]);
    expect(serialized).not.toContain("operator@example.com");
    expect(serialized).not.toContain("secret-session");
    expect(serialized).not.toContain("raw-token-value");
    expect(serialized).not.toContain("account_01KXYZ99999999999999999999");
    expect(serialized).not.toContain("https://admin.chasesets.test");
  });

  it("writes a support-safe report", async () => {
    const directory = await mkdtemp(join(tmpdir(), "chase-sets-admin-qa-evidence-"));
    const evidenceFile = join(directory, "safe.json");
    const outFile = join(directory, "report.json");
    await writeFile(
      evidenceFile,
      JSON.stringify({
        environment: "staging",
        actorAlias: "admin-qa-viewer",
        routeTemplate: "/support/requests/:requestId",
        observed: "denied write returned controlled state",
      }),
    );

    const evidence = await runAdminWorkflowsQaEvidence({
      evidenceFiles: [evidenceFile],
      outPath: outFile,
      checkedAt,
    });

    expect(JSON.parse(await readFile(outFile, "utf8"))).toEqual(evidence);
  });

  it("parses repeated CLI and environment evidence file inputs", () => {
    const parsed = parseAdminWorkflowsQaEvidenceArgs(["--file", "one.md", "--evidence-file", "two.json"], {
      ADMIN_WORKFLOWS_QA_EVIDENCE_FILES: "three.md; four.json",
      ADMIN_WORKFLOWS_QA_EVIDENCE_OUT: "artifacts/admin-qa-evidence.json",
      ADMIN_WORKFLOWS_QA_ENVIRONMENT: "staging",
      ADMIN_WORKFLOWS_QA_ISSUE: "#3027",
      ADMIN_WORKFLOWS_QA_REQUIRE_CROSS_CUTTING_COVERAGE: "true",
    });

    expect(parsed).toMatchObject({
      evidenceFiles: ["one.md", "two.json", "three.md", "four.json"],
      outPath: "artifacts/admin-qa-evidence.json",
      environment: "staging",
      issue: "#3027",
      requireCrossCuttingCoverage: true,
    });
  });

  it("rejects missing evidence files", async () => {
    await expect(runAdminWorkflowsQaEvidence({ evidenceFiles: [] })).rejects.toThrow(
      "At least one --evidence-file is required.",
    );
  });

  it("keeps category detection line-based and support-safe", () => {
    expect(
      findAdminWorkflowsQaEvidenceFindings(
        [
          "Route template /access/accounts/:accountId is safe.",
          "Raw route /access/accounts/account_01KXYZ99999999999999999999 is not.",
        ].join("\n"),
      ),
    ).toEqual([
      {
        category: "raw_domain_id",
        line: 2,
        count: 1,
        severity: "blocker",
      },
    ]);
  });
});
