// The 16 8933-impl-g1 `authority-packet-completeness` tests (sha256 89f8b29a…), its named mutants M1–M10 and
// one test per `applyProviderCapture` refusal. Completeness/application controls use synthetic identities;
// the historical replay section separately pins immutable real negative evidence.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it, test, vi } from "vitest";

import {
  databaseIdentityDigest,
  deriveFloor,
  runRedaction,
  validatePacket,
} from "./collections-anonymous-owner-redaction.mjs";

import * as packetModule from "./collections-cutover-authority-packet.mjs";

const { applyProviderCapture, PROVIDER_CAPTURE_FIELDS, PROVIDER_CAPTURE_SCHEMA_VERSION } = packetModule;

test("exports an offline gate assembler distinct from completeness", () => {
  expect(packetModule.assembleAuthorityPacket).toBeTypeOf("function");
});

const FLOOR = "1".repeat(40);
const RECOVERY = "2".repeat(40);
const concrete = (value) => ({ value, source: "synthetic-source" });
const unknown = () => ({
  status: "unknown",
  missingAuthority: "synthetic-authority",
  hostAction: "synthetic-host-action",
});

function writerSet(kind, target) {
  const items = [{ id: `synthetic-${target}-${kind}-1`, revision: FLOOR, containsFloor: true }];
  return { collected: 1, authoritativeTotal: 1, items, source: "synthetic-source" };
}

function syntheticCompletePacket({ GATES }) {
  const writerTargets = {};
  const matrixTargets = {};
  const bindingTargets = {};
  for (const target of ["staging", "production"]) {
    writerTargets[target] = {
      environment: concrete(target),
      databaseIdentityDigest: concrete("3".repeat(64)),
      terraformStateSerial: concrete(7),
      terraformStateLineage: concrete("synthetic-lineage"),
      releaseCommit: concrete(FLOOR),
      imageDigests: concrete([`sha256:${"4".repeat(64)}`]),
      writers: Object.fromEntries(
        ["serving", "suspended", "dormant", "rollback", "job", "cronjob", "session"].map((kind) => [
          kind,
          writerSet(kind, target),
        ]),
      ),
    };
    matrixTargets[target] = {
      gates: Object.fromEntries(
        GATES.map((gate) => [
          gate,
          {
            source: "synthetic-source",
            commandOrApi: "synthetic-command",
            operationOwner: "synthetic-owner",
            approvalBoundary: "synthetic-boundary",
            negativeDormantCase: "synthetic-dormant-case",
            observeAuthority: concrete("demonstrated"),
          },
        ]),
      ),
    };
    bindingTargets[target] = {
      runnerInputs: concrete({ target }),
      credentialSources: concrete(["SYNTHETIC_SECRET_NAME"]),
      caSource: concrete("synthetic-ca-source"),
      githubPermissions: concrete({ contents: "read" }),
      environmentProtection: concrete({ requiredReviewers: 1, branchPolicies: ["main"] }),
      deployedCommitAncestry: concrete([{ commit: FLOOR, containsFloor: true }]),
      legacyRawRowCount: concrete(0),
      legacyCountQueryPlan: concrete("synthetic-plan"),
      receiptLocation: concrete("synthetic-artifact"),
      failureTaxonomy: concrete(["synthetic-code"]),
    };
  }
  return {
    writerAuthority: {
      schemaVersion: "collections-writer-authority/v1",
      capturedAt: "2030-01-02T00:00:00.000Z",
      lifecycleMoment: "pre-cutover-planning",
      activationMerge: { commit: FLOOR, mergedAt: "2030-01-01T00:00:00.000Z", source: "synthetic-source" },
      targets: writerTargets,
    },
    authorityMatrix: {
      schemaVersion: "collections-cutover-authority-matrix/v1",
      capturedAt: "2030-01-02T00:00:00.000Z",
      targets: matrixTargets,
    },
    runnerBinding: {
      schemaVersion: "collections-redaction-runner-binding/v1",
      capturedAt: "2030-01-02T00:00:00.000Z",
      recoveryCommit: RECOVERY,
      floor: { status: "derived", commit: FLOOR, source: "synthetic-source" },
      targets: bindingTargets,
    },
  };
}

const reasons = (result) => result.missing.map((entry) => `${entry.target}|${entry.field}|${entry.reason}`);

// The source tests, in source order, each a body over one verifier implementation.
const sourceTests = [
  [
    "exports the closed target, writer and gate inventories",
    ({ TARGETS, WRITER_KINDS, GATES }) => {
      assert.deepEqual([...TARGETS], ["staging", "production"]);
      assert.deepEqual([...WRITER_KINDS], ["serving", "suspended", "dormant", "rollback", "job", "cronjob", "session"]);
      assert.ok(GATES.length >= 5);
    },
  ],
  [
    "synthetic complete control is complete",
    (api) => {
      const result = api.verifyAuthorityPacket(syntheticCompletePacket(api));
      assert.deepEqual(result.errors, []);
      assert.deepEqual(result.missing, []);
      assert.equal(result.verdict, "complete");
    },
  ],
  [
    "withholding one target from every capture is never complete",
    (api) => {
      const packet = syntheticCompletePacket(api);
      delete packet.writerAuthority.targets.production;
      delete packet.authorityMatrix.targets.production;
      delete packet.runnerBinding.targets.production;
      const result = api.verifyAuthorityPacket(packet);
      assert.equal(result.verdict, "bounded-unknown");
      for (const file of ["writerAuthority", "authorityMatrix", "runnerBinding"]) {
        assert.ok(
          result.missing.some(
            (entry) => entry.target === "production" && entry.file === file && entry.reason === "target-withheld",
          ),
          file,
        );
      }
      assert.ok(result.missing.every((entry) => entry.hostAction.length > 0));
    },
  ],
  [
    "withholding one writer while keeping its count is never complete",
    (api) => {
      const packet = syntheticCompletePacket(api);
      packet.writerAuthority.targets.staging.writers.dormant.items = [];
      const result = api.verifyAuthorityPacket(packet);
      assert.equal(result.verdict, "bounded-unknown");
      assert.ok(reasons(result).includes("staging|writers.dormant|writer-set-incomplete"));
    },
  ],
  [
    "collected below the authoritative total is never complete",
    (api) => {
      const packet = syntheticCompletePacket(api);
      packet.writerAuthority.targets.production.writers.session.authoritativeTotal = 2;
      const result = api.verifyAuthorityPacket(packet);
      assert.ok(reasons(result).includes("production|writers.session|writer-set-incomplete"));
    },
  ],
  [
    "an unknown field returns bounded unknown carrying its host action",
    (api) => {
      const packet = syntheticCompletePacket(api);
      packet.writerAuthority.targets.production.terraformStateSerial = unknown();
      const result = api.verifyAuthorityPacket(packet);
      assert.equal(result.verdict, "bounded-unknown");
      const entry = result.missing.find((item) => item.field === "terraformStateSerial");
      assert.equal(entry.target, "production");
      assert.equal(entry.reason, "unknown");
      assert.equal(entry.hostAction, "synthetic-host-action");
      assert.equal(entry.missingAuthority, "synthetic-authority");
    },
  ],
  [
    "an unknown writer kind or gate authority is bounded unknown",
    (api) => {
      const packet = syntheticCompletePacket(api);
      packet.writerAuthority.targets.staging.writers.rollback = unknown();
      packet.authorityMatrix.targets.staging.gates["rollback-floor"].observeAuthority = unknown();
      const result = api.verifyAuthorityPacket(packet);
      assert.equal(result.verdict, "bounded-unknown");
      assert.ok(reasons(result).includes("staging|writers.rollback|unknown"));
      assert.ok(reasons(result).includes("staging|gates.rollback-floor.observeAuthority|unknown"));
    },
  ],
  [
    "an absent field or gate is missing, not complete",
    (api) => {
      const packet = syntheticCompletePacket(api);
      delete packet.runnerBinding.targets.staging.legacyCountQueryPlan;
      delete packet.authorityMatrix.targets.production.gates.job;
      const result = api.verifyAuthorityPacket(packet);
      assert.equal(result.verdict, "bounded-unknown");
      assert.ok(reasons(result).includes("staging|legacyCountQueryPlan|field-absent"));
      assert.ok(reasons(result).includes("production|gates.job|field-absent"));
    },
  ],
  [
    "an unknown without missing authority and host action is invalid",
    (api) => {
      const packet = syntheticCompletePacket(api);
      packet.runnerBinding.targets.production.legacyRawRowCount = { status: "unknown" };
      const result = api.verifyAuthorityPacket(packet);
      assert.equal(result.verdict, "invalid");
      assert.ok(result.errors.includes("production|legacyRawRowCount|ungoverned-unknown"));
    },
  ],
  [
    "a floor-pending capture leaves the floor unmet",
    (api) => {
      const packet = syntheticCompletePacket(api);
      packet.runnerBinding.floor = { status: "floor-pending", commit: null, source: "synthetic-source" };
      const result = api.verifyAuthorityPacket(packet);
      assert.notEqual(result.verdict, "complete");
      assert.ok(reasons(result).includes("*|floor|floor-pending"));
    },
  ],
  [
    "the recovery commit is never the floor",
    (api) => {
      const packet = syntheticCompletePacket(api);
      packet.runnerBinding.floor.commit = RECOVERY;
      const result = api.verifyAuthorityPacket(packet);
      assert.equal(result.verdict, "invalid");
      assert.ok(result.errors.includes("*|floor|floor-is-recovery-commit"));
    },
  ],
  [
    "the floor must equal the activation merge commit",
    (api) => {
      const packet = syntheticCompletePacket(api);
      packet.runnerBinding.floor.commit = "5".repeat(40);
      const result = api.verifyAuthorityPacket(packet);
      assert.equal(result.verdict, "invalid");
      assert.ok(result.errors.includes("*|floor|floor-not-activation-merge"));
    },
  ],
  [
    "a capture taken before the activation merge is provisional",
    (api) => {
      const packet = syntheticCompletePacket(api);
      packet.runnerBinding.capturedAt = "2029-12-31T00:00:00.000Z";
      const result = api.verifyAuthorityPacket(packet);
      assert.notEqual(result.verdict, "complete");
      assert.ok(reasons(result).includes("*|runnerBinding.capturedAt|capture-before-activation-merge"));
    },
  ],
  [
    "a secret-bearing value is invalid",
    (api) => {
      const packet = syntheticCompletePacket(api);
      packet.runnerBinding.targets.staging.caSource = concrete(
        "postgresql://synthetic:synthetic-password@synthetic-host:25060/db",
      );
      const result = api.verifyAuthorityPacket(packet);
      assert.equal(result.verdict, "invalid");
      assert.ok(result.errors.some((error) => error.endsWith("|secret-value")));
    },
  ],
  [
    "an extra target is invalid",
    (api) => {
      const packet = syntheticCompletePacket(api);
      packet.writerAuthority.targets["synthetic-extra-prod"] = packet.writerAuthority.targets.production;
      const result = api.verifyAuthorityPacket(packet);
      assert.equal(result.verdict, "invalid");
      assert.ok(result.errors.includes("synthetic-extra-prod|writerAuthority|target-unexpected"));
    },
  ],
  [
    "a wrong schema version is invalid",
    (api) => {
      const packet = syntheticCompletePacket(api);
      packet.authorityMatrix.schemaVersion = "collections-cutover-authority-matrix/v0";
      const result = api.verifyAuthorityPacket(packet);
      assert.equal(result.verdict, "invalid");
      assert.ok(result.errors.includes("*|authorityMatrix|schema-version"));
    },
  ],
];

