import { readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync, mkdtempSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  ENCRYPTED_PAYLOAD_FILE,
  PROVENANCE_FILE,
  REVIEW_TEXT_FILE,
  openReviewedPlan,
  sealReviewedPlan,
  validateReviewedPlanSource,
} from "./terraform-reviewed-plan.mjs";

const tempDirectories = [];
const commit = "a".repeat(40);
const otherCommit = "b".repeat(40);
const repository = "chase-sets/chase-sets";
const workflowPath = ".github/workflows/platform-seed-packs-apply.yml";
const workflowRef = `${repository}/${workflowPath}@refs/heads/main`;
const artifactDigest = `sha256:${"c".repeat(64)}`;
const createdAt = new Date("2026-07-22T20:00:00.000Z");
const now = new Date("2026-07-22T21:00:00.000Z");
const encryptionSecret = "authorized-spaces-secret-boundary";

function createFixture() {
  const directory = mkdtempSync(join(tmpdir(), "reviewed-plan-"));
  tempDirectories.push(directory);
  const terraformRoot = join(directory, "terraform-root");
  const bundleDirectory = join(directory, "bundle");
  const planBinaryPath = join(directory, "tfplan");
  const reviewTextPath = join(directory, "plan.txt");
  const backendConfigPath = join(terraformRoot, "backend.hcl.example");
  const outputPlanPath = join(directory, "opened", "tfplan");
  mkdirSync(terraformRoot, { recursive: true });
  writeFileSync(join(terraformRoot, "main.tf"), 'resource "example" "seed_packs" {}\n');
  writeFileSync(join(terraformRoot, ".terraform.lock.hcl"), "provider lock bytes\n");
  writeFileSync(backendConfigPath, 'key = "seed-packs/shared.tfstate"\n');
  writeFileSync(planBinaryPath, Buffer.from([0, 1, 2, 3, 255, 17, 42]));
  writeFileSync(reviewTextPath, "Terraform will perform 3 creates.\nsecret = (sensitive value)\n");

  const expectedProvenance = {
    repository,
    sourceWorkflowPath: workflowPath,
    sourceWorkflowRef: workflowRef,
    sourceWorkflowRunId: 12345,
    sourceWorkflowRunAttempt: 2,
    sourceWorkflowCommit: commit,
    releaseCommit: commit,
    releaseRef: commit,
    approvalEnvironment: "production",
    terraformRoot: "infrastructure/digitalocean/seed-packs",
    stateKey: "seed-packs/shared.tfstate",
  };

  return {
    directory,
    terraformRoot,
    bundleDirectory,
    planBinaryPath,
    reviewTextPath,
    backendConfigPath,
    outputPlanPath,
    expectedProvenance,
  };
}

function deterministicRandomBytes(size) {
  return Buffer.alloc(size, size);
}

function seal(fixture, overrides = {}) {
  return sealReviewedPlan({
    planBinaryPath: fixture.planBinaryPath,
    reviewTextPath: fixture.reviewTextPath,
    outputDirectory: fixture.bundleDirectory,
    terraformRootPath: fixture.terraformRoot,
    backendConfigPath: fixture.backendConfigPath,
    encryptionSecret,
    sensitiveValues: ["backend-access-id", encryptionSecret, "digitalocean-token"],
    provenance: {
      ...fixture.expectedProvenance,
      terraformVersion: "1.15.2",
      ...overrides.provenance,
    },
    now: overrides.now ?? createdAt,
    randomBytesFn: deterministicRandomBytes,
    ...overrides.options,
  });
}

function open(fixture, overrides = {}) {
  return openReviewedPlan({
    bundleDirectory: fixture.bundleDirectory,
    outputPlanPath: fixture.outputPlanPath,
    terraformRootPath: fixture.terraformRoot,
    backendConfigPath: fixture.backendConfigPath,
    encryptionSecret: overrides.encryptionSecret ?? encryptionSecret,
    expectedProvenance: {
      ...fixture.expectedProvenance,
      ...overrides.expectedProvenance,
    },
    maxAgeSeconds: overrides.maxAgeSeconds ?? 86_400,
    now: overrides.now ?? now,
  });
}

function baseSourceMetadata() {
  return {
    run: {
      id: 12345,
      run_attempt: 2,
      repository: { full_name: repository },
      path: workflowPath,
      event: "workflow_dispatch",
      status: "completed",
      conclusion: "success",
      head_sha: commit,
      head_branch: "main",
    },
    artifacts: [
      {
        name: "seed-packs-reviewed-plan-12345-2",
        workflow_run: { id: 12345 },
        expired: false,
        digest: artifactDigest,
        created_at: createdAt.toISOString(),
      },
    ],
  };
}

