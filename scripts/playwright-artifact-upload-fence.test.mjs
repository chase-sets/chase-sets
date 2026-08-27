import { describe, expect, it } from "vitest";

import {
  PlaywrightUploadFenceUnknownError,
  auditPullRequestHistory,
  inspectPlaywrightArtifactUploadCorpus,
  scanPlaywrightArtifactUploads,
} from "./playwright-artifact-upload-fence.mjs";

const uploadAction = "actions/upload-artifact@0000000000000000000000000000000000000000";
const shas = ["1", "2", "3"].map((digit) => digit.repeat(40));

function workflowWithUpload(path, { name = "Upload evidence", prefix = "" } = {}) {
  return `${prefix}jobs:
  evidence:
    runs-on: ubuntu-latest
    steps:
      - name: ${name}
        uses: ${uploadAction}
        with:
          path: ${
            path.includes("\n")
              ? `|\n${path
                  .split("\n")
                  .map((line) => `            ${line}`)
                  .join("\n")}`
              : path
          }
`;
}

function fourProducerCorpus() {
  return Object.fromEntries(
    ["platform-pr", "catalog-staging-provider-uat", "platform-production", "platform-staging-advisory-evidence"].map(
      (name) => [
        `.github/workflows/${name}.yml`,
        workflowWithUpload("artifacts/playwright/report\nartifacts/playwright/test-results"),
      ],
    ),
  );
}

function passingGuard(sha) {
  return {
    status: "pass",
    passed: true,
    resolvedRef: sha,
    findings: [],
  };
}

function pull({ commits = 3, headSha = shas[2], branch = "codex/issue-6895" } = {}) {
  return { commits, head: { sha: headSha, ref: branch } };
}

