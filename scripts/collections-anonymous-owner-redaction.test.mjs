import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { databaseUrlsFromTerraformState } from "./terraform-state-database-urls.mjs";
import {
  databaseIdentityDigest,
  deriveFloor,
  runRedaction,
  verifyReceipts,
} from "./collections-anonymous-owner-redaction.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const runner = process.env.VITEST ? await import("vitest") : await import("node:test");
function test(name, action) {
  return runner.test(name, async (context) =>
    action(
      process.env.VITEST
        ? {
            after: (cleanup) => context.onTestFinished(cleanup),
            test: async (_name, subtest) => subtest(),
          }
        : context,
    ),
  );
}
const kinds = ["serving", "suspended", "dormant", "rollback", "job", "cronjob", "session"];
const now = "2026-10-19T12:00:00.000Z";
const exporterOutput = databaseUrlsFromTerraformState(
  {
    resources: [
      {
        type: "digitalocean_database_cluster",
        name: "postgres",
        instances: [{ attributes: { host: "fixture.invalid", port: 25060 } }],
      },
      {
        type: "digitalocean_database_db",
        name: "contexts",
        instances: [{ index_key: "collections", attributes: { name: "collections" } }],
      },
      {
        type: "digitalocean_database_user",
        name: "contexts",
        instances: [{ index_key: "collections", attributes: { name: "fixture_user", password: "fixture_password" } }],
      },
    ],
  },
  { contexts: ["collections"], environment: "staging", caPath: "/synthetic/ca.pem" },
);
const url = exporterOutput[0].url;
const ledger = ["20261016_collections_anonymous_owner_activation"];
const floorPath = "bounded-contexts/collections/support/runtime-support/anonymous-owner-activation.ts";

function history() {
  const root = mkdtempSync(join(tmpdir(), "collections-redaction-"));
  const git = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", timeout: 10_000 }).trim();
  git("init", "--quiet");
  git("config", "user.email", "fixture@example.invalid");
  git("config", "user.name", "Synthetic fixture");
  mkdirSync(join(root, "bounded-contexts/collections/support/runtime-support"), { recursive: true });
  writeFileSync(join(root, floorPath), "export const activation = true;\n");
  git("add", ".");
  git("commit", "--quiet", "-m", "synthetic activation floor");
  const floor = git("rev-parse", "HEAD");
  git("commit", "--quiet", "--allow-empty", "-m", "synthetic recovery commit");
  return {
    root,
    git,
    floor,
    recovery: git("rev-parse", "HEAD"),
    close: () => rmSync(root, { recursive: true, force: true }),
  };
}

function fixture(h, target = "staging") {
  const packet = {
    schemaVersion: "collections-cutover-gate/v1",
    target,
    capturedAt: now,
    floorCommit: h.floor,
    dbIdentityDigest: databaseIdentityDigest(target, url),
    schemaLedger: [...ledger],
    inventory: { collected: 7, authoritativeTotal: 7 },
    writers: Object.fromEntries(
      kinds.map((kind) => [kind, [{ id: `synthetic-${kind}`, state: "deployed", revision: h.recovery }]]),
    ),
  };
  const options = {
    mode: "redact",
    target,
    jobEnvironment: target,
    approvalReference: "synthetic approval",
    ref: "refs/heads/main",
    defaultBranch: "main",
    root: h.root,
    databaseUrl: url,
    packetText: JSON.stringify(packet),
    packetSha256: hash(JSON.stringify(packet)),
    startedAt: now,
  };
  let writes = 0;
  let activation = { singleton: true, activated_at: now, gate_packet_sha256: "a".repeat(64), floor_commit: h.floor };
  let remaining = 1;
  let fencePresent = true;
  const dependencies = {
    async redact(_pool, { dryRun, authorize }) {
      authorize?.({ activation, fencePresent, schemaLedger: ledger, remaining });
      if (!dryRun) {
        writes++;
        remaining = 0;
      }
      return {
        activation,
        fencePresent,
        schemaLedger: ledger,
        before: dryRun ? remaining : 1,
        processed: dryRun ? 0 : 1,
        after: remaining,
        mismatches: 0,
        durationMs: 1,
        codes: [],
      };
    },
    async activate(_pool, input) {
      writes++;
      if (!activation.activated_at)
        activation = {
          singleton: true,
          activated_at: "2026-10-19 12:00:00+00",
          gate_packet_sha256: input.gatePacketSha256,
          floor_commit: input.floorCommit,
        };
      return activation;
    },
  };
  return {
    packet,
    options,
    dependencies,
    writes: () => writes,
    fenceAbsent: () => {
      fencePresent = false;
    },
    inactive: () => {
      activation = { singleton: true, activated_at: null, gate_packet_sha256: null, floor_commit: null };
    },
  };
}