describe("ported authority packet verifier", () => {
  it("keeps all 16 source tests", () => {
    expect(sourceTests).toHaveLength(16);
  });
  for (const [name, body] of sourceTests) test(name, () => body(packetModule));
});

// Each mutant is one exact replacement in the ported verifier (Prettier-formatted spans of the source mutants)
// paired with the source tests that must kill it, exactly as the 8933-impl-g1 mutant run recorded.
const mutants = {
  "M1a-extra-target-accepted": [
    "if (!TARGETS.includes(target)) state.errors.push(",
    "if (false) state.errors.push(",
    ["an extra target is invalid"],
  ],
  "M1b-withheld-target-ignored": [
    'else\n      state.missing.push({\n        target,\n        file,\n        field: "*",',
    'else if (false)\n      state.missing.push({\n        target,\n        file,\n        field: "*",',
    ["withholding one target from every capture is never complete"],
  ],
  "M2-unknown-read-as-complete": [
    'state.missing.push({\n      target,\n      file,\n      field: name,\n      reason: "unknown",',
    'return true;\n    state.missing.push({\n      target,\n      file,\n      field: name,\n      reason: "unknown",',
    [
      "an unknown field returns bounded unknown carrying its host action",
      "an unknown writer kind or gate authority is bounded unknown",
    ],
  ],
  "M3-collected-below-total-accepted": [
    "value.collected !== value.authoritativeTotal ||\n    items.length !== value.collected",
    "false",
    [
      "withholding one writer while keeping its count is never complete",
      "collected below the authoritative total is never complete",
    ],
  ],
  "M4-recovery-commit-floor-accepted": [
    "} else if (floor.commit === runnerBinding.recoveryCommit) {",
    "} else if (false) {",
    ["the recovery commit is never the floor"],
  ],
  "M5-floor-pending-accepted": [
    'floor.status !== "derived" || !sha40(floor.commit)',
    "false",
    ["a floor-pending capture leaves the floor unmet"],
  ],
  "M6-ungoverned-unknown-accepted": [
    "if (!text(value.missingAuthority) || !text(value.hostAction)) {",
    "if (false) {",
    ["an unknown without missing authority and host action is invalid"],
  ],
  "M7-secret-scan-removed": ['scanSecrets(packet, "packet", state.errors);', "", ["a secret-bearing value is invalid"]],
  "M8-pre-merge-capture-accepted": [
    "else if (Number.isFinite(mergedAt) && capturedAt <= mergedAt) {",
    "else if (false) {",
    ["a capture taken before the activation merge is provisional"],
  ],
  "M9-absent-gate-defaulted": [
    "const entry = gates[gate];",
    'const entry = gates[gate] ?? { source: "x", commandOrApi: "x", operationOwner: "x", approvalBoundary: "x", negativeDormantCase: "x", observeAuthority: { value: "demonstrated", source: "x" } };',
    ["an absent field or gate is missing, not complete"],
  ],
  "M10-schema-version-ignored": [
    "packet[file].schemaVersion !== spec.schemaVersion",
    "false",
    ["a wrong schema version is invalid"],
  ],
};

const verifierSource = (() => {
  const source = readFileSync(new URL("./collections-cutover-authority-packet.mjs", import.meta.url), "utf8").replace(
    /\r\n/g,
    "\n",
  );
  return source.slice(source.indexOf("export const TARGETS"), source.indexOf("export function readPacket"));
})();

function loadVerifier(source) {
  return new Function(
    `${source.replace(/^export /gm, "")}\nreturn { verifyAuthorityPacket, TARGETS, WRITER_KINDS, GATES };`,
  )();
}

function failingSourceTests(api) {
  return sourceTests
    .filter(([, body]) => {
      try {
        body(api);
        return false;
      } catch {
        return true;
      }
    })
    .map(([name]) => name);
}

describe("named verifier mutants", () => {
  it("the unmutated verifier block passes every source test", () => {
    expect(failingSourceTests(loadVerifier(verifierSource))).toEqual([]);
  });

  it.each(Object.entries(mutants))("kills %s by name", (_name, [from, to, killers]) => {
    expect(verifierSource.includes(from), "mutant-not-applied").toBe(true);
    expect(failingSourceTests(loadVerifier(verifierSource.replace(from, to)))).toEqual(killers);
  });
});

const ACTIVATION_MERGED_AT = "2030-01-01T00:00:00.000Z";
const POOLER_START = "2030-01-02T00:00:00.000Z";
const POOL_ROLE_DIGEST = "a".repeat(64);

// Per-backend session evidence as the capture emits it: one proven pooler, one same-role unknown backend.
function sessionSet() {
  return {
    collected: 2,
    authoritativeTotal: 2,
    items: [
      {
        id: "backend:4242",
        pid: 4242,
        backendStart: POOLER_START,
        roleDigest: POOL_ROLE_DIGEST,
        poolMatch: { pid: true, backendStart: true, role: true },
        classification: "pooler",
        revisions: [FLOOR],
        containsFloor: true,
      },
      {
        id: "backend:4300",
        pid: 4300,
        backendStart: "2030-01-02T01:00:00.000Z",
        roleDigest: POOL_ROLE_DIGEST,
        poolMatch: { pid: false, backendStart: false, role: true },
        classification: "unknown",
        revisions: [],
        containsFloor: null,
      },
    ],
    source: "synthetic-source",
    pool: concrete({
      context: "collections",
      name: "collections-runtime",
      mode: "transaction",
      size: 1,
      hostDigest: "b".repeat(64),
      userDigest: POOL_ROLE_DIGEST,
    }),
    pooledRead: concrete({ pid: 4242, backendStart: POOLER_START }),
    holders: {
      collected: 1,
      authoritativeTotal: 1,
      items: [{ id: "capture:synthetic", source: "capture", revisions: [FLOOR], containsFloor: true }],
      exclusions: [],
      source: "synthetic-source",
    },
  };
}

