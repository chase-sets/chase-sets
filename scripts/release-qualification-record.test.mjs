import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  RELEASE_EVIDENCE_SPACES_CREDENTIAL_ENV,
  RELEASE_QUALIFICATION_EVIDENCE_BUCKET,
  RELEASE_QUALIFICATION_RECORD_MAX_BYTES,
  RELEASE_QUALIFICATION_SCHEMA_VERSION,
  buildReleaseQualificationRecord,
  createSpacesStorage,
  releaseQualificationAttemptKey,
  requireEvidenceCredentials,
  resolveCommitTreeSha,
  runCanaryProbe,
  serializeReleaseQualificationRecord,
  validateReleaseQualificationRecord,
  verifyReleaseQualificationRecord,
  writeReleaseQualificationRecord,
} from "./release-qualification-record.mjs";

const fixtureDir = resolve("scripts/fixtures/release-qualification");
const fixtureBody = (name) => readFileSync(resolve(fixtureDir, name), "utf8");
const fixture = (name) => JSON.parse(fixtureBody(name));

const valid = fixture("valid.json");
const verifiedAt = "2026-07-21T12:00:00Z";
const expectedForValid = {
  repository: valid.repository,
  treeSha: valid.candidateTreeSha,
  imageDigest: valid.imageDigest,
  classifierPolicyVersion: valid.classifierPolicyVersion,
  mode: "new-release",
  verifiedAt,
};

function memoryStorage(initial = {}) {
  const objects = new Map(Object.entries(initial));
  const calls = [];
  return {
    objects,
    calls,
    async objectExists(key) {
      calls.push(["head", key]);
      return objects.has(key);
    },
    async getObject(key) {
      calls.push(["get", key]);
      if (!objects.has(key)) throw new Error(`(404) Not Found: ${key}`);
      return objects.get(key);
    },
    async putObject(key, body) {
      calls.push(["put", key]);
      objects.set(key, body);
    },
    async deleteObject(key) {
      calls.push(["delete", key]);
      objects.delete(key);
    },
  };
}

describe("release-qualification/v1 record contract", () => {
  it("accepts the valid fixture", () => {
    expect(validateReleaseQualificationRecord(valid)).toEqual([]);
  });

  it("rejects a missing-field record", () => {
    expect(validateReleaseQualificationRecord(fixture("missing-field.json"))).toEqual([
      expect.stringContaining("imageDigest must be an immutable sha256 image digest."),
    ]);
  });

  it("fails closed on a future schema version instead of guessing at compatibility", () => {
    const errors = validateReleaseQualificationRecord(fixture("future-version.json"));
    expect(errors).toEqual([expect.stringContaining("readers fail closed on any other version")]);
  });

  it("rejects unknown fields so v1 stays a closed contract", () => {
    const errors = validateReleaseQualificationRecord({ ...valid, banana: true });
    expect(errors).toEqual([expect.stringContaining("unknown field banana")]);
  });

  it("normalizes CLI-shaped input into a valid record", () => {
    const { record, errors } = buildReleaseQualificationRecord({
      ...valid,
      candidateSha: ` ${valid.candidateSha.toUpperCase()} `,
      imageDigest: valid.imageDigest.toUpperCase(),
    });
    expect(errors).toEqual([]);
    expect(record.candidateSha).toBe(valid.candidateSha);
    expect(record.imageDigest).toBe(valid.imageDigest);
  });

  it("derives the append-only attempt key from repository, tree, digest, run, and attempt", () => {
    expect(releaseQualificationAttemptKey(valid)).toBe(
      `v1/attempts/${valid.repository}/${valid.candidateTreeSha}/${valid.imageDigest}/${valid.runId}-${valid.runAttempt}.json`,
    );
  });

  it("enforces the 64 KiB cost-wager cap on serialized records", () => {
    expect(RELEASE_QUALIFICATION_RECORD_MAX_BYTES).toBe(65536);
    const bloated = {
      ...valid,
      evidenceLinks: Array.from(
        { length: 700 },
        (_, i) => `https://github.com/chase-sets/chase-sets/actions/runs/${i}/${"x".repeat(80)}`,
      ),
    };
    const { body, errors } = serializeReleaseQualificationRecord(bloated);
    expect(body).toBeNull();
    expect(errors).toEqual([expect.stringContaining("cost-wager cap")]);
  });
});