test("redaction-runner-binding-refuses-missing-authority", async (t) => {
  const h = history();
  t.after(h.close);
  assert.equal(deriveFloor(h.root), h.floor);
  const mutations = [
    [
      "default-branch",
      (f) => {
        f.options.ref = "refs/heads/feature";
      },
    ],
    [
      "target-mismatch",
      (f) => {
        f.options.jobEnvironment = "production";
      },
    ],
    [
      "approval-required",
      (f) => {
        f.options.approvalReference = "";
      },
    ],
    [
      "packet-digest",
      (f) => {
        f.options.packetSha256 = "b".repeat(64);
      },
    ],
    [
      "packet-size",
      (f) => {
        f.options.packetText = " ".repeat(16_385);
      },
    ],
    [
      "packet-schema",
      (f) => {
        f.packet.schemaVersion = "unknown";
      },
    ],
    [
      "packet-keys",
      (f) => {
        f.packet.extra = true;
      },
    ],
    [
      "packet-stale",
      (f) => {
        f.packet.capturedAt = "2026-10-19T11:29:59.999Z";
      },
    ],
    [
      "packet-stale",
      (f) => {
        f.packet.capturedAt = "2026-10-19T12:00:00.001Z";
      },
    ],
    [
      "floor-mismatch",
      (f) => {
        f.packet.floorCommit = h.recovery;
      },
    ],
    [
      "db-identity",
      (f) => {
        f.options.databaseUrl = url.replace("fixture.invalid", "other.invalid");
      },
    ],
    [
      "schema-ledger",
      (f) => {
        f.packet.schemaLedger = [];
      },
    ],
    [
      "inventory-incomplete",
      (f) => {
        f.packet.inventory.authoritativeTotal++;
      },
    ],
    [
      "writer-unknown",
      (f) => {
        f.packet.writers.serving[0].state = "unknown";
      },
    ],
    [
      "writer-floor",
      (f) => {
        f.packet.writers.serving[0].revision = "f".repeat(40);
      },
    ],
    [
      "activation-required",
      (f) => {
        f.inactive();
      },
    ],
    [
      "database-authority",
      (f) => {
        f.options.databaseUrl = undefined;
      },
    ],
  ];
  for (const key of Object.keys(fixture(h).packet))
    mutations.push([
      "packet-keys",
      (f) => {
        delete f.packet[key];
      },
    ]);
  for (const kind of kinds)
    mutations.push([
      "writer-keys",
      (f) => {
        delete f.packet.writers[kind];
      },
    ]);
  for (const [code, mutate] of mutations)
    await t.test(code, async () => {
      const f = fixture(h);
      mutate(f);
      if (f.options.packetText.length < 16_385) {
        f.options.packetText = JSON.stringify(f.packet);
        if (code !== "packet-digest") f.options.packetSha256 = hash(f.options.packetText);
      }
      await assert.rejects(runRedaction(f.options, f.dependencies), { message: code });
      assert.equal(f.writes(), 0);
    });
  h.git("rm", floorPath);
  h.git("commit", "--quiet", "-m", "synthetic removal");
  assert.throws(() => deriveFloor(h.root), { message: "floor-ambiguous" });
  mkdirSync(join(h.root, "bounded-contexts/collections/support/runtime-support"), { recursive: true });
  writeFileSync(join(h.root, floorPath), "export const activation = false;\n");
  h.git("add", ".");
  h.git("commit", "--quiet", "-m", "synthetic reintroduction");
  assert.throws(() => deriveFloor(h.root), { message: "floor-ambiguous" });
});

test("redaction-runner-activates-once", async (t) => {
  const h = history();
  t.after(h.close);
  const f = fixture(h);
  f.inactive();
  f.options.mode = "dry-run";
  const dry = await runRedaction(f.options, f.dependencies);
  assert.equal(f.writes(), 0);
  assert.equal(dry.activation.activated_at, null);
  assert.equal(dry.floorCommit, h.floor);
  assert.equal(dry.fencePresent, true);
  assert.equal(dry.legacyRemaining, 1);
  assert.equal(dry.schemaVersion, hash(JSON.stringify(ledger)));
  f.options.mode = "activate";
  const first = await runRedaction(f.options, f.dependencies);
  const repeat = await runRedaction(f.options, f.dependencies);
  assert.deepEqual(first.activation, repeat.activation);
  assert.equal(first.activation.gate_packet_sha256, f.options.packetSha256);
});