function syntheticProviderCapture(target = "staging") {
  const writers = ["serving", "suspended", "dormant", "rollback", "job", "cronjob"];
  const gates = ["rollout", "traffic", "job", "cronjob", "rollback-floor", "credential-session-fence"];
  return {
    schemaVersion: PROVIDER_CAPTURE_SCHEMA_VERSION,
    target,
    capturedAt: "2030-01-03T00:00:00.000Z",
    head: "6".repeat(40),
    codes: [],
    fields: {
      environment: concrete(target),
      databaseIdentityDigest: concrete("7".repeat(64)),
      terraformStateSerial: concrete(9),
      terraformStateLineage: concrete("synthetic-captured-lineage"),
      releaseCommit: concrete(FLOOR),
      imageDigests: concrete([`sha256:${"8".repeat(64)}`]),
      ...Object.fromEntries(writers.map((kind) => [`writers.${kind}`, writerSet(kind, `${target}-captured`)])),
      "writers.session": sessionSet(),
      ...Object.fromEntries(gates.map((gate) => [`gates.${gate}.observeAuthority`, concrete("demonstrated")])),
      deployedCommitAncestry: concrete({
        floor: FLOOR,
        revisions: [{ revision: 1, commit: FLOOR, containsFloor: true }],
      }),
      legacyRawRowCount: concrete(35),
      legacyCountQueryPlan: concrete({ statementSha256: "9".repeat(64), plan: [] }),
    },
  };
}

describe("applyProviderCapture", () => {
  const packet = () => syntheticCompletePacket(packetModule);
  const refusal = (mutate) => {
    const capture = syntheticProviderCapture();
    mutate(capture);
    const original = packet();
    const result = applyProviderCapture(original, capture);
    expect(result.packet).toBe(original);
    expect(result.verdict).toBe("invalid");
    return result.errors;
  };

  it("captures exactly the AC1 field set", () => {
    expect(Object.keys(syntheticProviderCapture().fields)).toEqual([...PROVIDER_CAPTURE_FIELDS]);
    expect(PROVIDER_CAPTURE_FIELDS).toHaveLength(22);
    expect(PROVIDER_CAPTURE_FIELDS).not.toContain("gates.manual-release-ref.observeAuthority");
    expect(PROVIDER_CAPTURE_FIELDS).not.toContain("gates.ci-workflow-rerun.observeAuthority");
  });

  it("folds a staging capture into a copy of the packet and leaves production untouched", () => {
    const original = packet();
    const capture = syntheticProviderCapture();
    const result = applyProviderCapture(original, capture);
    expect(result).toMatchObject({ verdict: "complete", missing: [], errors: [] });
    expect(result.packet).not.toBe(original);
    const staging = result.packet.writerAuthority.targets.staging;
    expect(staging.terraformStateSerial).toEqual(capture.fields.terraformStateSerial);
    expect(staging.writers.session).toEqual(capture.fields["writers.session"]);
    expect(result.packet.authorityMatrix.targets.staging.gates.rollout).toMatchObject({
      source: "synthetic-source",
      observeAuthority: concrete("demonstrated"),
    });
    expect(result.packet.runnerBinding.targets.staging.legacyRawRowCount).toEqual(concrete(35));
    expect(result.packet.writerAuthority.targets.production).toEqual(original.writerAuthority.targets.production);
    expect(packetModule.verifyAuthorityPacket(result.packet).verdict).toBe("complete");
  });

  it("carries governed unknowns as missing and keeps them bounded in the verifier", () => {
    const capture = syntheticProviderCapture();
    capture.fields["writers.session"] = unknown();
    capture.fields["gates.credential-session-fence.observeAuthority"] = unknown();
    const result = applyProviderCapture(packet(), capture);
    expect(result.verdict).toBe("bounded-unknown");
    expect(reasons(result)).toEqual([
      "staging|writers.session|unknown",
      "staging|gates.credential-session-fence.observeAuthority|unknown",
    ]);
    expect(packetModule.verifyAuthorityPacket(result.packet).verdict).toBe("bounded-unknown");
  });

  it("fills an absent target and gate slot in a Probe packet", () => {
    const original = packet();
    delete original.writerAuthority.targets.staging;
    delete original.authorityMatrix.targets.staging;
    const result = applyProviderCapture(original, syntheticProviderCapture());
    expect(result.errors).toEqual([]);
    expect(Object.keys(result.packet.authorityMatrix.targets.staging.gates)).toEqual([
      "rollout",
      "traffic",
      "job",
      "cronjob",
      "rollback-floor",
      "credential-session-fence",
    ]);
  });

  it("refuses a non-AC1 field", () => {
    expect(
      refusal((capture) => {
        capture.fields["gates.manual-release-ref.observeAuthority"] = concrete("demonstrated");
      }),
    ).toEqual(["staging|gates.manual-release-ref.observeAuthority|field-unexpected"]);
  });

  it("refuses a non-AC1 envelope key", () => {
    expect(
      refusal((capture) => {
        capture.runnerInputs = concrete({});
      }),
    ).toEqual(["staging|runnerInputs|field-unexpected"]);
  });

  it("refuses an absent AC1 field", () => {
    expect(
      refusal((capture) => {
        delete capture.fields.legacyCountQueryPlan;
      }),
    ).toEqual(["staging|legacyCountQueryPlan|field-absent"]);
  });

  it("refuses a non-AC1 target", () => {
    expect(
      refusal((capture) => {
        capture.target = "synthetic-extra-prod";
      }),
    ).toEqual(["*|target|target-unexpected"]);
  });

  it("refuses a capture taken at or before the activation merge", () => {
    expect(
      refusal((capture) => {
        capture.capturedAt = ACTIVATION_MERGED_AT;
      }),
    ).toEqual(["staging|capturedAt|capture-before-activation-merge"]);
  });

  it("refuses a secret-shaped value without echoing it", () => {
    const errors = refusal((capture) => {
      capture.fields.legacyCountQueryPlan = concrete("postgresql://synthetic:synthetic-password@synthetic-host/db");
    });
    expect(errors).toEqual(["capture.fields.legacyCountQueryPlan.value|secret-value"]);
    expect(JSON.stringify(errors)).not.toContain("synthetic-password");
  });

  it("refuses a capture that recorded failure codes", () => {
    expect(
      refusal((capture) => {
        capture.codes = ["command-refused"];
      }),
    ).toEqual(["staging|codes|capture-failed"]);
  });

  it("refuses an ungoverned unknown or a non-demonstrated gate", () => {
    expect(
      refusal((capture) => {
        capture.fields["writers.job"] = { status: "unknown" };
        capture.fields["gates.job.observeAuthority"] = concrete("assumed");
      }),
    ).toEqual(["staging|writers.job|ungoverned-unknown", "staging|gates.job.observeAuthority|field-shape"]);
  });

  it("refuses ancestry computed against another floor", () => {
    expect(
      refusal((capture) => {
        capture.fields.deployedCommitAncestry.value.floor = RECOVERY;
      }),
    ).toEqual(["staging|deployedCommitAncestry|floor-mismatch"]);
  });

  it("refuses a capture of another schema version", () => {
    expect(
      refusal((capture) => {
        capture.schemaVersion = "collections-cutover-provider-capture/v0";
      }),
    ).toEqual(["*|capture|schema-version"]);
  });
});

