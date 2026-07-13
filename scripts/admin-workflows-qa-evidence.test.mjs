import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  ADMIN_WORKFLOWS_QA_ACCESS_REQUIRED_COVERAGE,
  ADMIN_WORKFLOWS_QA_AUTH_SHELL_RBAC_REQUIRED_COVERAGE,
  ADMIN_WORKFLOWS_QA_CATALOG_INTEGRATIONS_REQUIRED_COVERAGE,
  ADMIN_WORKFLOWS_QA_CATALOG_MODELING_REQUIRED_COVERAGE,
  ADMIN_WORKFLOWS_QA_CROSS_CUTTING_REQUIRED_FIELDS,
  ADMIN_WORKFLOWS_QA_EVIDENCE_VERSION,
  ADMIN_WORKFLOWS_QA_PROJECTION_OPERATIONS_REQUIRED_COVERAGE,
  ADMIN_WORKFLOWS_QA_REQUIRED_ACTOR_MATRIX,
  buildAdminWorkflowsQaAccessEvidenceScaffold,
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

  it("accepts structured automation evidence for cross-cutting coverage", async () => {
    const directory = await mkdtemp(join(tmpdir(), "chase-sets-admin-qa-evidence-"));
    const evidenceFile = join(directory, "issue-3027.json");
    await writeFile(
      evidenceFile,
      JSON.stringify(
        {
          environment: "staging admin-web",
          actorAlias: "admin-qa-catalog-admin",
          signInHost: "/catalog/sign-in",
          records: [
            {
              routeTemplate: "/api/catalog/source-observations/integration-jobs/:jobId/events",
              expectedBehavior: "SSE opens or returns controlled authorization/not-found response.",
              observedBehavior: "Controlled JSON response with no host HTML fallback.",
              artifactFolder: "artifacts/admin-qa/3027/catalog-integration-job-stream",
              redactionReview: "passed",
              securityPiiReview: "no raw ids, cookies, tokens, emails, or full URLs recorded",
              viewports: ["desktop-1280x900", "mobile-390x900"],
              stateChecks: ["loading", "controlled-unavailable"],
            },
          ],
        },
        null,
        2,
      ),
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
        coveredFields: [
          "actorAlias",
          "environment",
          "evidenceArtifact",
          "expected",
          "observed",
          "redactionReview",
          "responsiveCoverage",
          "routeOrWorkflow",
          "securityPiiReview",
          "signInHost",
          "stateCoverage",
        ],
        missingFields: [],
      },
    });
  });

  it("passes complete support-safe actor matrix evidence", async () => {
    const directory = await mkdtemp(join(tmpdir(), "chase-sets-admin-qa-evidence-"));
    const evidenceFile = join(directory, "issue-3016.md");
    await writeFile(
      evidenceFile,
      ADMIN_WORKFLOWS_QA_REQUIRED_ACTOR_MATRIX.map(({ actorAlias, signInHost }) =>
        [
          "Environment: staging admin-web",
          `Actor alias: ${actorAlias}`,
          `Sign-in host: ${signInHost}`,
          "Route or workflow: section landing and account-select check",
          "Expected: actor reaches the intended admin host with support-safe account selection.",
          "Observed: browser evidence captured with aliases only.",
          `Evidence artifact: artifacts/admin-qa/3016/${actorAlias}`,
          "Redaction review: passed",
          "Follow-up issue: none",
        ].join("\n"),
      ).join("\n\n"),
    );

    const evidence = await runAdminWorkflowsQaEvidence({
      evidenceFiles: [evidenceFile],
      environment: "staging",
      issue: "3016",
      checkedAt,
      requireActorMatrixCoverage: true,
    });

    expect(evidence).toMatchObject({
      verdict: "pass",
      actorMatrix: {
        mode: "actor-matrix-coverage",
        status: "pass",
        requiredActors: ADMIN_WORKFLOWS_QA_REQUIRED_ACTOR_MATRIX,
        coveredActors: ADMIN_WORKFLOWS_QA_REQUIRED_ACTOR_MATRIX,
        missingActors: [],
        hostMismatches: [],
      },
    });
  });

  it("accepts structured actor matrix evidence from automation packets", async () => {
    const directory = await mkdtemp(join(tmpdir(), "chase-sets-admin-qa-evidence-"));
    const evidenceFile = join(directory, "issue-3016.json");
    await writeFile(
      evidenceFile,
      JSON.stringify({
        environment: "staging admin-web",
        results: ADMIN_WORKFLOWS_QA_REQUIRED_ACTOR_MATRIX.map(({ actorAlias, signInHost }) => ({
          actorAlias,
          signInHost,
          routeTemplate: signInHost,
          observedBehavior: "signed in with support-safe alias evidence",
          artifactFolder: `artifacts/admin-qa/3016/${actorAlias}`,
        })),
      }),
    );

    const evidence = await runAdminWorkflowsQaEvidence({
      evidenceFiles: [evidenceFile],
      checkedAt,
      requireActorMatrixCoverage: true,
    });

    expect(evidence.verdict).toBe("pass");
    expect(evidence.actorMatrix.coveredActors.map((actor) => actor.actorAlias)).toEqual(
      ADMIN_WORKFLOWS_QA_REQUIRED_ACTOR_MATRIX.map((actor) => actor.actorAlias),
    );
  });

  it("fails actor matrix evidence when aliases or sign-in hosts are missing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "chase-sets-admin-qa-evidence-"));
    const evidenceFile = join(directory, "issue-3016.md");
    await writeFile(
      evidenceFile,
      [
        "Environment: staging admin-web",
        "Actor alias: admin-qa-platform-admin",
        "Sign-in host: /catalog/sign-in",
        "Observed: wrong host captured.",
      ].join("\n"),
    );

    const evidence = await runAdminWorkflowsQaEvidence({
      evidenceFiles: [evidenceFile],
      checkedAt,
      requireActorMatrixCoverage: true,
    });

    expect(evidence.verdict).toBe("fail");
    expect(evidence.actorMatrix).toMatchObject({
      status: "fail",
      missingActors: ADMIN_WORKFLOWS_QA_REQUIRED_ACTOR_MATRIX.slice(1).map((actor) => ({
        ...actor,
        severity: "blocker",
      })),
      hostMismatches: [
        {
          actorAlias: "admin-qa-platform-admin",
          expectedSignInHost: "/access/sign-in",
          observedSignInHosts: ["/catalog/sign-in"],
          severity: "blocker",
        },
      ],
    });
    expect(evidence.guidance).toContain(
      "Add the missing support-safe actor aliases and intended sign-in hosts before closing #3016.",
    );
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

  it("passes complete catalog modeling coverage evidence", async () => {
    const directory = await mkdtemp(join(tmpdir(), "chase-sets-admin-qa-evidence-"));
    const evidenceFile = join(directory, "issue-3021.md");
    await writeFile(
      evidenceFile,
      [
        "Environment: staging admin-web",
        "Actor alias: admin-qa-catalog-admin",
        "Sign-in host: /catalog/sign-in",
        "Route or workflow: Catalog modeling checklist",
        "Expected: every modeling checklist row has deployed browser evidence.",
        "Observed: artifact packet captured with support-safe aliases only.",
        "Evidence artifact: artifacts/admin-qa/3021/catalog-modeling",
        "Redaction review: passed",
        ...ADMIN_WORKFLOWS_QA_CATALOG_MODELING_REQUIRED_COVERAGE.map(({ key }) => `Catalog modeling coverage: ${key}`),
      ].join("\n"),
    );

    const evidence = await runAdminWorkflowsQaEvidence({
      evidenceFiles: [evidenceFile],
      environment: "staging",
      issue: "3021",
      checkedAt,
      requireCatalogModelingCoverage: true,
    });

    expect(evidence).toMatchObject({
      verdict: "pass",
      catalogModeling: {
        mode: "catalog-modeling-coverage",
        status: "pass",
        requiredCoverage: ADMIN_WORKFLOWS_QA_CATALOG_MODELING_REQUIRED_COVERAGE,
        coveredCoverage: ADMIN_WORKFLOWS_QA_CATALOG_MODELING_REQUIRED_COVERAGE.map(({ key }) => key).sort(),
        missingCoverage: [],
      },
    });
  });

  it("accepts structured catalog modeling coverage packets", async () => {
    const directory = await mkdtemp(join(tmpdir(), "chase-sets-admin-qa-evidence-"));
    const evidenceFile = join(directory, "issue-3021.json");
    await writeFile(
      evidenceFile,
      JSON.stringify(
        {
          environment: "staging admin-web",
          actorAlias: "admin-qa-catalog-admin",
          signInHost: "/catalog/sign-in",
          records: [
            {
              routeTemplate: "/catalog/modeling",
              catalogModelingCoverage: ADMIN_WORKFLOWS_QA_CATALOG_MODELING_REQUIRED_COVERAGE.map(({ key }) => key),
              artifactFolder: "artifacts/admin-qa/3021/catalog-modeling",
            },
          ],
        },
        null,
        2,
      ),
    );

    const evidence = await runAdminWorkflowsQaEvidence({
      evidenceFiles: [evidenceFile],
      checkedAt,
      requireCatalogModelingCoverage: true,
    });

    expect(evidence.verdict).toBe("pass");
    expect(evidence.catalogModeling.missingCoverage).toEqual([]);
  });

  it("fails catalog modeling evidence when checklist coverage is incomplete", async () => {
    const directory = await mkdtemp(join(tmpdir(), "chase-sets-admin-qa-evidence-"));
    const evidenceFile = join(directory, "issue-3021.md");
    await writeFile(
      evidenceFile,
      [
        "Environment: staging admin-web",
        "Actor alias: admin-qa-catalog-admin",
        "Sign-in host: /catalog/sign-in",
        "Catalog modeling coverage: primitive:dimensions",
        "Catalog modeling coverage: lifecycle:create-draft",
      ].join("\n"),
    );

    const evidence = await runAdminWorkflowsQaEvidence({
      evidenceFiles: [evidenceFile],
      checkedAt,
      requireCatalogModelingCoverage: true,
    });

    expect(evidence.verdict).toBe("fail");
    expect(evidence.catalogModeling).toMatchObject({
      mode: "catalog-modeling-coverage",
      status: "fail",
      missingCoverage: ADMIN_WORKFLOWS_QA_CATALOG_MODELING_REQUIRED_COVERAGE.filter(
        ({ key }) => !["primitive:dimensions", "lifecycle:create-draft"].includes(key),
      ).map((coverage) => ({
        ...coverage,
        severity: "blocker",
      })),
    });
    expect(evidence.guidance).toContain(
      "Add the missing catalog modeling coverage keys before using this packet to close #3021.",
    );
  });

  it("passes complete projection operations coverage evidence", async () => {
    const directory = await mkdtemp(join(tmpdir(), "chase-sets-admin-qa-evidence-"));
    const evidenceFile = join(directory, "issue-3026.md");
    await writeFile(
      evidenceFile,
      [
        "Environment: staging admin-web",
        "Actor alias: admin-qa-security-manage",
        "Sign-in host: /access/sign-in",
        "Route or workflow: Platform projection operations checklist",
        "Expected: projection operations destructive checks use a disposable projection.",
        "Observed: evidence packet captured with support-safe projection alias only.",
        "Evidence artifact: artifacts/admin-qa/3026/projection-operations",
        "Redaction review: passed",
        ...ADMIN_WORKFLOWS_QA_PROJECTION_OPERATIONS_REQUIRED_COVERAGE.map(
          ({ key }) => `Projection operations coverage: ${key}`,
        ),
      ].join("\n"),
    );

    const evidence = await runAdminWorkflowsQaEvidence({
      evidenceFiles: [evidenceFile],
      environment: "staging",
      issue: "3026",
      checkedAt,
      requireProjectionOperationsCoverage: true,
    });

    expect(evidence).toMatchObject({
      verdict: "pass",
      projectionOperations: {
        mode: "projection-operations-coverage",
        status: "pass",
        requiredCoverage: ADMIN_WORKFLOWS_QA_PROJECTION_OPERATIONS_REQUIRED_COVERAGE,
        coveredCoverage: ADMIN_WORKFLOWS_QA_PROJECTION_OPERATIONS_REQUIRED_COVERAGE.map(({ key }) => key).sort(),
        missingCoverage: [],
      },
    });
  });

  it("accepts structured projection operations coverage packets", async () => {
    const directory = await mkdtemp(join(tmpdir(), "chase-sets-admin-qa-evidence-"));
    const evidenceFile = join(directory, "issue-3026.json");
    await writeFile(
      evidenceFile,
      JSON.stringify(
        {
          environment: "staging admin-web",
          actorAlias: "admin-qa-security-manage",
          signInHost: "/access/sign-in",
          records: [
            {
              routeTemplate: "/platform/projections",
              projectionOperationsCoverage: ADMIN_WORKFLOWS_QA_PROJECTION_OPERATIONS_REQUIRED_COVERAGE.map(
                ({ key }) => key,
              ),
              artifactFolder: "artifacts/admin-qa/3026/projection-operations",
            },
          ],
        },
        null,
        2,
      ),
    );

    const evidence = await runAdminWorkflowsQaEvidence({
      evidenceFiles: [evidenceFile],
      checkedAt,
      requireProjectionOperationsCoverage: true,
    });

    expect(evidence.verdict).toBe("pass");
    expect(evidence.projectionOperations.missingCoverage).toEqual([]);
  });

  it("fails projection operations evidence when destructive coverage is incomplete", async () => {
    const directory = await mkdtemp(join(tmpdir(), "chase-sets-admin-qa-evidence-"));
    const evidenceFile = join(directory, "issue-3026.md");
    await writeFile(
      evidenceFile,
      [
        "Environment: staging admin-web",
        "Actor alias: admin-qa-security-manage",
        "Sign-in host: /access/sign-in",
        "Projection operations coverage: projection-ops:status-stats",
        "Projection operations coverage: projection-ops:tab-overview",
      ].join("\n"),
    );

    const evidence = await runAdminWorkflowsQaEvidence({
      evidenceFiles: [evidenceFile],
      checkedAt,
      requireProjectionOperationsCoverage: true,
    });

    expect(evidence.verdict).toBe("fail");
    expect(evidence.projectionOperations).toMatchObject({
      mode: "projection-operations-coverage",
      status: "fail",
      missingCoverage: ADMIN_WORKFLOWS_QA_PROJECTION_OPERATIONS_REQUIRED_COVERAGE.filter(
        ({ key }) => !["projection-ops:status-stats", "projection-ops:tab-overview"].includes(key),
      ).map((coverage) => ({
        ...coverage,
        severity: "blocker",
      })),
    });
    expect(evidence.guidance).toContain(
      "Add the missing projection operations coverage keys before using this packet to close #3026.",
    );
  });

  it("passes complete Access coverage evidence", async () => {
    const directory = await mkdtemp(join(tmpdir(), "chase-sets-admin-qa-evidence-"));
    const evidenceFile = join(directory, "issue-3020.md");
    await writeFile(
      evidenceFile,
      [
        "Environment: staging admin-web",
        "Actor alias: admin-qa-security-manage",
        "Sign-in host: /access/sign-in",
        "Route or workflow: Access section checklist",
        "Expected: Access lifecycle checks use approved staging fixtures.",
        "Observed: evidence packet captured with support-safe aliases only.",
        "Evidence artifact: artifacts/admin-qa/3020/access-section",
        "Redaction review: passed",
        ...ADMIN_WORKFLOWS_QA_ACCESS_REQUIRED_COVERAGE.map(({ key }) => `Access coverage: ${key}`),
      ].join("\n"),
    );

    const evidence = await runAdminWorkflowsQaEvidence({
      evidenceFiles: [evidenceFile],
      environment: "staging",
      issue: "3020",
      checkedAt,
      requireAccessCoverage: true,
    });

    expect(evidence).toMatchObject({
      verdict: "pass",
      access: {
        mode: "access-coverage",
        status: "pass",
        requiredCoverage: ADMIN_WORKFLOWS_QA_ACCESS_REQUIRED_COVERAGE,
        coveredCoverage: ADMIN_WORKFLOWS_QA_ACCESS_REQUIRED_COVERAGE.map(({ key }) => key).sort(),
        missingCoverage: [],
      },
    });
  });

  it("accepts structured Access coverage packets", async () => {
    const directory = await mkdtemp(join(tmpdir(), "chase-sets-admin-qa-evidence-"));
    const evidenceFile = join(directory, "issue-3020.json");
    await writeFile(
      evidenceFile,
      JSON.stringify(
        {
          environment: "staging admin-web",
          actorAlias: "admin-qa-security-manage",
          signInHost: "/access/sign-in",
          records: [
            {
              routeTemplate: "/access",
              accessCoverage: ADMIN_WORKFLOWS_QA_ACCESS_REQUIRED_COVERAGE.map(({ key }) => key),
              artifactFolder: "artifacts/admin-qa/3020/access-section",
            },
          ],
        },
        null,
        2,
      ),
    );

    const evidence = await runAdminWorkflowsQaEvidence({
      evidenceFiles: [evidenceFile],
      checkedAt,
      requireAccessCoverage: true,
    });

    expect(evidence.verdict).toBe("pass");
    expect(evidence.access.missingCoverage).toEqual([]);
  });

  it("fails Access evidence when lifecycle coverage is incomplete", async () => {
    const directory = await mkdtemp(join(tmpdir(), "chase-sets-admin-qa-evidence-"));
    const evidenceFile = join(directory, "issue-3020.md");
    await writeFile(
      evidenceFile,
      [
        "Environment: staging admin-web",
        "Actor alias: admin-qa-security-manage",
        "Sign-in host: /access/sign-in",
        "Access coverage: access:accounts-suspend",
        "Access coverage: access:api-keys-create",
      ].join("\n"),
    );

    const evidence = await runAdminWorkflowsQaEvidence({
      evidenceFiles: [evidenceFile],
      checkedAt,
      requireAccessCoverage: true,
    });

    expect(evidence.verdict).toBe("fail");
    expect(evidence.access).toMatchObject({
      mode: "access-coverage",
      status: "fail",
      missingCoverage: ADMIN_WORKFLOWS_QA_ACCESS_REQUIRED_COVERAGE.filter(
        ({ key }) => !["access:accounts-suspend", "access:api-keys-create"].includes(key),
      ).map((coverage) => ({
        ...coverage,
        severity: "blocker",
      })),
    });
    expect(evidence.guidance).toContain(
      "Add the missing Access coverage keys before using this packet to close #3020.",
    );
  });

  it("scaffolds a fill-in-the-blanks Access evidence packet covering every required key", () => {
    const scaffold = buildAdminWorkflowsQaAccessEvidenceScaffold();

    for (const coverage of ADMIN_WORKFLOWS_QA_ACCESS_REQUIRED_COVERAGE) {
      expect(scaffold).toContain(`Access coverage: ${coverage.key}`);
      expect(scaffold).toContain(`Actor alias: ${coverage.suggestedActorAlias}`);
    }
    expect(scaffold).not.toMatch(/\n{3,}/);
  });

  it("produces a scaffold that passes the redaction scan and only fails on TODO placeholders", async () => {
    const directory = await mkdtemp(join(tmpdir(), "chase-sets-admin-qa-evidence-"));
    const evidenceFile = join(directory, "issue-3020-scaffold.md");
    await writeFile(evidenceFile, buildAdminWorkflowsQaAccessEvidenceScaffold());

    const evidence = await runAdminWorkflowsQaEvidence({
      evidenceFiles: [evidenceFile],
      checkedAt,
      requireAccessCoverage: true,
    });

    expect(evidence.files[0]).toMatchObject({ status: "pass", findings: [] });
    expect(evidence.access).toMatchObject({ status: "pass", missingCoverage: [] });
  });

  it("parses the --scaffold-access CLI flag and its environment fallback", () => {
    expect(parseAdminWorkflowsQaEvidenceArgs(["--scaffold-access"], {})).toMatchObject({
      scaffoldAccess: true,
    });
    expect(parseAdminWorkflowsQaEvidenceArgs([], { ADMIN_WORKFLOWS_QA_SCAFFOLD_ACCESS: "true" })).toMatchObject({
      scaffoldAccess: true,
    });
    expect(parseAdminWorkflowsQaEvidenceArgs([], {})).toMatchObject({
      scaffoldAccess: false,
    });
  });

  it("passes complete catalog integrations coverage evidence", async () => {
    const directory = await mkdtemp(join(tmpdir(), "chase-sets-admin-qa-evidence-"));
    const evidenceFile = join(directory, "issue-3022.md");
    await writeFile(
      evidenceFile,
      [
        "Environment: staging catalog-admin",
        "Actor alias: admin-qa-catalog-admin",
        "Sign-in host: /catalog/sign-in",
        "Route or workflow: Catalog integrations checklist",
        "Expected: Provider integration checks use approved staging fixtures.",
        "Observed: evidence packet captured with support-safe aliases only.",
        "Evidence artifact: artifacts/admin-qa/3022/catalog-integrations",
        "Redaction review: passed",
        ...ADMIN_WORKFLOWS_QA_CATALOG_INTEGRATIONS_REQUIRED_COVERAGE.map(
          ({ key }) => `Catalog integrations coverage: ${key}`,
        ),
      ].join("\n"),
    );

    const evidence = await runAdminWorkflowsQaEvidence({
      evidenceFiles: [evidenceFile],
      environment: "staging",
      issue: "3022",
      checkedAt,
      requireCatalogIntegrationsCoverage: true,
    });

    expect(evidence).toMatchObject({
      verdict: "pass",
      catalogIntegrations: {
        mode: "catalog-integrations-coverage",
        status: "pass",
        requiredCoverage: ADMIN_WORKFLOWS_QA_CATALOG_INTEGRATIONS_REQUIRED_COVERAGE,
        coveredCoverage: ADMIN_WORKFLOWS_QA_CATALOG_INTEGRATIONS_REQUIRED_COVERAGE.map(({ key }) => key).sort(),
        missingCoverage: [],
      },
    });
  });

  it("accepts structured catalog integrations coverage packets", async () => {
    const directory = await mkdtemp(join(tmpdir(), "chase-sets-admin-qa-evidence-"));
    const evidenceFile = join(directory, "issue-3022.json");
    await writeFile(
      evidenceFile,
      JSON.stringify(
        {
          environment: "staging catalog-admin",
          actorAlias: "admin-qa-catalog-admin",
          signInHost: "/catalog/sign-in",
          records: [
            {
              routeTemplate: "/catalog/source-observations",
              catalogIntegrationsCoverage: ADMIN_WORKFLOWS_QA_CATALOG_INTEGRATIONS_REQUIRED_COVERAGE.map(
                ({ key }) => key,
              ),
              artifactFolder: "artifacts/admin-qa/3022/catalog-integrations",
            },
          ],
        },
        null,
        2,
      ),
    );

    const evidence = await runAdminWorkflowsQaEvidence({
      evidenceFiles: [evidenceFile],
      checkedAt,
      requireCatalogIntegrationsCoverage: true,
    });

    expect(evidence.verdict).toBe("pass");
    expect(evidence.catalogIntegrations.missingCoverage).toEqual([]);
  });

  it("fails catalog integrations evidence when provider workflow coverage is incomplete", async () => {
    const directory = await mkdtemp(join(tmpdir(), "chase-sets-admin-qa-evidence-"));
    const evidenceFile = join(directory, "issue-3022.md");
    await writeFile(
      evidenceFile,
      [
        "Environment: staging catalog-admin",
        "Actor alias: admin-qa-catalog-admin",
        "Sign-in host: /catalog/sign-in",
        "Catalog integrations coverage: catalog-integrations:provider-tcgplayer-import",
        "Catalog integrations coverage: catalog-integrations:review-observations",
      ].join("\n"),
    );

    const evidence = await runAdminWorkflowsQaEvidence({
      evidenceFiles: [evidenceFile],
      checkedAt,
      requireCatalogIntegrationsCoverage: true,
    });

    expect(evidence.verdict).toBe("fail");
    expect(evidence.catalogIntegrations).toMatchObject({
      mode: "catalog-integrations-coverage",
      status: "fail",
      missingCoverage: ADMIN_WORKFLOWS_QA_CATALOG_INTEGRATIONS_REQUIRED_COVERAGE.filter(
        ({ key }) =>
          !["catalog-integrations:provider-tcgplayer-import", "catalog-integrations:review-observations"].includes(key),
      ).map((coverage) => ({
        ...coverage,
        severity: "blocker",
      })),
    });
    expect(evidence.guidance).toContain(
      "Add the missing catalog integrations coverage keys before using this packet to close #3022.",
    );
  });

  it("passes complete auth shell RBAC coverage evidence", async () => {
    const directory = await mkdtemp(join(tmpdir(), "chase-sets-admin-qa-evidence-"));
    const evidenceFile = join(directory, "issue-3019.md");
    await writeFile(
      evidenceFile,
      [
        "Environment: staging admin-web",
        "Actor alias: admin-qa-platform-admin",
        "Sign-in host: /access/sign-in",
        "Route or workflow: Auth shell RBAC checklist",
        "Expected: Auth, shell, and RBAC checks use approved staging fixtures.",
        "Observed: evidence packet captured with support-safe aliases only.",
        "Evidence artifact: artifacts/admin-qa/3019/auth-shell-rbac",
        "Redaction review: passed",
        ...ADMIN_WORKFLOWS_QA_AUTH_SHELL_RBAC_REQUIRED_COVERAGE.map(({ key }) => `Auth shell RBAC coverage: ${key}`),
      ].join("\n"),
    );

    const evidence = await runAdminWorkflowsQaEvidence({
      evidenceFiles: [evidenceFile],
      environment: "staging",
      issue: "3019",
      checkedAt,
      requireAuthShellRbacCoverage: true,
    });

    expect(evidence).toMatchObject({
      verdict: "pass",
      authShellRbac: {
        mode: "auth-shell-rbac-coverage",
        status: "pass",
        requiredCoverage: ADMIN_WORKFLOWS_QA_AUTH_SHELL_RBAC_REQUIRED_COVERAGE,
        coveredCoverage: ADMIN_WORKFLOWS_QA_AUTH_SHELL_RBAC_REQUIRED_COVERAGE.map(({ key }) => key).sort(),
        missingCoverage: [],
      },
    });
  });

  it("accepts structured auth shell RBAC coverage packets", async () => {
    const directory = await mkdtemp(join(tmpdir(), "chase-sets-admin-qa-evidence-"));
    const evidenceFile = join(directory, "issue-3019.json");
    await writeFile(
      evidenceFile,
      JSON.stringify(
        {
          environment: "staging admin-web",
          actorAlias: "admin-qa-platform-admin",
          signInHost: "/access/sign-in",
          records: [
            {
              routeTemplate: "/",
              authShellRbacCoverage: ADMIN_WORKFLOWS_QA_AUTH_SHELL_RBAC_REQUIRED_COVERAGE.map(({ key }) => key),
              artifactFolder: "artifacts/admin-qa/3019/auth-shell-rbac",
            },
          ],
        },
        null,
        2,
      ),
    );

    const evidence = await runAdminWorkflowsQaEvidence({
      evidenceFiles: [evidenceFile],
      checkedAt,
      requireAuthShellRbacCoverage: true,
    });

    expect(evidence.verdict).toBe("pass");
    expect(evidence.authShellRbac.missingCoverage).toEqual([]);
  });

  it("fails auth shell RBAC evidence when sign-in method or RBAC role coverage is incomplete", async () => {
    const directory = await mkdtemp(join(tmpdir(), "chase-sets-admin-qa-evidence-"));
    const evidenceFile = join(directory, "issue-3019.md");
    await writeFile(
      evidenceFile,
      [
        "Environment: staging admin-web",
        "Actor alias: admin-qa-platform-admin",
        "Sign-in host: /access/sign-in",
        "Auth shell RBAC coverage: auth-shell-rbac:sign-in-password-access-host",
        "Auth shell RBAC coverage: auth-shell-rbac:rbac-role-platform-admin",
      ].join("\n"),
    );

    const evidence = await runAdminWorkflowsQaEvidence({
      evidenceFiles: [evidenceFile],
      checkedAt,
      requireAuthShellRbacCoverage: true,
    });

    expect(evidence.verdict).toBe("fail");
    expect(evidence.authShellRbac).toMatchObject({
      mode: "auth-shell-rbac-coverage",
      status: "fail",
      missingCoverage: ADMIN_WORKFLOWS_QA_AUTH_SHELL_RBAC_REQUIRED_COVERAGE.filter(
        ({ key }) =>
          !["auth-shell-rbac:sign-in-password-access-host", "auth-shell-rbac:rbac-role-platform-admin"].includes(key),
      ).map((coverage) => ({
        ...coverage,
        severity: "blocker",
      })),
    });
    expect(evidence.guidance).toContain(
      "Add the missing auth shell RBAC coverage keys before using this packet to close #3019.",
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
      ADMIN_WORKFLOWS_QA_REQUIRE_ACTOR_MATRIX_COVERAGE: "true",
      ADMIN_WORKFLOWS_QA_REQUIRE_CATALOG_MODELING_COVERAGE: "true",
      ADMIN_WORKFLOWS_QA_REQUIRE_PROJECTION_OPERATIONS_COVERAGE: "true",
      ADMIN_WORKFLOWS_QA_REQUIRE_ACCESS_COVERAGE: "true",
      ADMIN_WORKFLOWS_QA_REQUIRE_CATALOG_INTEGRATIONS_COVERAGE: "true",
      ADMIN_WORKFLOWS_QA_REQUIRE_AUTH_SHELL_RBAC_COVERAGE: "true",
    });

    expect(parsed).toMatchObject({
      evidenceFiles: ["one.md", "two.json", "three.md", "four.json"],
      outPath: "artifacts/admin-qa-evidence.json",
      environment: "staging",
      issue: "#3027",
      requireCrossCuttingCoverage: true,
      requireActorMatrixCoverage: true,
      requireCatalogModelingCoverage: true,
      requireProjectionOperationsCoverage: true,
      requireAccessCoverage: true,
      requireCatalogIntegrationsCoverage: true,
      requireAuthShellRbacCoverage: true,
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