describe("raw Playwright artifact upload fence (#6895)", () => {
  it("tracked Actions corpus has no raw Playwright publication path", () => {
    const result = scanPlaywrightArtifactUploads();

    expect(result.status).toBe("pass");
    expect(result.findings).toEqual([]);
    expect(result.discovery).toMatchObject({
      trackedFiles: 60,
      parsedFiles: 60,
      workflowFiles: 57,
      compositeActionFiles: 3,
    });
    expect(result.discovery.uploadSteps).toBeGreaterThan(0);
    expect(result.discovery.evaluatedUploadPaths).toBeGreaterThan(result.discovery.uploadSteps);
    expect(result.census.files).toHaveLength(result.discovery.trackedFiles);
    expect(result.census.localCompositeCallers).toHaveLength(result.discovery.localCompositeCalls);
    expect(result.uploads.every(({ file, owner, step, callerChain }) => file && owner && step && callerChain)).toBe(
      true,
    );
  });

  it("playwright raw upload fence rejects every incomplete producer set", () => {
    const original = fourProducerCorpus();
    const files = Object.keys(original);

    for (const removedProducerCount of [1, 2, 3]) {
      const mutant = { ...original };
      for (const file of files.slice(0, removedProducerCount)) {
        mutant[file] = mutant[file]
          .replace("artifacts/playwright/report", "artifacts/release-health/probe.json")
          .replace("artifacts/playwright/test-results", "artifacts/staging-advisory-evidence/summary.json");
      }
      const result = inspectPlaywrightArtifactUploadCorpus(mutant);

      expect(result.status).toBe("fail");
      expect(new Set(result.findings.map((finding) => finding.file))).toEqual(
        new Set(files.slice(removedProducerCount)),
      );
    }
  });

  it("resolves YAML aliases, expressions, globs, and local composite callers", () => {
    const corpus = {
      ".github/workflows/alias-expression.yml": `env: &raw-env
  RAW_PARENT: artifacts/playwright
jobs:
  evidence:
    runs-on: ubuntu-latest
    env:
      <<: *raw-env
    steps:
      - &raw-upload
        name: Alias expression upload
        uses: ${uploadAction}
        with:
          path: \${{ env.RAW_PARENT }}/report/**/*.zip
`,
      ".github/workflows/composite-caller.yml": `jobs:
  evidence:
    runs-on: ubuntu-latest
    steps:
      - name: Call local publisher
        uses: ./.github/actions/publish-evidence
        with:
          evidence-path: artifacts/playwright/test-results/**
`,
      ".github/actions/publish-evidence/action.yml": `name: Publish evidence
inputs:
  evidence-path:
    required: true
runs:
  using: composite
  steps:
    - name: Upload from composite
      uses: ${uploadAction}
      with:
        path: \${{ inputs.evidence-path }}
`,
    };

    const result = inspectPlaywrightArtifactUploadCorpus(corpus);

    expect(result.status).toBe("fail");
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          file: ".github/workflows/alias-expression.yml",
          rawRoot: "artifacts/playwright/report",
        }),
        expect.objectContaining({
          file: ".github/actions/publish-evidence/action.yml",
          rawRoot: "artifacts/playwright/test-results",
          callerChain: [expect.stringContaining("composite-caller.yml")],
        }),
      ]),
    );
    expect(result.discovery.localCompositeCalls).toBe(1);
  });

  it("rejects a fifth producer discovered by executable shape rather than filename", () => {
    const result = inspectPlaywrightArtifactUploadCorpus({
      ".github/workflows/unrelated-later-publisher.yaml": workflowWithUpload("artifacts/**"),
    });

    expect(result.status).toBe("fail");
    expect(result.findings).toEqual([
      expect.objectContaining({
        file: ".github/workflows/unrelated-later-publisher.yaml",
        analysis: expect.stringContaining("can include"),
      }),
    ]);
  });

  it("rejects a tracked composite producer even before a workflow calls it", () => {
    const result = inspectPlaywrightArtifactUploadCorpus({
      ".github/actions/future-publisher/action.yml": `name: Future publisher
runs:
  using: composite
  steps:
    - uses: ${uploadAction}
      with:
        path: artifacts/playwright/test-results
`,
    });

    expect(result).toMatchObject({
      status: "fail",
      findings: [
        expect.objectContaining({
          file: ".github/actions/future-publisher/action.yml",
          rawRoot: "artifacts/playwright/test-results",
        }),
      ],
    });
  });

  it("keeps safe-summary siblings and release-health evidence outside both raw roots", () => {
    const result = inspectPlaywrightArtifactUploadCorpus({
      ".github/workflows/safe-summary.yml": workflowWithUpload(
        "artifacts/staging-advisory-evidence/summary.json\nartifacts/playwright-safe-summary/summary.json\nartifacts/release-health/probe.json",
      ),
    });

    expect(result.status).toBe("pass");
    expect(result.findings).toEqual([]);
  });

  it("rejects a safe-summary upload that retains a raw Playwright sibling", () => {
    const result = inspectPlaywrightArtifactUploadCorpus({
      ".github/workflows/safe-summary-with-raw-sibling.yml": workflowWithUpload(
        "artifacts/staging-advisory-evidence/summary.json\nartifacts/playwright/test-results",
      ),
    });

    expect(result).toMatchObject({
      status: "fail",
      findings: [
        expect.objectContaining({
          file: ".github/workflows/safe-summary-with-raw-sibling.yml",
          rawRoot: "artifacts/playwright/test-results",
        }),
      ],
    });
  });

  it("rollback retains the disabled raw-upload steady state", () => {
    const disableOnlyRollback = {
      ".github/workflows/platform-pr.yml": workflowWithUpload("artifacts/release-health/probe.json"),
      ".github/workflows/platform-staging-advisory-evidence.yml": workflowWithUpload(
        "artifacts/staging-advisory-evidence/summary.json",
      ),
    };
    expect(inspectPlaywrightArtifactUploadCorpus(disableOnlyRollback).status).toBe("pass");

    const predecessorRestore = {
      ...disableOnlyRollback,
      ".github/workflows/platform-pr.yml": workflowWithUpload("artifacts/playwright/report"),
    };
    expect(inspectPlaywrightArtifactUploadCorpus(predecessorRestore)).toMatchObject({
      status: "fail",
      findings: [expect.objectContaining({ rawRoot: "artifacts/playwright/report" })],
    });
  });

  it("fails closed for malformed or unreadable Actions trees", () => {
    expect(() => inspectPlaywrightArtifactUploadCorpus({ ".github/workflows/malformed.yml": "jobs: [" })).toThrow(
      PlaywrightUploadFenceUnknownError,
    );
    expect(() => inspectPlaywrightArtifactUploadCorpus(new Map([[".github/workflows/unreadable.yml", null]]))).toThrow(
      /unreadable/,
    );
  });
});