function verifySource(overrides = {}) {
  const metadata = baseSourceMetadata();
  return validateReviewedPlanSource({
    ...metadata,
    expectedRepository: repository,
    expectedWorkflowPath: workflowPath,
    expectedWorkflowRunId: 12345,
    expectedWorkflowRunAttempt: 2,
    expectedCommit: commit,
    expectedBranch: "main",
    expectedArtifactName: "seed-packs-reviewed-plan-12345-2",
    expectedArtifactDigest: artifactDigest,
    maxAgeSeconds: 86_400,
    now,
    ...overrides,
  });
}

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("authenticated-encrypted Terraform reviewed plan", () => {
  it("emits review text, authenticated provenance, and only the encrypted exact apply payload", () => {
    const fixture = createFixture();
    const originalPlan = readFileSync(fixture.planBinaryPath);
    const provenance = seal(fixture);

    expect(readdirSync(fixture.bundleDirectory).sort()).toEqual(
      [ENCRYPTED_PAYLOAD_FILE, PROVENANCE_FILE, REVIEW_TEXT_FILE].sort(),
    );
    expect(readFileSync(join(fixture.bundleDirectory, REVIEW_TEXT_FILE), "utf8")).toContain("(sensitive value)");
    expect(readFileSync(join(fixture.bundleDirectory, ENCRYPTED_PAYLOAD_FILE)).indexOf(originalPlan)).toBe(-1);
    expect(provenance.applyPayloadSha256).toMatch(/^[a-f0-9]{64}$/);

    open(fixture);
    expect(readFileSync(fixture.outputPlanPath)).toEqual(originalPlan);
  });

  it("rejects review text containing any exact credential before an artifact can be written", () => {
    const fixture = createFixture();
    writeFileSync(fixture.reviewTextPath, `leaked value: ${encryptionSecret}\n`);

    expect(() => seal(fixture)).toThrow(/contained a credential value/);
    expect(() => readdirSync(fixture.bundleDirectory)).toThrow();
  });

  it("refuses a nonempty artifact directory so a stale plaintext plan cannot be uploaded", () => {
    const fixture = createFixture();
    mkdirSync(fixture.bundleDirectory, { recursive: true });
    writeFileSync(join(fixture.bundleDirectory, "stale.tfplan"), "plaintext");

    expect(() => seal(fixture)).toThrow(/output directory must be empty/);
    expect(readdirSync(fixture.bundleDirectory)).toEqual(["stale.tfplan"]);
  });

  it.each([
    ["repository", "attacker/repository"],
    ["sourceWorkflowPath", ".github/workflows/other.yml"],
    ["sourceWorkflowRef", `${repository}/${workflowPath}@refs/heads/other`],
    ["sourceWorkflowRunId", 54321],
    ["sourceWorkflowRunAttempt", 3],
    ["sourceWorkflowCommit", otherCommit],
    ["releaseCommit", otherCommit],
    ["releaseRef", otherCommit],
    ["approvalEnvironment", "preview"],
    ["terraformRoot", "infrastructure/digitalocean/other"],
    ["stateKey", "other/shared.tfstate"],
  ])("fails closed when expected provenance field %s is mismatched", (field, value) => {
    const fixture = createFixture();
    seal(fixture);

    expect(() => open(fixture, { expectedProvenance: { [field]: value } })).toThrow(
      new RegExp(`${field} did not match`),
    );
    expect(() => readFileSync(fixture.outputPlanPath)).toThrow();
  });

  it("fails closed for missing, extra, substituted, tampered, and undecryptable payload files", () => {
    const cases = [
      {
        name: "missing payload",
        mutate(fixture) {
          rmSync(join(fixture.bundleDirectory, ENCRYPTED_PAYLOAD_FILE));
        },
        error: /unexpected file set/,
      },
      {
        name: "extra plaintext plan",
        mutate(fixture) {
          writeFileSync(join(fixture.bundleDirectory, "tfplan"), "plaintext");
        },
        error: /unexpected file set/,
      },
      {
        name: "substituted review text",
        mutate(fixture) {
          writeFileSync(join(fixture.bundleDirectory, REVIEW_TEXT_FILE), "different plan\n");
        },
        error: /reviewTextSha256 did not match/,
      },
      {
        name: "tampered ciphertext",
        mutate(fixture) {
          const file = join(fixture.bundleDirectory, ENCRYPTED_PAYLOAD_FILE);
          const envelope = JSON.parse(readFileSync(file, "utf8"));
          const bytes = Buffer.from(envelope.ciphertext, "base64");
          bytes[0] ^= 1;
          envelope.ciphertext = bytes.toString("base64");
          writeFileSync(file, `${JSON.stringify(envelope, null, 2)}\n`);
        },
        error: /authentication or decryption failed/,
      },
    ];

    for (const testCase of cases) {
      const fixture = createFixture();
      seal(fixture);
      testCase.mutate(fixture);
      expect(() => open(fixture), testCase.name).toThrow(testCase.error);
      expect(() => readFileSync(fixture.outputPlanPath), testCase.name).toThrow();
    }

    const wrongKeyFixture = createFixture();
    seal(wrongKeyFixture);
    expect(() => open(wrongKeyFixture, { encryptionSecret: "wrong-authorized-boundary" })).toThrow(
      /authentication or decryption failed/,
    );
  });

  it("authenticates provenance itself, so an otherwise-shaped provenance edit cannot decrypt", () => {
    const fixture = createFixture();
    seal(fixture);
    const file = join(fixture.bundleDirectory, PROVENANCE_FILE);
    const provenance = JSON.parse(readFileSync(file, "utf8"));
    provenance.terraformVersion = "9.9.9";
    writeFileSync(file, `${JSON.stringify(provenance, null, 2)}\n`);

    expect(() => open(fixture)).toThrow(/authentication or decryption failed/);
  });

  it("rejects stale reviewed plans and plans dated in the future", () => {
    const stale = createFixture();
    seal(stale, { now: new Date("2026-07-20T20:00:00.000Z") });
    expect(() => open(stale)).toThrow(/stale/);

    const future = createFixture();
    seal(future, { now: new Date("2026-07-22T22:00:01.000Z") });
    expect(() => open(future)).toThrow(/dated in the future/);
  });

  it.each([
    ["Terraform configuration", "main.tf", "changed resource\n"],
    ["Terraform lock", ".terraform.lock.hcl", "changed lock\n"],
    ["backend configuration", "backend.hcl.example", "changed backend\n"],
  ])("rejects %s digest drift before writing a decrypted plan", (_name, file, contents) => {
    const fixture = createFixture();
    seal(fixture);
    writeFileSync(join(fixture.terraformRoot, file), contents);

    expect(() => open(fixture)).toThrow(/did not match/);
    expect(() => readFileSync(fixture.outputPlanPath)).toThrow();
  });

  it("does not re-plan when mocked provider observations drift after planning", () => {
    const fixture = createFixture();
    const originalPlan = readFileSync(fixture.planBinaryPath);
    const externalProviderState = join(fixture.directory, "mock-provider-state.json");
    writeFileSync(externalProviderState, '{"serial":1,"remoteAcl":"private"}\n');
    seal(fixture);

    writeFileSync(externalProviderState, '{"serial":2,"remoteAcl":"public-read"}\n');
    open(fixture);

    expect(readFileSync(fixture.outputPlanPath)).toEqual(originalPlan);
  });

  it("rejects a payload substituted from another run instead of treating it as a fresh plan", () => {
    const reviewed = createFixture();
    const substituted = createFixture();
    seal(reviewed);
    seal(substituted, { provenance: { sourceWorkflowRunId: 99999 } });
    cpSync(
      join(substituted.bundleDirectory, ENCRYPTED_PAYLOAD_FILE),
      join(reviewed.bundleDirectory, ENCRYPTED_PAYLOAD_FILE),
    );

    expect(() => open(reviewed)).toThrow(/authentication or decryption failed/);
  });
});