test("dry-run discovers exporter-bound facts without blessing a missing gate packet", async (t) => {
  const h = history();
  t.after(h.close);
  const f = fixture(h);
  f.inactive();
  f.options.mode = "dry-run";
  delete f.options.packetText;
  delete f.options.packetSha256;
  const receipt = await runRedaction(f.options, f.dependencies);
  assert.equal(f.writes(), 0);
  assert.equal(receipt.dbIdentityDigest, databaseIdentityDigest("staging", url));
  assert.equal(receipt.floorCommit, h.floor);
  assert.deepEqual(receipt.schemaLedger, ledger);
  assert.equal(receipt.activation.activated_at, null);
  assert.equal(receipt.fencePresent, true);
  assert.equal(receipt.legacyRemaining, 1);
  assert.deepEqual(receipt.codes, ["packet-size"]);
  assert.equal(Object.values(receipt.gates).some(Boolean), false);
  assert.equal(receipt.packet, null);
});

test("collections-privacy-cutover-verifier-refuses-incomplete", async (t) => {
  const h = history();
  t.after(h.close);
  const receipts = [];
  for (const target of ["staging", "production"]) {
    const f = fixture(h, target);
    receipts.push(await runRedaction(f.options, f.dependencies));
  }
  assert.deepEqual(verifyReceipts(receipts), { valid: true, code: "verified-zero" });
  for (let index = 0; index < 2; index++) {
    assert.equal(verifyReceipts(receipts.filter((_, i) => i !== index)).valid, false);
    for (const gate of Object.keys(receipts[index].gates)) {
      const copy = structuredClone(receipts);
      delete copy[index].gates[gate];
      assert.equal(verifyReceipts(copy).valid, false, gate);
    }
    for (const kind of kinds) {
      const copy = structuredClone(receipts);
      copy[index].packet.writers[kind] = [];
      copy[index].packetText = JSON.stringify(copy[index].packet);
      copy[index].packetSha256 = hash(JSON.stringify(copy[index].packet));
      assert.equal(verifyReceipts(copy).valid, false, kind);
    }
    for (const key of Object.keys(receipts[index])) {
      const copy = structuredClone(receipts);
      delete copy[index][key];
      assert.equal(verifyReceipts(copy).valid, false, key);
    }
    for (const change of [
      (r) => {
        r.activation.activated_at = null;
      },
      (r) => {
        r.mismatches = 1;
      },
      (r) => {
        r.legacyRemaining = 1;
      },
      (r) => {
        r.codes = ["mutation-uncertain"];
      },
      (r) => {
        r.gates.floor = false;
      },
      (r) => {
        r.mode = "dry-run";
      },
    ]) {
      const copy = structuredClone(receipts);
      change(copy[index]);
      assert.equal(verifyReceipts(copy).valid, false);
    }
  }
  assert.equal(verifyReceipts([...receipts, receipts[0]]).valid, false);
});

test("database identity excludes credentials and query; withheld exporter authority refuses", () => {
  assert.equal(
    databaseIdentityDigest("staging", url),
    databaseIdentityDigest(
      "staging",
      url.replace("fixture_user:fixture_password", "other:other").replace("require", "verify-full"),
    ),
  );
  assert.notEqual(databaseIdentityDigest("staging", url), databaseIdentityDigest("production", url));
  assert.throws(() => databaseIdentityDigest("staging", undefined), { message: "database-authority" });
});