describe("append-only writer", () => {
  it("head-before-put: writes a fresh record only after checking the attempt key", async () => {
    const storage = memoryStorage();
    const result = await writeReleaseQualificationRecord({ record: valid }, storage);
    expect(result.outcome).toBe("written");
    expect(result.key).toBe(releaseQualificationAttemptKey(valid));
    expect(storage.calls.map(([op]) => op)).toEqual(["head", "put"]);
  });

  it("treats a byte-identical retry as an idempotent success", async () => {
    const storage = memoryStorage();
    await writeReleaseQualificationRecord({ record: valid }, storage);
    const retry = await writeReleaseQualificationRecord({ record: valid }, storage);
    expect(retry.outcome).toBe("idempotent");
    expect(storage.objects.size).toBe(1);
  });

  it("fails closed on a conflicting record at the same attempt key without overwriting", async () => {
    const storage = memoryStorage();
    await writeReleaseQualificationRecord({ record: valid }, storage);
    const conflict = await writeReleaseQualificationRecord({ record: { ...valid, result: "fail" } }, storage);
    expect(conflict.outcome).toBe("conflict");
    expect(conflict.errors).toEqual([expect.stringContaining("append-only")]);
    expect(JSON.parse(storage.objects.get(conflict.key)).result).toBe("pass");
  });

  it("a requeued same-tree candidate writes a distinct run/attempt key", async () => {
    const storage = memoryStorage();
    const first = await writeReleaseQualificationRecord({ record: valid }, storage);
    const requeued = fixture("same-tree-different-commit.json");
    const second = await writeReleaseQualificationRecord({ record: requeued }, storage);
    expect(second.outcome).toBe("written");
    expect(second.key).not.toBe(first.key);
    expect(storage.objects.size).toBe(2);
  });

  it("refuses to write an invalid or oversized record before touching the provider", async () => {
    const storage = memoryStorage();
    const invalid = await writeReleaseQualificationRecord({ record: fixture("missing-field.json") }, storage);
    expect(invalid.outcome).toBe("invalid");
    expect(storage.calls).toEqual([]);
  });
});

describe("fail-closed production reader", () => {
  const verify = (name, overrides = {}) => {
    const record = fixture(name);
    return verifyReleaseQualificationRecord({
      body: fixtureBody(name),
      recordKey: releaseQualificationAttemptKey(record),
      expected: { ...expectedForValid, ...overrides },
    });
  };

  it("accepts the exact selected pass record", () => {
    const result = verify("valid.json");
    expect(result.errors).toEqual([]);
    expect(result.passed).toBe(true);
  });

  it("accepts a same-tree different-commit requalification record", () => {
    const result = verify("same-tree-different-commit.json");
    expect(result.errors).toEqual([]);
    expect(result.passed).toBe(true);
  });

  it("rejects malformed JSON", () => {
    const result = verifyReleaseQualificationRecord({
      body: fixtureBody("malformed.json"),
      recordKey: releaseQualificationAttemptKey(valid),
      expected: expectedForValid,
    });
    expect(result.passed).toBe(false);
    expect(result.errors).toEqual([expect.stringContaining("not valid JSON")]);
  });

  it("rejects wrong-repository records", () => {
    const result = verify("wrong-repository.json");
    expect(result.passed).toBe(false);
    expect(result.errors).toEqual([expect.stringContaining("repository attacker/chase-sets does not match")]);
  });

  it("rejects a record whose tree does not match the recomputed release tree", () => {
    const result = verify("wrong-tree.json");
    expect(result.passed).toBe(false);
    expect(result.errors).toEqual([expect.stringContaining("recomputed from the checked-out main SHA")]);
  });

  it("rejects a record whose image digest does not match the release digest", () => {
    const result = verify("wrong-digest.json");
    expect(result.passed).toBe(false);
    expect(result.errors).toEqual([expect.stringContaining("does not match the release image digest")]);
  });

  it("rejects non-passing records", () => {
    const result = verify("non-passing.json");
    expect(result.passed).toBe(false);
    expect(result.errors).toEqual([expect.stringContaining("only pass records authorize promotion")]);
  });

  it("rejects a future schema version end to end", () => {
    const result = verify("future-version.json");
    expect(result.passed).toBe(false);
    expect(result.errors).toEqual([expect.stringContaining("fail closed on any other version")]);
  });

  it("rejects a classifier policy version mismatch", () => {
    const result = verify("valid.json", { classifierPolicyVersion: "release-scope-classifier/v2" });
    expect(result.passed).toBe(false);
    expect(result.errors).toEqual([expect.stringContaining("classifier policy version")]);
  });

  it("rejects an arbitrary old record for a new direct release (24-hour limit)", () => {
    const result = verify("stale.json");
    expect(result.passed).toBe(false);
    expect(result.errors).toEqual([expect.stringContaining("older than the 24-hour limit")]);
  });

  it("exempts rollback (record key retained in the promoted release manifest) from the age limit", () => {
    const result = verify("stale.json", { mode: "rollback" });
    expect(result.errors).toEqual([]);
    expect(result.passed).toBe(true);
  });

  it("rejects a completedAt in the future beyond clock skew", () => {
    const result = verify("valid.json", { verifiedAt: "2026-07-21T10:00:00Z" });
    expect(result.passed).toBe(false);
    expect(result.errors).toEqual([expect.stringContaining("in the future")]);
  });

  it("binds verification to the exact attempt key, rejecting a record read from any other key", () => {
    const result = verifyReleaseQualificationRecord({
      body: fixtureBody("valid.json"),
      recordKey: `v1/attempts/${valid.repository}/${valid.candidateTreeSha}/${valid.imageDigest}/1-1.json`,
      expected: expectedForValid,
    });
    expect(result.passed).toBe(false);
    expect(result.errors).toEqual([expect.stringContaining("derives attempt key")]);
  });
});