describe("reviewed GitHub workflow run and artifact identity", () => {
  it("accepts only the exact successful same-repository workflow run and artifact digest", () => {
    expect(verifySource()).toMatchObject({ name: "seed-packs-reviewed-plan-12345-2", digest: artifactDigest });
  });

  it.each([
    ["repository", (metadata) => (metadata.run.repository.full_name = "attacker/repository"), /source repository/],
    ["workflow", (metadata) => (metadata.run.path = ".github/workflows/other.yml"), /source workflow path/],
    ["run", (metadata) => (metadata.run.id = 99999), /source workflow run id/],
    ["attempt", (metadata) => (metadata.run.run_attempt = 3), /source workflow run attempt/],
    ["commit", (metadata) => (metadata.run.head_sha = otherCommit), /source workflow commit/],
    ["branch", (metadata) => (metadata.run.head_branch = "feature"), /source workflow branch/],
    ["event", (metadata) => (metadata.run.event = "pull_request_target"), /source workflow event/],
    ["status", (metadata) => (metadata.run.status = "in_progress"), /source workflow status/],
    ["conclusion", (metadata) => (metadata.run.conclusion = "failure"), /source workflow conclusion/],
    ["artifact run", (metadata) => (metadata.artifacts[0].workflow_run.id = 99999), /artifact source workflow run id/],
    ["expired artifact", (metadata) => (metadata.artifacts[0].expired = true), /artifact expiration state/],
    [
      "artifact digest",
      (metadata) => (metadata.artifacts[0].digest = `sha256:${"d".repeat(64)}`),
      /GitHub artifact digest/,
    ],
  ])("rejects substituted or mismatched %s metadata", (_name, mutate, error) => {
    const metadata = baseSourceMetadata();
    mutate(metadata);
    expect(() => verifySource(metadata)).toThrow(error);
  });

  it("rejects missing, duplicate, stale, and non-explicit artifacts", () => {
    expect(() => verifySource({ artifacts: [] })).toThrow(/exactly one immutable reviewed-plan artifact/);
    const duplicate = baseSourceMetadata().artifacts[0];
    expect(() => verifySource({ artifacts: [duplicate, { ...duplicate }] })).toThrow(/exactly one/);
    expect(() => verifySource({ now: new Date("2026-07-24T20:00:01.000Z") })).toThrow(/stale/);
    expect(() => verifySource({ expectedArtifactDigest: "latest" })).toThrow(/explicit sha256/);
  });

  it.each([
    ["run id", { expectedWorkflowRunId: "" }, /positive integer/],
    ["run attempt", { expectedWorkflowRunAttempt: "" }, /positive integer/],
    ["artifact digest", { expectedArtifactDigest: "" }, /explicit sha256/],
  ])("rejects a missing explicit reviewed %s input", (_name, override, error) => {
    expect(() => verifySource(override)).toThrow(error);
  });
});