test("single-gate bypass mutants are killed by the refusal controls", async (t) => {
  const h = history();
  t.after(h.close);
  const source = readFileSync(new URL("./collections-anonymous-owner-redaction.mjs", import.meta.url), "utf8");
  const cases = [
    [
      "packet-digest",
      (f) => {
        f.options.packetSha256 = "b".repeat(64);
      },
    ],
    [
      "packet-size",
      (f) => {
        f.appendWhitespace = true;
      },
    ],
    [
      "default-branch",
      (f) => {
        f.options.ref = "refs/heads/feature";
      },
    ],
    [
      "target-mismatch",
      (f) => {
        f.options.jobEnvironment = "production";
      },
    ],
    [
      "approval-required",
      (f) => {
        f.options.approvalReference = "";
      },
    ],
    [
      "packet-schema",
      (f) => {
        f.packet.schemaVersion = "wrong";
      },
    ],
    [
      "packet-keys",
      (f) => {
        f.packet.extra = true;
      },
    ],
    [
      "packet-stale",
      (f) => {
        f.packet.capturedAt = "2026-10-19T11:00:00.000Z";
      },
    ],
    [
      "floor-mismatch",
      (f) => {
        f.packet.floorCommit = h.recovery;
      },
    ],
    [
      "db-identity",
      (f) => {
        f.options.databaseUrl = url.replace("fixture.invalid", "other.invalid");
      },
    ],
    [
      "schema-ledger",
      (f) => {
        f.packet.schemaLedger.push("synthetic_extra");
      },
    ],
    [
      "inventory-incomplete",
      (f) => {
        f.packet.inventory.authoritativeTotal++;
      },
    ],
    [
      "writer-floor",
      (f) => {
        f.packet.writers.serving[0].revision = "f".repeat(40);
      },
    ],
    [
      "writer-unknown",
      (f) => {
        f.packet.writers.serving[0].state = "unknown";
      },
    ],
    [
      "fence-required",
      (f) => {
        f.fenceAbsent();
      },
    ],
    [
      "activation-required",
      (f) => {
        f.inactive();
      },
    ],
  ];
  for (const [code, mutate] of cases)
    await t.test(code, async () => {
      const f = fixture(h);
      mutate(f);
      f.options.packetText = JSON.stringify(f.packet);
      if (f.appendWhitespace) f.options.packetText += " ".repeat(16_385);
      if (code !== "packet-digest") f.options.packetSha256 = hash(f.options.packetText);
      await assert.rejects(runRedaction(f.options, f.dependencies), { message: code });
      assert.equal(f.writes(), 0);
      const mutant = source.replace(
        "if (!condition) throw new CutoverRefusal(code);",
        `if (!condition && code !== ${JSON.stringify(code)}) throw new CutoverRefusal(code);`,
      );
      assert.notEqual(mutant, source);
      const module = await import(`data:text/javascript;base64,${Buffer.from(mutant).toString("base64")}`);
      await module.runRedaction(f.options, f.dependencies);
    });
});

test("offline CLI verifies artifact files without any database credentials", async (t) => {
  const h = history();
  t.after(h.close);
  const paths = [];
  for (const target of ["staging", "production"]) {
    const f = fixture(h, target);
    const receipt = await runRedaction(f.options, f.dependencies);
    const path = join(h.root, `${target}.json`);
    writeFileSync(path, JSON.stringify(receipt));
    paths.push(path);
  }
  const out = join(h.root, "verdict.json");
  execFileSync(
    process.execPath,
    [fileURLToPath(new URL("./collections-anonymous-owner-redaction.mjs", import.meta.url))],
    {
      timeout: 15_000,
      env: {
        SystemRoot: process.env.SystemRoot,
        PATH: process.env.PATH,
        REDACTION_MODE: "verify",
        REDACTION_RECEIPTS: JSON.stringify(paths),
        REDACTION_OUT: out,
      },
    },
  );
  assert.deepEqual(JSON.parse(readFileSync(out, "utf8")), { valid: true, code: "verified-zero" });
});

test("workflow keeps credentials on exporter step and verify offline", () => {
  const workflow = readFileSync(
    new URL("../.github/workflows/collections-anonymous-owner-redaction.yml", import.meta.url),
    "utf8",
  );
  assert.match(workflow, /fetch-depth: 0/);
  assert.match(workflow, /environment: \$\{\{ inputs.target \}\}/);
  assert.match(workflow, /if: inputs.mode != 'verify'/);
  assert.match(workflow, /contents: read/);
  assert.equal((workflow.match(/secrets\./g) ?? []).length, 3);
  const exporter = workflow.slice(
    workflow.indexOf("      - name: Export Collections"),
    workflow.indexOf("      - name: Run protected"),
  );
  assert.equal((exporter.match(/secrets\./g) ?? []).length, 3);
  const entry = readFileSync(new URL("../bounded-contexts/collections/index.ts", import.meta.url), "utf8");
  assert.doesNotMatch(entry, /export.*(?:redactLegacyAnonymousOwners|activateAnonymousOwnerCutover)/);
  const script = readFileSync(new URL("./collections-anonymous-owner-redaction.mjs", import.meta.url), "utf8");
  assert.match(
    script,
    /import\("\.\.\/bounded-contexts\/collections\/features\/saved-lists\/api\/anonymous-owner-redaction\.ts"\)/,
  );
});
