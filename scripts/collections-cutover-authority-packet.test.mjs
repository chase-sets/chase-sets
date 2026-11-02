// The 16 8933-impl-g1 `authority-packet-completeness` tests (sha256 89f8b29a…), its named mutants M1–M10 and
// one test per `applyProviderCapture` refusal. Every identity below is SYNTHETIC (synthetic-* ids,
// repeated-digit SHAs); none is a captured provider fact.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, expect, it, test } from "vitest";

import * as packetModule from "./collections-cutover-authority-packet.mjs";

const { applyProviderCapture, PROVIDER_CAPTURE_FIELDS, PROVIDER_CAPTURE_SCHEMA_VERSION } = packetModule;

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

function syntheticProviderCapture(target = "staging") {
  const writers = ["serving", "suspended", "dormant", "rollback", "job", "cronjob", "session"];
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