describe("seed-pack workflow binding contract", () => {
  const workflow = readFileSync(resolve(".github/workflows/platform-seed-packs-apply.yml"), "utf8");
  const planJob = workflow.slice(workflow.indexOf("  plan:"), workflow.indexOf("  apply:"));
  const applyJob = workflow.slice(workflow.indexOf("  apply:"));

  it("keeps planning plan-only and puts the sole mutation in the separately approved apply job", () => {
    expect(planJob).toContain("environment: production");
    expect(planJob).toMatch(/terraform .* plan /);
    expect(planJob).not.toMatch(/terraform .* apply /);
    expect(applyJob).toContain("environment: production");
    expect(applyJob).toMatch(/terraform .* apply -auto-approve \"\$decrypted_plan\"/);
    expect(applyJob).not.toMatch(/terraform .* plan /);
  });

  it("requires explicit run, attempt, and artifact digest and downloads only that same-repository artifact", () => {
    expect(workflow).toContain("reviewed_plan_run_id:");
    expect(workflow).toContain("reviewed_plan_run_attempt:");
    expect(workflow).toContain("reviewed_plan_artifact_digest:");
    expect(applyJob).toContain("verify-source");
    expect(applyJob).toContain("repository: ${{ github.repository }}");
    expect(applyJob).toContain("run-id: ${{ inputs.reviewed_plan_run_id }}");
    expect(applyJob).toContain("github-token: ${{ github.token }}");
  });

  it("uploads no plaintext binary and uses the existing protected Spaces secret for authenticated encryption", () => {
    expect(planJob).toContain("PLAN_ENCRYPTION_SECRET: ${{ secrets.SPACES_SECRET_KEY }}");
    expect(planJob).toContain("trap cleanup_plaintext EXIT");
    expect(planJob).toContain("path: artifacts/seed-packs-reviewed-plan");
    expect(planJob).not.toMatch(/^\s+path:.*tfplan/m);
    expect(applyJob).toContain("trap cleanup_plaintext EXIT");
  });

  it("rejects mutable release refs and untrusted workflow dispatch branches", () => {
    expect(workflow).toContain("mutable refs are rejected");
    expect(planJob).toContain('"refs/heads/main"');
    expect(workflow).not.toContain("pull_request_target");
  });
});