describe("applyProviderCapture session evidence", () => {
  const packet = () => syntheticCompletePacket(packetModule);
  const withSession = (mutate) => {
    const capture = syntheticProviderCapture();
    mutate(capture.fields["writers.session"], capture);
    return { capture, result: applyProviderCapture(packet(), capture) };
  };

  it("keeps unknown backends complete when the pool, pooled read and holders are governed unknowns", () => {
    const { capture, result } = withSession((session) => {
      session.items = session.items.filter((item) => item.classification === "unknown");
      session.collected = session.authoritativeTotal = 1;
      for (const key of ["pool", "pooledRead", "holders"]) session[key] = unknown();
    });
    expect(result).toMatchObject({ verdict: "complete", errors: [], missing: [] });
    expect(result.packet.writerAuthority.targets.staging.writers.session).toEqual(capture.fields["writers.session"]);
  });

  it.each([
    [
      "an aggregate session:N set",
      (session, capture) => (capture.fields["writers.session"] = writerSet("session", "x")),
    ],
    ["a set without holder evidence", (session) => delete session.holders],
    ["a set with an ungoverned pool unknown", (session) => (session.pool = { status: "unknown" })],
    ["a backend item whose id is not its PID", (session) => (session.items[1].id = "backend:4301")],
    ["an unclassified backend item", (session) => delete session.items[1].classification],
  ])("folds %s in as a governed unknown, never a complete session set", (_, mutate) => {
    const { result } = withSession(mutate);
    expect(result).toMatchObject({ verdict: "bounded-unknown", errors: [] });
    expect(reasons(result)).toEqual(["staging|writers.session|session-evidence-aggregate"]);
    const session = result.packet.writerAuthority.targets.staging.writers.session;
    expect(session).toEqual({
      status: "unknown",
      missingAuthority: "aggregate-only session attribution without per-backend pool and holder evidence",
      hostAction: "re-dispatch the capture for staging at a head that records per-backend sessions",
    });
    expect(packetModule.verifyAuthorityPacket(result.packet).verdict).toBe("bounded-unknown");
  });

  it.each([
    ["the pooled read names another PID", (session) => (session.pooledRead.value.pid = 4300)],
    [
      "the pooled read's backend started at another time",
      (session) => (session.pooledRead.value.backendStart = "2030-01-02T00:00:01.000Z"),
    ],
    ["the pooled read is a governed unknown", (session) => (session.pooledRead = unknown())],
    ["the pool user is another role", (session) => (session.pool.value.userDigest = "c".repeat(64))],
    ["the holder census is a governed unknown", (session) => (session.holders = unknown())],
    ["the row's own pool match is not proven", (session) => (session.items[0].poolMatch.backendStart = false)],
    ["a same-role backend claims pooler", (session) => (session.items[1].classification = "pooler")],
  ])("refuses a pooler claim when %s", (_, mutate) => {
    const capture = syntheticProviderCapture();
    mutate(capture.fields["writers.session"]);
    const original = packet();
    const result = applyProviderCapture(original, capture);
    expect(result.packet).toBe(original);
    expect(result).toMatchObject({ verdict: "invalid", errors: ["staging|writers.session|pooler-unproven"] });
  });

  it.each([
    [
      "holder evidence carrying a value instead of items",
      "holders",
      (session) =>
        (session.holders = { collected: 1, authoritativeTotal: 1, value: "not-items", source: "synthetic-source" }),
    ],
    ["holder evidence that disagrees with its total", "holders", (session) => (session.holders.authoritativeTotal = 2)],
    ["holder items that fall short of the count", "holders", (session) => (session.holders.items = [])],
    [
      "holder evidence with a non-integer count",
      "holders",
      (session) => (session.holders.collected = session.holders.authoritativeTotal = "1"),
    ],
    ["pool evidence without a user digest", "pool", (session) => delete session.pool.value.userDigest],
    ["pool evidence with a scalar value", "pool", (session) => (session.pool.value = "collections-runtime")],
    ["pool evidence of another pool", "pool", (session) => (session.pool.value.name = "synthetic-other-pool")],
    [
      "pooled-read evidence carrying items instead of a value",
      "pooledRead",
      (session) => (session.pooledRead = { items: [], source: "synthetic-source" }),
    ],
    [
      "pooled-read evidence whose backend start is not an instant",
      "pooledRead",
      (session) => (session.pooledRead.value.backendStart = "x"),
    ],
  ])("refuses %s as a structured error and never throws", (_, key, mutate) => {
    const claimed = syntheticProviderCapture();
    mutate(claimed.fields["writers.session"]);
    const original = packet();
    let result;
    expect(() => (result = applyProviderCapture(original, claimed))).not.toThrow();
    expect(result.packet).toBe(original);
    expect(result).toMatchObject({
      verdict: "invalid",
      errors: [`staging|writers.session|${key}-malformed`, "staging|writers.session|pooler-unproven"],
    });
    // The same malformed evidence refuses a capture whose backends all stay unknown.
    const unclaimed = syntheticProviderCapture();
    const session = unclaimed.fields["writers.session"];
    session.items = session.items.filter((item) => item.classification === "unknown");
    session.collected = session.authoritativeTotal = 1;
    mutate(session);
    expect(applyProviderCapture(packet(), unclaimed)).toMatchObject({
      verdict: "invalid",
      errors: [`staging|writers.session|${key}-malformed`],
    });
  });
});

const hash = (value) => createHash("sha256").update(value).digest("hex");
const bound = (value) => {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return { text, sha256: hash(text) };
};
const fixturePath = (name) => new URL(`./fixtures/collections-cutover-authority/${name}`, import.meta.url);
const historical = (name) => {
  const bytes = readFileSync(fixturePath(name), "utf8");
  return name.endsWith(".b64") ? Buffer.from(bytes, "base64").toString("utf8") : bytes;
};

describe("historical escaped packets are negative evidence, never cutover authority", () => {
  // Text suffixes avoid formatter rewrites; base64 preserves the production packet's original CRLF bytes.
  const hashes = {
    "staging-escaped-packet.json.txt": "e07f627199bed257fd76d585a1db5d8f9be71b7545ae5568e3cce66d32db3e5d",
    "production-escaped-packet.json.b64": "1d34cd821034aefab0a0e11affb989f7a2e8aa1ed7ad5503bc4c215c54d778c7",
    "staging-capture.json.txt": "563c88c7acf4c8f1a806f0dbaf78b4f7b1eabeb53babf7c0dde6270aa6d5ca9f",
    "production-capture.json.txt": "c13102b678d1638ff3945f2162b1a5c6e4f7b7364463ff63017bfaa2ea1cd6df",
  };
  it.each(Object.entries(hashes))("pins immutable bytes for %s", (name, digest) =>
    expect(hash(historical(name))).toBe(digest),
  );

  const replay = (target, withImageEvidence = false) => {
    const captureText = historical(`${target}-capture.json.txt`);
    const capture = JSON.parse(captureText);
    const escaped = JSON.parse(historical(`${target}-escaped-packet.json.${target === "production" ? "b64" : "txt"}`));
    const floor = capture.fields.deployedCommitAncestry.value.floor;
    const evidence = JSON.parse(historical("production-image-evidence.json"));
    const images = withImageEvidence
      ? capture.fields["writers.rollback"].items
          .filter((item) => item.images?.includes(evidence.image) && item.revisions.length === 0)
          .map((item) => ({
            captureSha256: evidence.captureSha256,
            sourceId: item.id,
            image: evidence.image,
            commit: evidence.commit,
            execution: bound(evidence.executionExtract),
            jobId: evidence.jobId,
            stepNumber: evidence.stepNumber,
            lines: evidence.lines,
            compare: evidence.compare,
          }))
      : [];
    // Historical negative replay seam only: no local full-history or fresh production proof is claimed.
    const known = new Set(
      packetModule.WRITER_KINDS.flatMap((kind) =>
        capture.fields[`writers.${kind}`].items
          .filter((item) => item.containsFloor === true)
          .flatMap((item) => item.revisions ?? []),
      ),
    );
    if (withImageEvidence) known.add(evidence.commit);
    const result = packetModule.assembleAuthorityPacket(
      {
        target,
        floorCommit: floor,
        root: "synthetic-historical-negative-seam",
        capture: bound(captureText),
        startedAt: capture.capturedAt,
        activationMergedAt: "2026-10-16T00:00:00.000Z",
        assertedPacket: escaped,
        supplementary: { images, retirements: [], terminations: [], schemaObservation: null },
      },
      {
        deriveFloor: () => floor,
        containsFloor: (_root, expected, revision) => expected === floor && known.has(revision),
      },
    );
    return { result, escaped, capture };
  };
  it("staging: 27 compatible rollback sources derive deployed, but the unclassified aggregate session refuses", () => {
    const { result, escaped } = replay("staging");
    expect(escaped.writers.rollback.filter((writer) => writer.state === "retired")).toHaveLength(27);
    expect(escaped.writers.session).toMatchObject([{ state: "terminated" }]);
    expect(result).toMatchObject({
      verdict: "refused",
      codes: ["schema-source", "session-proof"],
      mapped: { rollback: { deployed: 27, retired: 0 }, session: { terminated: 0 } },
    });
    expect(result).not.toHaveProperty("packet");
  });
  it("production: without E3 two unknown ReplicaSets and the session refuse; with bound E3 only those ReplicaSets become deployed", () => {
    const without = replay("production");
    expect(without.escaped.writers.rollback.filter((writer) => writer.state === "retired")).toHaveLength(29);
    expect(without.result).toMatchObject({
      verdict: "refused",
      codes: ["image-provenance", "schema-source", "session-proof"],
      mapped: { rollback: { deployed: 27, retired: 0 } },
    });
    const withEvidence = replay("production", true);
    expect(withEvidence.result).toMatchObject({
      verdict: "refused",
      codes: ["schema-source", "session-proof"],
      mapped: { rollback: { deployed: 29, retired: 0 }, session: { terminated: 0 } },
    });
    expect(withEvidence.result).not.toHaveProperty("packet");
  });
  it("binds the retained E3 compare extraction, executed job and exact historical line hashes without ingesting the full compare", () => {
    const evidence = JSON.parse(historical("production-image-evidence.json"));
    expect(evidence.historicalOnly).toBe(true);
    expect(evidence.compare).toEqual({
      artifactSha256: "1740ca197888047232518ca12c68ac4628f4c6729e83bcc1850bf4e6523768c5",
      status: "ahead",
      ahead_by: 378,
      behind_by: 0,
      base: "a460b410398b01d386b7919ef364e63d3d271b88",
      mergeBase: "a460b410398b01d386b7919ef364e63d3d271b88",
      head: "d2186b574266b38897045e047a90517a6a2c8168",
    });
    expect(evidence.jobSourceSha256).toBe("88a4f60f08ae2f7f56e8b22f03661c281d4fbebc80cdd59a0f6d2518a5701c66");
    expect(evidence.lines.map((line) => hash(line.text))).toEqual(evidence.lines.map((line) => line.sha256));
    expect(Buffer.byteLength(historical("production-image-evidence.json"))).toBeLessThan(4096);
  });
});
const unpack = (input) => JSON.parse(input.capture.text);
const changeCapture = (input, mutate) => {
  const capture = unpack(input);
  mutate(capture);
  input.capture = bound(capture);
  if (input.supplementary.schemaObservation) input.supplementary.schemaObservation.captureSha256 = input.capture.sha256;
};
const changeReceipt = (input, mutate) => {
  const observation = input.supplementary.schemaObservation;
  const receipt = JSON.parse(observation.receipt.text);
  mutate(receipt);
  observation.receipt = bound(receipt);
};
const changeExecution = (evidence, mutate) => {
  const execution = JSON.parse(evidence.execution.text);
  mutate(execution);
  evidence.execution = bound(execution);
};