describe("dedicated evidence credentials", () => {
  it("declares exactly the two bucket-scoped secret names from the issue", () => {
    expect([...RELEASE_EVIDENCE_SPACES_CREDENTIAL_ENV]).toEqual([
      "RELEASE_EVIDENCE_SPACES_ACCESS_ID",
      "RELEASE_EVIDENCE_SPACES_SECRET_KEY",
    ]);
  });

  it("fails before any provider call when either credential is withheld, naming only the env vars", () => {
    for (const withheld of RELEASE_EVIDENCE_SPACES_CREDENTIAL_ENV) {
      const env = {
        RELEASE_EVIDENCE_SPACES_ACCESS_ID: "value-a",
        RELEASE_EVIDENCE_SPACES_SECRET_KEY: "value-b",
      };
      delete env[withheld];
      const runCommand = () => {
        throw new Error("provider must not be called");
      };
      expect(() =>
        createSpacesStorage({
          bucket: RELEASE_QUALIFICATION_EVIDENCE_BUCKET,
          endpointUrl: "https://nyc3.digitaloceanspaces.com",
          env,
          runCommand,
        }),
      ).toThrowError(new RegExp(`missing dedicated release-evidence Spaces credentials ${withheld}`));
      try {
        requireEvidenceCredentials(env);
        expect.unreachable("requireEvidenceCredentials must throw");
      } catch (error) {
        expect(error.message).not.toContain("value-a");
        expect(error.message).not.toContain("value-b");
      }
    }
  });

  it("does not accept blank credentials", () => {
    expect(() =>
      requireEvidenceCredentials({
        RELEASE_EVIDENCE_SPACES_ACCESS_ID: "  ",
        RELEASE_EVIDENCE_SPACES_SECRET_KEY: "value",
      }),
    ).toThrowError(/RELEASE_EVIDENCE_SPACES_ACCESS_ID/);
  });
});

describe("release tree resolution", () => {
  it("recomputes the release tree from the checked-out main SHA via git", async () => {
    const calls = [];
    const tree = await resolveCommitTreeSha(valid.candidateSha, {
      gitOutput: async (args) => {
        calls.push(args);
        return `${valid.candidateTreeSha}\n`;
      },
    });
    expect(tree).toBe(valid.candidateTreeSha);
    expect(calls).toEqual([["rev-parse", `${valid.candidateSha}^{tree}`]]);
  });

  it("rejects a non-SHA input before invoking git", async () => {
    await expect(resolveCommitTreeSha("main", { gitOutput: async () => "" })).rejects.toThrowError(
      /40-character git commit SHA/,
    );
  });
});

describe("provider-backed canary probe sequence", () => {
  it("exercises write, idempotent retry, conflict rejection, requeue, read-back, and cleanup", async () => {
    const storage = memoryStorage();
    const summary = await runCanaryProbe({ storage, now: () => new Date("2026-07-21T12:00:00Z") });
    expect(summary.result).toBe("pass");
    expect(summary.steps.map((step) => step.name)).toEqual([
      "initial write",
      "byte-identical retry is idempotent",
      "conflicting record at same attempt key fails closed",
      "requeued same-tree candidate writes a distinct key",
      "reader rejects a record read from a non-attempt key",
    ]);
    expect(summary.steps.every((step) => step.passed)).toBe(true);
    expect(summary.prefix.startsWith("v1/canary/")).toBe(true);
    // Canary cleans up after itself; the attempts prefix is never touched.
    expect(storage.objects.size).toBe(0);
    expect(storage.calls.some(([, key]) => key.startsWith("v1/attempts/"))).toBe(false);
  });
});

describe("record schema constants", () => {
  it("pins the schema version and default bucket", () => {
    expect(RELEASE_QUALIFICATION_SCHEMA_VERSION).toBe("release-qualification/v1");
    expect(RELEASE_QUALIFICATION_EVIDENCE_BUCKET).toBe("chase-sets-release-qualification");
  });
});