describe("paginated remote revision audit (#6895 AC-4)", () => {
  it("reconciles the complete paginated list and audits first through final SHA", async () => {
    const seen = [];
    const result = await auditPullRequestHistory({
      pr: 7000,
      repo: "chase-sets/chase-sets",
      expectedHead: shas[2],
      fetchPull: async () => pull(),
      fetchCommitPages: async () => [[{ sha: shas[0] }, { sha: shas[1] }], [{ sha: shas[2] }]],
      scanRef: async (sha) => {
        seen.push(sha);
        return passingGuard(sha);
      },
    });

    expect(result).toMatchObject({
      schemaVersion: "playwright-upload-fence-history/v1",
      status: "pass",
      firstSha: shas[0],
      finalSha: shas[2],
      commits: shas,
      guardResults: shas.map((sha) => expect.objectContaining({ sha, status: "pass" })),
    });
    expect(seen).toEqual(shas);
  });

  it.each([
    {
      name: "count mismatch",
      fetchPull: async () => pull(),
      fetchCommitPages: async () => [[{ sha: shas[0] }, { sha: shas[2] }]],
      scanRef: async (sha) => passingGuard(sha),
      reason: "does not reconcile",
    },
    {
      name: "missing commit",
      fetchPull: async () => pull(),
      fetchCommitPages: async () => [[{ sha: shas[0] }, {}, { sha: shas[2] }]],
      scanRef: async (sha) => passingGuard(sha),
      reason: "missing commit",
    },
    {
      name: "unreadable tree",
      fetchPull: async () => pull(),
      fetchCommitPages: async () => [shas.map((sha) => ({ sha }))],
      scanRef: async (sha) => {
        if (sha === shas[1]) throw new Error("missing blob");
        return passingGuard(sha);
      },
      reason: "unreadable tree",
    },
  ])("returns unknown for $name", async ({ fetchPull, fetchCommitPages, scanRef, reason }) => {
    const result = await auditPullRequestHistory({
      pr: 7000,
      repo: "chase-sets/chase-sets",
      expectedHead: shas[2],
      fetchPull,
      fetchCommitPages,
      scanRef,
    });

    expect(result.status).toBe("unknown");
    expect(result.reasons.join("\n")).toContain(reason);
  });

  it("returns unknown when head or count moves during the audit", async () => {
    let call = 0;
    const result = await auditPullRequestHistory({
      pr: 7000,
      repo: "chase-sets/chase-sets",
      expectedHead: shas[2],
      fetchPull: async () => (call++ === 0 ? pull() : pull({ commits: 4, headSha: "4".repeat(40) })),
      fetchCommitPages: async () => [shas.map((sha) => ({ sha }))],
      scanRef: async (sha) => passingGuard(sha),
    });

    expect(result.status).toBe("unknown");
    expect(result.reasons).toContain("PR head, branch, or commit count moved during audit");
  });

  it("returns unknown before pagination when the provider commit cap cannot be complete", async () => {
    const result = await auditPullRequestHistory({
      pr: 7000,
      repo: "chase-sets/chase-sets",
      expectedHead: shas[2],
      fetchPull: async () => pull({ commits: 251 }),
      fetchCommitPages: async () => [],
      scanRef: async (sha) => passingGuard(sha),
    });

    expect(result.status).toBe("unknown");
    expect(result.reasons).toContain("PR commit count exceeds provider cap 250");
  });
});