describe("offline cutover gate assembly", () => {
  let root, floor, head, subfloor;
  const capturedAt = "2030-01-02T00:00:00.000Z";
  const startedAt = "2030-01-02T00:02:00.000Z";
  const observationStart = "2030-01-02T00:01:00.000Z";
  const observationEnd = "2030-01-02T00:01:01.000Z";
  const ledger = ["20261016_collections_anonymous_owner_activation", "synthetic_later_migration"];
  const databaseUrl = "postgresql://synthetic.invalid/synthetic_collections";
  const git = (...args) =>
    execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const commit = (message) => {
    git("add", ".");
    git("-c", "user.name=Synthetic Fixture", "-c", "user.email=synthetic@example.invalid", "commit", "-m", message);
    return git("rev-parse", "HEAD");
  };
  // The temporary history is a test seam, never production ancestry authority.
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "synthetic-cutover-assembly-"));
    git("init", "--initial-branch=main");
    writeFileSync(join(root, "synthetic.txt"), "before activation\n");
    subfloor = commit("synthetic before floor");
    const path = join(root, "bounded-contexts/collections/support/runtime-support");
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, "anonymous-owner-activation.ts"), "// synthetic activation floor\n");
    floor = commit("synthetic floor");
    writeFileSync(join(root, "synthetic.txt"), "after activation\n");
    head = commit("synthetic descendant");
    expect(deriveFloor(root)).toBe(floor);
  });
  afterAll(() => {
    expect(dirname(resolve(root))).toBe(resolve(tmpdir()));
    expect(basename(root)).toMatch(/^synthetic-cutover-assembly-/);
    rmSync(root, { recursive: true, force: true });
  });
  const seam = () => ({
    deriveFloor: () => floor,
    containsFloor: (_root, expected, revision) => expected === floor && [floor, head].includes(revision),
  });
  const execution = (packetless = true) => ({
    databaseId: 900000000001,
    headSha: head,
    status: "completed",
    conclusion: packetless ? "failure" : "success",
    jobs: [
      {
        databaseId: 900000000002,
        status: "completed",
        conclusion: packetless ? "failure" : "success",
        startedAt: observationStart,
        completedAt: observationEnd,
        steps: [
          {
            number: 7,
            name: "Run protected Collections cutover",
            status: "completed",
            conclusion: packetless ? "failure" : "success",
            startedAt: observationStart,
            completedAt: observationEnd,
          },
        ],
      },
    ],
  });
  const input = () => {
    const capture = syntheticProviderCapture();
    capture.capturedAt = capturedAt;
    capture.head = head;
    capture.fields.environment = concrete("staging");
    capture.fields.databaseIdentityDigest = concrete(databaseIdentityDigest("staging", databaseUrl));
    capture.fields.releaseCommit = concrete(head);
    capture.fields.deployedCommitAncestry = concrete({
      floor,
      revisions: [
        { revision: 1, status: "deployed", commit: head, digest: `sha256:${"4".repeat(64)}`, containsFloor: true },
      ],
    });
    const sources = {
      serving: ["rollouts", "deployments", "replicasets", "pods"],
      suspended: ["jobs", "cronjobs"],
      dormant: ["rollouts", "deployments", "replicasets"],
      rollback: ["replicasets", "helm"],
      job: ["jobs"],
      cronjob: ["cronjobs"],
      session: ["sessions"],
    };
    for (const kind of packetModule.WRITER_KINDS) {
      const items =
        kind === "serving"
          ? [
              {
                id: "deployments:synthetic/synthetic-api",
                images: [`synthetic.invalid/platform:${head}`],
                revisions: [head],
                containsFloor: true,
                replicas: 1,
              },
            ]
          : [];
      capture.fields[`writers.${kind}`] = {
        items,
        collected: items.length,
        authoritativeTotal: items.length,
        source: "synthetic-source",
        coverage: Object.fromEntries(
          sources[kind].map((source) => [
            source,
            { status: "complete", listed: ["deployments", "helm", "sessions"].includes(source) ? 1 : 0 },
          ]),
        ),
      };
    }
    const session = capture.fields["writers.session"];
    session.items = [
      {
        id: "backend:4301",
        pid: 4301,
        backendStart: capturedAt,
        roleDigest: "b".repeat(64),
        classification: "pooler",
        poolMatch: { pid: true, backendStart: true, role: true },
        revisions: [head],
        containsFloor: true,
      },
    ];
    session.collected = session.authoritativeTotal = 1;
    session.pool = concrete({
      context: "collections",
      name: "collections-runtime",
      mode: "transaction",
      size: 4,
      hostDigest: "a".repeat(64),
      userDigest: "b".repeat(64),
    });
    session.pooledRead = concrete({ pid: 4301, backendStart: capturedAt });
    session.holders = {
      source: "synthetic-source",
      collected: 1,
      authoritativeTotal: 1,
      items: [
        {
          id: "capture:900000000003/1",
          source: "capture",
          workflow: ".github/workflows/collections-cutover-authority-capture.yml",
          credentialSource: "DATABASE_URL_COLLECTIONS",
          revisions: [head],
          containsFloor: true,
        },
      ],
      exclusions: [],
      coverage: {
        workflows: { status: "complete", listed: 0, pooledSteps: 0 },
        runs: {},
        kubernetes: { status: "complete", listed: 0 },
      },
    };
    const captureBinding = bound(capture);
    const receipt = {
      format: "collections-privacy-cutover-receipt/v1",
      mode: "dry-run",
      target: "staging",
      dbIdentityDigest: databaseIdentityDigest("staging", databaseUrl),
      floorCommit: floor,
      startedAt: observationStart,
      endedAt: observationEnd,
      schemaLedger: ledger,
      schemaVersion: hash(JSON.stringify(ledger)),
      codes: ["packet-digest"],
      fencePresent: true,
      packet: null,
      packetText: null,
      packetSha256: null,
      gates: { packet: false, schema: false },
    };
    return {
      target: "staging",
      root,
      floorCommit: floor,
      activationMergedAt: "2030-01-01T00:00:00.000Z",
      startedAt,
      capture: captureBinding,
      supplementary: {
        images: [],
        retirements: [],
        terminations: [],
        schemaObservation: {
          captureSha256: captureBinding.sha256,
          execution: bound(execution()),
          jobId: 900000000002,
          stepNumber: 7,
          artifactJobId: 900000000002,
          artifactName: "synthetic-observation",
          receipt: bound(receipt),
        },
      },
    };
  };
  const assemble = (value) => packetModule.assembleAuthorityPacket(value, seam());
  const refused = (value, code) => {
    const result = assemble(value);
    expect(result.verdict).toBe("refused");
    expect(result.codes).toContain(code);
    for (const key of ["packet", "packetText", "packetSha256"]) expect(result).not.toHaveProperty(key);
    return result;
  };

  it("deterministic export bytes pass the real validator with a matching observation and temporary Git ancestry", () => {
    const value = input();
    const result = packetModule.assembleAuthorityPacket(value);
    expect(result).toMatchObject({ verdict: "complete", codes: [] });
    expect(result.packetSha256).toBe(hash(result.packetText));
    expect(Buffer.byteLength(result.packetText)).toBeLessThanOrEqual(16 * 1024);
    expect(assemble(structuredClone(value))).toEqual(result);
    expect(
      validatePacket(
        {
          root,
          databaseUrl,
          target: "staging",
          packetText: result.packetText,
          packetSha256: result.packetSha256,
          startedAt,
        },
        { schemaLedger: ledger, fencePresent: true },
        floor,
      ),
    ).toEqual(result.packet);
    expect(() =>
      validatePacket(
        {
          root,
          databaseUrl,
          target: "staging",
          packetText: result.packetText,
          packetSha256: "0".repeat(64),
          startedAt,
        },
        { schemaLedger: ledger, fencePresent: true },
        floor,
      ),
    ).toThrow("packet-digest");
  });

  it.each([
    ["missing input", (value) => delete value.capture, "capture-binding"],
    ["changed capture bytes", (value) => (value.capture.text += " "), "capture-binding"],
    ["wrong target", (value) => (value.target = "production"), "capture-incomplete"],
    ["stale capture", (value) => (value.startedAt = "2030-01-02T00:31:00.001Z"), "capture-stale"],
    ["future capture", (value) => (value.startedAt = "2030-01-01T00:00:00.000Z"), "capture-stale"],
    ["missing activation time", (value) => delete value.activationMergedAt, "capture-stale"],
    ["wrong floor", (value) => (value.floorCommit = head), "floor-mismatch"],
    [
      "missing source",
      (value) => changeCapture(value, (capture) => delete capture.fields.releaseCommit.source),
      "capture-incomplete",
    ],
    [
      "failed capture",
      (value) => changeCapture(value, (capture) => capture.codes.push("synthetic-failure")),
      "capture-incomplete",
    ],
    [
      "unknown field",
      (value) => changeCapture(value, (capture) => (capture.fields.injected = concrete("x"))),
      "capture-incomplete",
    ],
  ])("refuses %s without partial packet", (_, mutate, code) => {
    const value = input();
    mutate(value);
    refused(value, code);
  });

  it("refuses a shallow temporary checkout and missing objects without weakening deriveFloor", () => {
    const shallow = join(root, ".git/shallow");
    writeFileSync(shallow, `${head}\n`);
    try {
      expect(packetModule.assembleAuthorityPacket(input()).codes).toEqual(["floor-ambiguous"]);
    } finally {
      rmSync(shallow);
    }
    const value = input();
    changeCapture(value, (capture) => {
      const writer = capture.fields["writers.serving"].items[0];
      writer.revisions = ["e".repeat(40)];
      writer.images = [`synthetic.invalid/platform:${"e".repeat(40)}`];
    });
    expect(packetModule.assembleAuthorityPacket(value)).toMatchObject({
      verdict: "refused",
      codes: ["writer-authority"],
    });
  });

  it("all-image-floor: mixed init/regular/ephemeral images cannot inherit a known revision or owner", () => {
    const value = input();
    changeCapture(value, (capture) => {
      const item = capture.fields["writers.serving"].items[0];
      item.images.push("synthetic.invalid/sidecar:unknown");
      item.ownerReferences = [{ kind: "Deployment", name: "synthetic-parent" }];
    });
    refused(value, "image-provenance");
    changeCapture(value, (capture) => {
      const item = capture.fields["writers.serving"].items[0];
      item.images[1] = `synthetic.invalid/sidecar:${subfloor}`;
      item.revisions = [head, subfloor];
    });
    refused(value, "writer-authority");
    changeCapture(value, (capture) => {
      const item = capture.fields["writers.serving"].items[0];
      item.images[1] = `synthetic.invalid/sidecar:${floor}`;
      item.revisions = [head, floor];
    });
    const result = assemble(value);
    expect(result.verdict).toBe("complete");
    expect(result.packet.writers.serving).toHaveLength(2);
    expect(result.packet.writers.serving.map((item) => item.revision).sort()).toEqual([head, floor].sort());
    expect(result.packet.inventory).toEqual({ collected: 3, authoritativeTotal: 3 });
    changeCapture(value, (capture) => {
      capture.fields["writers.serving"].items[0].images.reverse();
      capture.fields["writers.serving"].items[0].revisions.reverse();
    });
    expect(assemble(value)).toEqual(result);
    expect(
      validatePacket(
        {
          root,
          databaseUrl,
          target: "staging",
          packetText: result.packetText,
          packetSha256: result.packetSha256,
          startedAt,
        },
        { schemaLedger: ledger, fencePresent: true },
        floor,
      ),
    ).toEqual(result.packet);
  });

  it("all-image-floor: missing captured revisions cannot be filled from a tag alone", () => {
    const value = input();
    changeCapture(value, (capture) => {
      capture.fields["writers.serving"].items[0].revisions = [];
    });
    refused(value, "image-provenance");
  });

  const digestProof = (value) => {
    const image = `synthetic.invalid/platform@sha256:${"6".repeat(64)}`;
    changeCapture(value, (capture) => {
      const writer = capture.fields["writers.serving"].items[0];
      writer.images = [image];
      writer.revisions = [];
      writer.containsFloor = null;
    });
    const run = execution(false);
    run.jobs[0].startedAt = run.jobs[0].steps[0].startedAt = "2030-01-01T00:00:01.000Z";
    run.jobs[0].completedAt = run.jobs[0].steps[0].completedAt = "2030-01-01T00:00:02.000Z";
    const lines = [`RELEASE_COMMIT: ${head}`, `RELEASE_IMAGE_DIGEST: sha256:${"6".repeat(64)}`].map(
      (binding, index) => {
        const text = `Synthetic job\tSynthetic step\t2030-01-01T00:00:01.500Z   ${binding}`;
        return { number: index + 1, text, sha256: hash(text) };
      },
    );
    const proof = {
      captureSha256: value.capture.sha256,
      sourceId: "deployments:synthetic/synthetic-api",
      image,
      commit: head,
      execution: bound(run),
      jobId: 900000000002,
      stepNumber: 7,
      lines,
      compare: {
        artifactSha256: hash("synthetic-compare-source"),
        status: "ahead",
        ahead_by: 1,
        behind_by: 0,
        base: floor,
        mergeBase: floor,
        head,
      },
    };
    value.supplementary.images = [proof];
    return proof;
  };

  it("all-image-floor: immutable digest provenance binds capture, source, image, executed job/step, exact lines and GitHub compare", () => {
    const value = input();
    digestProof(value);
    expect(assemble(value)).toMatchObject({
      verdict: "complete",
      packet: { writers: { serving: [{ revision: head, state: "deployed" }] } },
    });
  });

  it.each([
    ["missing proof", (value) => (value.supplementary.images = [])],
    ["duplicate proof", (value, proof) => value.supplementary.images.push(structuredClone(proof))],
    ["wrong digest", (_value, proof) => (proof.image = `synthetic.invalid/platform@sha256:${"7".repeat(64)}`)],
    ["wrong capture", (_value, proof) => (proof.captureSha256 = "a".repeat(64))],
    ["wrong source", (_value, proof) => (proof.sourceId = "deployments:synthetic/other")],
    ["wrong commit", (_value, proof) => (proof.commit = subfloor)],
    ["wrong exact line hash", (_value, proof) => (proof.lines[0].sha256 = "a".repeat(64))],
    ["missing compare", (_value, proof) => delete proof.compare],
    ["asserted ancestor only", (_value, proof) => (proof.compare = { ancestor: true })],
    ["compare behind", (_value, proof) => (proof.compare.behind_by = 1)],
    ["inconsistent identical compare", (_value, proof) => (proof.compare.status = "identical")],
    ["compare wrong base", (_value, proof) => (proof.compare.mergeBase = subfloor)],
    ["compare wrong head", (_value, proof) => (proof.compare.head = floor)],
    ["compare missing artifact hash", (_value, proof) => delete proof.compare.artifactSha256],
    [
      "skipped owning step",
      (_value, proof) => changeExecution(proof, (run) => (run.jobs[0].steps[0].conclusion = "skipped")),
    ],
    ["red owning job", (_value, proof) => changeExecution(proof, (run) => (run.jobs[0].conclusion = "failure"))],
    ["wrong job", (_value, proof) => proof.jobId++],
    [
      "duplicate owning step",
      (_value, proof) => changeExecution(proof, (run) => run.jobs[0].steps.push(structuredClone(run.jobs[0].steps[0]))),
    ],
  ])("all-image-floor: refuses %s", (_, mutate) => {
    const value = input();
    const proof = digestProof(value);
    mutate(value, proof);
    refused(value, "image-provenance");
  });

  it("all-image-floor: zero-replica compatible rollbacks are deployed, never retired", () => {
    const value = input();
    changeCapture(value, (capture) => {
      const set = capture.fields["writers.rollback"];
      set.items = [
        { id: "helm:chase-sets-platform/1", revisions: [floor], containsFloor: true, replicas: 0, state: "retired" },
      ];
      set.collected = set.authoritativeTotal = 1;
      set.coverage.helm.listed = 2;
      capture.fields.deployedCommitAncestry.value.revisions.push({ revision: 1, commit: floor, containsFloor: true });
      capture.fields.deployedCommitAncestry.value.revisions[0].revision = 2;
    });
    expect(assemble(value)).toMatchObject({
      verdict: "complete",
      packet: { writers: { rollback: [{ id: "helm:chase-sets-platform/1", state: "deployed", revision: floor }] } },
    });
  });

  it.each([
    ["wrong pool", (session) => (session.pool.value.name = "synthetic-other-pool")],
    ["wrong PID", (session) => session.pooledRead.value.pid++],
    ["wrong backend birth", (session) => (session.pooledRead.value.backendStart = observationStart)],
    ["wrong role", (session) => (session.items[0].roleDigest = "c".repeat(64))],
    ["unclassified", (session) => (session.items[0].classification = "unknown")],
    ["incomplete holders", (session) => session.holders.authoritativeTotal++],
    ["missing coverage", (session) => delete session.holders.coverage.runs],
    ["unknown coverage", (session) => (session.holders.coverage.workflows.status = "unknown")],
    ["unknown holder", (session) => (session.holders.items[0].containsFloor = null)],
    ["sub-floor holder", (session) => (session.holders.items[0].revisions = [subfloor])],
    [
      "aggregate ordinal",
      (session) => {
        session.items[0].id = "session:1";
      },
    ],
    [
      "missing holder",
      (session) => {
        session.holders.items = [];
        session.holders.collected = session.holders.authoritativeTotal = 0;
      },
    ],
  ])("session-proof: refuses %s", (_, mutate) => {
    const value = input();
    changeCapture(value, (capture) => mutate(capture.fields["writers.session"]));
    refused(value, "session-proof");
  });

  it("session-proof: each rerun uses its actual head, not capture main; workflow-step identities use the canonical shape", () => {
    const value = input();
    changeCapture(value, (capture) => {
      const session = capture.fields["writers.session"];
      session.holders.items.push(
        {
          id: "run:900000000004/2",
          source: "workflow-run",
          workflow: "synthetic.yml",
          runId: 900000000004,
          attempt: 2,
          jobIds: [900000000005],
          credentialSource: "DATABASE_URL_COLLECTIONS",
          revisions: [floor],
          containsFloor: true,
        },
        {
          id: "workflow:synthetic.yml#synthetic-job/3",
          source: "workflow-step",
          workflow: "synthetic.yml",
          credentialSource: "DATABASE_URL_COLLECTIONS",
          revisions: [head],
          containsFloor: true,
        },
      );
      session.holders.collected = session.holders.authoritativeTotal = 3;
      session.holders.coverage.workflows = { status: "complete", listed: 1, pooledSteps: 1 };
      session.holders.coverage.runs = { "synthetic.yml": { status: "complete", listed: 1, executing: 1 } };
      session.items[0].revisions = [floor, head].sort();
    });
    expect(assemble(value)).toMatchObject({ verdict: "complete" });
    changeCapture(value, (capture) => (capture.fields["writers.session"].holders.items[1].revisions = [subfloor]));
    refused(value, "session-proof");
  });

  it.each([
    ["absent observation", (value) => (value.supplementary.schemaObservation = null)],
    ["wrong bytes", (value) => (value.supplementary.schemaObservation.receipt.text += " ")],
    ["extra error", (value) => changeReceipt(value, (receipt) => receipt.codes.push("redaction-observation-failed"))],
    [
      "stale observation",
      (value) => changeReceipt(value, (receipt) => (receipt.startedAt = "2030-01-01T00:00:00.000Z")),
    ],
    ["wrong DB", (value) => changeReceipt(value, (receipt) => (receipt.dbIdentityDigest = "e".repeat(64)))],
    ["wrong target", (value) => changeReceipt(value, (receipt) => (receipt.target = "production"))],
    ["wrong floor", (value) => changeReceipt(value, (receipt) => (receipt.floorCommit = head))],
    [
      "missing activation migration",
      (value) =>
        changeReceipt(value, (receipt) => {
          receipt.schemaLedger = ["synthetic_later_migration"];
          receipt.schemaVersion = hash(JSON.stringify(receipt.schemaLedger));
        }),
    ],
    ["omitted ledger entry", (value) => changeReceipt(value, (receipt) => receipt.schemaLedger.pop())],
    ["unsorted ledger", (value) => changeReceipt(value, (receipt) => receipt.schemaLedger.reverse())],
    [
      "duplicate ledger",
      (value) => changeReceipt(value, (receipt) => receipt.schemaLedger.push(receipt.schemaLedger[0])),
    ],
    ["wrong head", (value) => changeExecution(value.supplementary.schemaObservation, (run) => (run.headSha = floor))],
    ["wrong artifact job", (value) => value.supplementary.schemaObservation.artifactJobId++],
    ["wrong capture binding", (value) => (value.supplementary.schemaObservation.captureSha256 = "f".repeat(64))],
    [
      "missing owning step",
      (value) => changeExecution(value.supplementary.schemaObservation, (run) => (run.jobs[0].steps = [])),
    ],
    [
      "duplicate owning job",
      (value) =>
        changeExecution(value.supplementary.schemaObservation, (run) => run.jobs.push(structuredClone(run.jobs[0]))),
    ],
    [
      "skipped owning step",
      (value) =>
        changeExecution(value.supplementary.schemaObservation, (run) => (run.jobs[0].steps[0].conclusion = "skipped")),
    ],
    [
      "failed different step",
      (value) =>
        changeExecution(value.supplementary.schemaObservation, (run) =>
          run.jobs[0].steps.push({ number: 8, conclusion: "failure" }),
        ),
    ],
    ["packetless gate PASS", (value) => changeReceipt(value, (receipt) => (receipt.gates.schema = true))],
    [
      "packetless receipt claiming success",
      (value) => {
        changeReceipt(value, (receipt) => {
          receipt.codes = [];
        });
        value.supplementary.schemaObservation.execution = bound(execution(false));
      },
    ],
  ])("schema-source: refuses %s", (_, mutate) => {
    const value = input();
    mutate(value);
    refused(value, "schema-source");
  });

  it("schema-source: traces ordered observe SQL through a real packetless runner receipt, then validates a separate packet-bearing dry-run", async () => {
    const source = readFileSync(
      new URL("../bounded-contexts/collections/features/saved-lists/api/anonymous-owner-redaction.ts", import.meta.url),
      "utf8",
    );
    expect(source).toContain("SELECT migration_id FROM bounded_context_schema_migrations ORDER BY migration_id");
    expect(source).toContain("schemaLedger: ledger.rows.map((row) => row.migration_id)");
    const value = input();
    const snapshot = {
      schemaLedger: ledger,
      fencePresent: true,
      activation: { activated_at: null, floor_commit: null },
      before: 0,
      after: 0,
      processed: 0,
      mismatches: 0,
      durationMs: 0,
      codes: [],
    };
    const options = {
      root,
      target: "staging",
      jobEnvironment: "staging",
      mode: "dry-run",
      ref: "refs/heads/main",
      defaultBranch: "main",
      databaseUrl,
      startedAt: observationStart,
      packetText: "",
      packetSha256: "",
    };
    const dependencies = {
      pool: {},
      redact: async (_pool, options) => {
        options.authorize(snapshot);
        return snapshot;
      },
    };
    vi.useFakeTimers();
    vi.setSystemTime(new Date(observationEnd));
    try {
      const receipt = await runRedaction(options, dependencies);
      expect(receipt).toMatchObject({ codes: ["packet-digest"], packet: null });
      expect(Object.values(receipt.gates).every((value) => value === false)).toBe(true);
      value.supplementary.schemaObservation.receipt = bound(receipt);
      const assembled = packetModule.assembleAuthorityPacket(value);
      expect(assembled.verdict).toBe("complete");
      vi.setSystemTime(new Date("2030-01-02T00:03:00.000Z"));
      const positive = await runRedaction(
        { ...options, startedAt, packetText: assembled.packetText, packetSha256: assembled.packetSha256 },
        dependencies,
      );
      expect(positive).toMatchObject({ codes: [], packet: assembled.packet });
      expect(Date.parse(positive.endedAt)).toBeGreaterThanOrEqual(Date.parse(positive.startedAt));
      value.startedAt = "2030-01-02T00:04:00.000Z";
      const successExecution = execution(false);
      successExecution.jobs[0].startedAt = successExecution.jobs[0].steps[0].startedAt = positive.startedAt;
      successExecution.jobs[0].completedAt = successExecution.jobs[0].steps[0].completedAt = positive.endedAt;
      value.supplementary.schemaObservation.execution = bound(successExecution);
      value.supplementary.schemaObservation.receipt = bound(positive);
      expect(packetModule.assembleAuthorityPacket(value)).toMatchObject({
        verdict: "complete",
        packet: assembled.packet,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  const retirementEvidence = (value, sourceId, session = false) => {
    const capture = unpack(value);
    const item = capture.fields[session ? "writers.session" : "writers.serving"].items[0];
    const receipt = {
      format: session ? "collections-session-termination/v1" : "collections-writer-retirement/v1",
      captureSha256: value.capture.sha256,
      sourceId,
      target: "staging",
      dbIdentityDigest: capture.fields.databaseIdentityDigest.value,
      floorCommit: floor,
      authorizedBy: "synthetic-authorization",
      recreationPrevented: true,
      executedAt: observationEnd,
      ...(session
        ? { pid: item.pid, backendStart: item.backendStart, roleDigest: item.roleDigest, reconnectionPrevented: true }
        : { objectUid: "synthetic-object-uid" }),
    };
    return {
      sourceId,
      head,
      execution: bound(execution(false)),
      jobId: 900000000002,
      stepNumber: 7,
      receipt: bound(receipt),
      owner: bound({
        format: "collections-writer-owner/v1",
        captureSha256: value.capture.sha256,
        sourceId,
        objectUid: "synthetic-object-uid",
        target: "staging",
        dbIdentityDigest: receipt.dbIdentityDigest,
        observedAt: observationStart,
        images: item.images ?? [],
      }),
    };
  };

  it("all-image-floor: sub-floor retirement requires an executed receipt and separate exact-UID owner binding", () => {
    const value = input();
    changeCapture(value, (capture) => {
      const writer = capture.fields["writers.serving"].items[0];
      writer.revisions = [subfloor];
      writer.images = [`synthetic.invalid/platform:${subfloor}`];
      writer.containsFloor = false;
    });
    refused(value, "writer-authority");
    const evidence = retirementEvidence(value, "deployments:synthetic/synthetic-api");
    value.supplementary.retirements = [evidence];
    expect(assemble(value)).toMatchObject({
      verdict: "complete",
      packet: { writers: { serving: [{ state: "retired", revision: null }] } },
    });
    const contradiction = input();
    changeCapture(contradiction, (capture) => {
      const writer = capture.fields["writers.serving"].items[0];
      writer.revisions = [subfloor];
      writer.images = [`synthetic.invalid/platform:${subfloor}`];
      writer.containsFloor = true;
    });
    contradiction.supplementary.retirements = [
      retirementEvidence(contradiction, "deployments:synthetic/synthetic-api"),
    ];
    refused(contradiction, "writer-authority");
    const owner = evidence.owner;
    delete evidence.owner;
    refused(value, "writer-authority");
    evidence.owner = owner;
    const receipt = JSON.parse(evidence.receipt.text);
    receipt.objectUid = "synthetic-recreated-object";
    evidence.receipt = bound(receipt);
    refused(value, "writer-authority");
    receipt.objectUid = "synthetic-object-uid";
    receipt.recreationPrevented = false;
    evidence.receipt = bound(receipt);
    refused(value, "writer-authority");
  });

  it("session-proof: only an exact executed authorized session receipt can terminate; the pooler is never terminated", () => {
    const value = input();
    changeCapture(value, (capture) => {
      const session = capture.fields["writers.session"].items[0];
      session.id = "backend:4302";
      session.pid = 4302;
      session.classification = "unknown";
      session.containsFloor = null;
      session.revisions = [];
    });
    refused(value, "session-proof");
    const evidence = retirementEvidence(value, "backend:4302", true);
    value.supplementary.terminations = [evidence];
    expect(assemble(value)).toMatchObject({
      verdict: "complete",
      packet: { writers: { session: [{ id: "backend:4302", state: "terminated", revision: null }] } },
    });
    const receipt = JSON.parse(evidence.receipt.text);
    receipt.backendStart = observationStart;
    evidence.receipt = bound(receipt);
    refused(value, "session-proof");
    const pooler = input();
    changeCapture(pooler, (capture) => {
      const session = capture.fields["writers.session"].items[0];
      session.classification = "unknown";
    });
    pooler.supplementary.terminations = [retirementEvidence(pooler, "backend:4301", true)];
    refused(pooler, "session-proof");
  });

  it.each([
    ["missing kind", (capture) => delete capture.fields["writers.dormant"]],
    ["truncated inventory", (capture) => capture.fields["writers.serving"].authoritativeTotal++],
    [
      "duplicate item",
      (capture) => {
        const set = capture.fields["writers.serving"];
        set.items.push(set.items[0]);
        set.collected = set.authoritativeTotal = 2;
      },
    ],
    ["missing source coverage", (capture) => delete capture.fields["writers.rollback"].coverage.helm],
    ["unknown source coverage", (capture) => (capture.fields["writers.serving"].coverage.pods.status = "unknown")],
    ["conflicting totals", (capture) => capture.fields["writers.rollback"].coverage.replicasets.listed++],
    ["Helm cap", (capture) => (capture.fields["writers.rollback"].coverage.helm.listed = 256)],
    ["unknown writer source", (capture) => (capture.fields["writers.serving"].items[0].id = "synthetic:unknown")],
  ])("complete-cli: refuses %s", (_, mutate) => {
    const value = input();
    changeCapture(value, mutate);
    expect(assemble(value).verdict).toBe("refused");
  });

  it("complete-cli: actual assembly CLI returns identical bytes and old completeness CLI remains compatible", () => {
    const value = input();
    const path = join(root, "assembly-input.json");
    writeFileSync(path, JSON.stringify(value));
    const script = resolve("scripts/collections-cutover-authority-packet.mjs");
    const result = JSON.parse(execFileSync(process.execPath, [script, "--assemble", path], { encoding: "utf8" }));
    expect(result).toEqual(packetModule.assembleAuthorityPacket(value));
    writeFileSync(path, "{}");
    let refusedOutput;
    try {
      execFileSync(process.execPath, [script, "--assemble", path], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      expect(error.status).toBe(2);
      refusedOutput = JSON.parse(error.stdout);
    }
    expect(refusedOutput.verdict).toBe("refused");
    const packet = syntheticCompletePacket(packetModule);
    for (const [key, name] of [
      ["writerAuthority", "collections-writer-authority-v1.json"],
      ["authorityMatrix", "collections-cutover-authority-matrix.json"],
      ["runnerBinding", "collections-redaction-runner-binding.json"],
    ])
      writeFileSync(join(root, name), JSON.stringify(packet[key]));
    const old = JSON.parse(execFileSync(process.execPath, [script, root], { encoding: "utf8" }));
    expect(old).toMatchObject({ applied: [], verification: { verdict: "complete" } });
  });

  it("complete-cli: enforces bounded input/output and never echoes secret or personal metadata", () => {
    const value = input();
    value.supplementary.images = [{ text: "x".repeat(2 * 1024 * 1024) }];
    refused(value, "assembly-input");
    const personal = input();
    changeCapture(
      personal,
      (capture) =>
        (capture.fields["writers.serving"].items[0].annotations = {
          application: "synthetic-private-application",
          address: "synthetic-private-address",
        }),
    );
    expect(JSON.stringify(assemble(personal))).not.toMatch(/synthetic-private/);
    const secret = input();
    secret.supplementary.images = [{ private: `ghp_${"x".repeat(30)}` }];
    expect(JSON.stringify(refused(secret, "assembly-input"))).not.toContain("ghp_");
    const oversized = input();
    changeCapture(oversized, (capture) => {
      const set = capture.fields["writers.serving"];
      set.items = Array.from({ length: 150 }, (_, index) => ({
        ...set.items[0],
        id: `deployments:synthetic/${"a".repeat(120)}${index}`,
      }));
      set.collected = set.authoritativeTotal = 150;
      set.coverage.deployments.listed = 150;
      capture.fields["writers.dormant"].coverage.deployments.listed = 150;
    });
    refused(oversized, "packet-size");
    const source = readFileSync(new URL("./collections-cutover-authority-packet.mjs", import.meta.url), "utf8");
    expect(source).not.toMatch(
      /\b(?:fetch|execFile|spawn|request|Pool)\s*\(|process\.env|import\(["'](?:pg|https?|.+capture)/,
    );
  });
});
