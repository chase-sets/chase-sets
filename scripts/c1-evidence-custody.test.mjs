import { generateKeyPairSync, sign } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { retainC1Evidence } from "./c1-evidence-custody.mjs";
import { sha256 } from "./census-terminal-evidence.mjs";

const roots = [];
const now = "2030-01-01T01:00:20Z";
const start = "2030-01-01T00:00:00Z";
const end = "2030-01-01T01:00:00Z";
const kinds = [
  "capture-start",
  "verification-dispatched",
  "namespace-created",
  "provider-finalized",
  "seal-written",
  "delete-started",
  "delete-completed",
];
const json = (v) => Buffer.from(JSON.stringify(v));
const sourceCode = "synthetic source bytes";
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "synthetic-c1-custody-"));
  roots.push(root);
  const keys = generateKeyPairSync("ed25519");
  const binding = {
    release: "1".repeat(40),
    digest: `sha256:${"2".repeat(64)}`,
    workflowHead: "3".repeat(40),
    workflowHash: sha256(sourceCode),
    helperHash: sha256(sourceCode),
    uid: "synthetic-namespace",
    nodeUid: "synthetic-node",
    census: { id: 900000000000001, attempt: 1 },
    verification: { id: 900000000000002, attempt: 1 },
  };
  mkdirSync(join(root, "sources"));
  const plan = {
    version: "c1-evidence-custody/v1",
    performer: "synthetic-reader",
    binding,
    validFrom: start,
    validUntil: "2030-01-02T00:00:00Z",
    retainUntil: "2031-01-01T00:00:00Z",
    original: { custodian: "synthetic-original", prefix: join(root, "originals") },
    backup: {
      custodian: "synthetic-independent",
      prefix: join(root, "backups"),
      publicKey: keys.publicKey.export({ type: "spki", format: "pem" }),
    },
    manifestPath: join(root, "manifest.json"),
    acknowledgementPath: join(root, "ack.json"),
    planOriginalPath: join(root, "originals", "plan.json"),
    planBackupPath: join(root, "backups", "plan.json"),
    files: [],
    envelopeId: "envelope",
    admittedId: "admitted",
    clockMappings: [],
    sourceGraph: { workflowId: "source", helperId: "source", actionIds: ["source"] },
    history: {
      binding,
      start,
      end,
      startResourceVersion: "synthetic-rv-0",
      inventoryId: "inventory",
      segments: ["history"],
      logIds: ["log"],
    },
    artifacts: [],
  };
  const f = { root, plan, calls: 0 };
  f.add = (id, value, extra = {}) => {
    const bytes = Buffer.isBuffer(value) ? value : json(value);
    const file = {
      id,
      scope: "terminal",
      sourcePath: join(root, "sources", id),
      originalPath: join(root, "originals", id),
      backupPath: join(root, "backups", id),
      encoding: "utf8",
      bytes: bytes.length,
      sha256: sha256(bytes),
      safety: { reviewer: "synthetic-safety-reviewer", sha256: sha256(bytes) },
      origin: {
        method: "GET",
        url: `https://synthetic.invalid/evidence/${id}`,
        apiVersion: "synthetic/v1",
        status: 200,
        headers: { "content-type": "application/json" },
        startedAt: "2030-01-01T01:00:18Z",
        completedAt: "2030-01-01T01:00:19Z",
        expiresAt: "2030-01-02T00:00:00Z",
        sourceHash: sha256(sourceCode),
        workflowHead: binding.workflowHead,
        release: binding.release,
        digest: binding.digest,
        runId: binding.verification.id,
        attempt: 1,
        jobId: 900000000000003,
        step: "Synthetic owning step",
        namespaceUid: binding.uid,
        nodeUid: binding.nodeUid,
        containerUid: "synthetic-container",
        evidencePointer: "",
      },
      ...extra,
    };
    plan.files.push(file);
    writeFileSync(file.sourcePath, bytes);
    return file;
  };
  f.replace = (id, mutate) => {
    const file = plan.files.find((entry) => entry.id === id);
    const value = JSON.parse(readFileSync(file.sourcePath));
    mutate(value);
    const bytes = json(value);
    writeFileSync(file.sourcePath, bytes);
    file.bytes = bytes.length;
    file.sha256 = sha256(bytes);
    file.safety.sha256 = file.sha256;
  };
  const resources = [
    { kind: "Namespace", uid: binding.uid, createdAt: start, finalizedAt: end },
    { kind: "Node", uid: binding.nodeUid, createdAt: start, finalizedAt: end },
    { kind: "Pod", uid: "synthetic-pod", createdAt: start, finalizedAt: end },
    {
      kind: "Container",
      uid: "synthetic-container",
      createdAt: start,
      finalizedAt: end,
      generations: [
        {
          number: 0,
          rotations: [
            {
              number: 0,
              bytes: Buffer.byteLength("synthetic complete log tail\n"),
              sha256: sha256("synthetic complete log tail\n"),
            },
          ],
        },
      ],
    },
    { kind: "Producer", uid: "synthetic-producer", createdAt: start, finalizedAt: end },
  ];
  for (const resource of resources)
    if (["Pod", "Container", "Producer"].includes(resource.kind))
      resource.identity = {
        runId: binding.verification.id,
        attempt: binding.verification.attempt,
        namespaceUid: binding.uid,
        nodeUid: binding.nodeUid,
        digest: binding.digest,
      };
  f.add("source", Buffer.from(sourceCode));
  f.add("inventory", { binding, resources, eventCount: 7 }, { scope: "lifecycle" });
  const events = kinds.map((kind) => ({
    kind,
    uid: binding.uid,
    runId: kind === "capture-start" ? binding.census.id : binding.verification.id,
    attempt: 1,
  }));
  f.add("clock", events);
  f.add(
    "history",
    {
      binding,
      startedAt: start,
      completedAt: end,
      retainedFrom: start,
      expiresAt: "2030-01-02T00:00:00Z",
      fromResourceVersion: "synthetic-rv-0",
      resourceVersion: "synthetic-rv-1",
      page: 1,
      totalPages: 1,
      totalCount: resources.length * 2 + events.length,
      records: [
        ...resources.flatMap((r) => [
          { kind: r.kind, uid: r.uid, identity: r.identity, action: "created", at: start },
          { kind: r.kind, uid: r.uid, identity: r.identity, action: "finalized", at: end },
        ]),
        ...events.map((e) => ({
          ...e,
          uid: `synthetic-event-${e.kind}`,
          kind: "Event",
          action: "observed",
          at: end,
          reason: e.kind,
        })),
      ],
    },
    { scope: "lifecycle" },
  );
  f.add("log", Buffer.from("synthetic complete log tail\n"), {
    scope: "lifecycle",
    log: { ownerUid: "synthetic-container", generation: 0, rotation: 0 },
  });
  f.add("envelope", { binding, files: [] });
  f.add("admitted", { binding, manifest: [] });
  for (const [i, kind] of kinds.entries())
    plan.clockMappings.push({
      kind,
      fileId: "clock",
      pointer: `/${i}`,
      sourcePointer: `/${i}`,
      delivery: sha256(`${plan.files.find((e) => e.id === "clock").sha256}:/${i}:${kind}`),
    });
  f.authority = () => ({ approvedPlanHash: sha256(readFileSync(f.planFile)), performer: plan.performer });
  f.planFile = join(root, "plan.json");
  f.save = () => writeFileSync(f.planFile, json(plan));
  f.backup = {
    custodian: plan.backup.custodian,
    async retain(request) {
      f.calls++;
      for (const file of request.files) writeFileSync(file.backupPath, readFileSync(file.originalPath), { flag: "wx" });
      const payload = {
        planHash: request.planHash,
        custodian: plan.backup.custodian,
        captureStartedAt: request.startedAt,
        acknowledgedAt: now,
        retainUntil: plan.retainUntil,
        files: request.files.map((file) => ({
          path: file.backupPath,
          bytes: readFileSync(file.backupPath).length,
          sha256: sha256(readFileSync(file.backupPath)),
        })),
      };
      return { payload, signature: sign(null, json(payload), keys.privateKey).toString("base64") };
    },
  };
  f.run = () =>
    retainC1Evidence({ planFile: f.planFile, authority: f.authority() }, { backup: f.backup, now: () => now });
  f.save();
  return f;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("source custody admission", () => {
  it("retains exact safe bytes only under separately bound host approval", async () => {
    const f = fixture(),
      result = await f.run();
    expect(result.state, JSON.stringify(result)).toBe("RETAINED");
    expect(f.calls).toBe(1);
    for (const file of f.plan.files) {
      expect(readFileSync(file.originalPath)).toEqual(readFileSync(file.sourcePath));
      expect(readFileSync(file.backupPath)).toEqual(readFileSync(file.sourcePath));
    }
    expect(result.manifest.files.map((file) => file.id)).toEqual([
      "custody-plan",
      ...f.plan.files.map((file) => file.id),
    ]);
    expect(result.manifest).not.toHaveProperty("sha256");
  });
  it("withholds authorization before any copy", async () => {
    const f = fixture();
    const result = await retainC1Evidence({ planFile: f.planFile }, { backup: f.backup });
    expect(result.state).toBe("STOP");
    expect(result.missing).toContain("HOST_APPROVAL");
    expect(f.calls).toBe(0);
    expect(existsSync(f.plan.files[0].originalPath)).toBe(false);
  });
  it.each([
    "forged provenance",
    "changed release",
    "authorization header",
    "expired",
    "unsafe",
    "secret bytes",
    "missing source",
    "missing clock",
    "forged delivery",
  ])("refuses %s before writing", async (attack) => {
    const f = fixture(),
      first = f.plan.files[0];
    if (attack === "forged provenance") {
      f.save();
      const authority = f.authority();
      first.origin.sourceHash = "5".repeat(64);
      f.save();
      expect(
        (await retainC1Evidence({ planFile: f.planFile, authority }, { backup: f.backup, now: () => now })).state,
      ).toBe("STOP");
      return;
    }
    if (attack === "changed release") first.origin.release = "5".repeat(40);
    if (attack === "authorization header") first.origin.headers.authorization = "synthetic-sensitive-marker";
    if (attack === "expired") first.origin.expiresAt = start;
    if (attack === "unsafe") delete first.safety;
    if (attack === "secret bytes") writeFileSync(first.sourcePath, "synthetic-sensitive-marker");
    if (attack === "missing source") first.sourcePath = join(f.root, "missing");
    if (attack === "missing clock") f.plan.clockMappings.pop();
    if (attack === "forged delivery") f.plan.clockMappings[0].delivery = "invented";
    f.save();
    const result = await f.run();
    expect(result.state).toBe("STOP");
    expect(result.partial).toBe(false);
    expect(f.calls).toBe(0);
    expect(JSON.stringify(result)).not.toContain("synthetic-sensitive-marker");
  });
});

describe("whole lifecycle custody", () => {
  it("does not select initial handoff from a flag or absent lifecycle history", async () => {
    const f = fixture();
    f.plan.handoff = {};
    f.save();
    expect((await f.run()).missing).toEqual(["HANDOFF_BINDING"]);
    expect(f.calls).toBe(0);
    delete f.plan.handoff;
    delete f.plan.history;
    f.plan.files = f.plan.files.filter((file) => file.scope === "terminal");
    f.save();
    expect((await f.run()).missing).toEqual(["C1_HISTORY_BINDING"]);
    expect(f.calls).toBe(0);
  });
  it.each([
    "transient competitor",
    "missing generation",
    "omitted event",
    "omitted tail",
    "rotation gap",
    "expired history",
    "resource-version gap",
    "four-reason mutant",
    "final-list-only mutant",
  ])("refuses the %s with unrelated predicates fixed", async (attack) => {
    const f = fixture();
    if (attack === "transient competitor")
      f.replace("history", (h) => {
        h.records.push({ kind: "Namespace", uid: "synthetic-brief-competitor", action: "created", at: start });
        h.totalCount++;
      });
    if (attack === "missing generation")
      f.replace("inventory", (h) =>
        h.resources
          .find((r) => r.kind === "Container")
          .generations.push({ number: 1, rotations: [{ number: 0, bytes: 1, sha256: sha256("x") }] }),
      );
    if (attack === "omitted event") f.replace("history", (h) => h.records.pop());
    if (attack === "omitted tail")
      writeFileSync(f.plan.files.find((v) => v.id === "log").sourcePath, "synthetic complete log");
    if (attack === "rotation gap")
      f.replace("inventory", (h) =>
        h.resources
          .find((r) => r.kind === "Container")
          .generations[0].rotations.push({ number: 2, bytes: 1, sha256: sha256("x") }),
      );
    if (attack === "expired history") f.replace("history", (h) => (h.retainedFrom = end));
    if (attack === "resource-version gap") f.replace("history", (h) => (h.fromResourceVersion = "unbound-rv"));
    if (attack === "four-reason mutant")
      f.replace("history", (h) => (h.records = h.records.filter((r) => r.kind !== "Event")));
    if (attack === "final-list-only mutant")
      f.replace("history", (h) => (h.records = h.records.filter((r) => r.action === "finalized")));
    f.save();
    expect((await f.run()).state).toBe("STOP");
    expect(f.calls).toBe(0);
  });
});

describe("independent backup", () => {
  it("refuses even an empty existing destination prefix without creating evidence", async () => {
    const f = fixture();
    mkdirSync(f.plan.original.prefix);
    const result = await f.run();
    expect(result.state).toBe("STOP");
    expect(result.missing).toContain("EXISTING_PREFIX");
    expect(result.partial).toBe(false);
    expect(f.calls).toBe(0);
  });
  it.each(["extra field", "omitted file", "extra file", "substituted clock"])(
    "rejects %s in a retained external manifest",
    async (attack) => {
      const f = fixture();
      expect((await f.run()).state).toBe("RETAINED");
      const manifest = JSON.parse(readFileSync(f.plan.manifestPath));
      if (attack === "extra field") manifest.unadmitted = true;
      if (attack === "omitted file") manifest.files.pop();
      if (attack === "extra file") manifest.files.push(manifest.files[0]);
      if (attack === "substituted clock") manifest.clocks[0].delivery = "substitution";
      writeFileSync(f.plan.manifestPath, JSON.stringify(manifest));
      expect((await f.run()).state).toBe("STOP");
      expect(f.calls).toBe(1);
    },
  );
  it("retains independent usable originals after every hosted source has expired and disappeared", async () => {
    const f = fixture();
    expect((await f.run()).state).toBe("RETAINED");
    for (const file of f.plan.files) rmSync(file.sourcePath);
    const result = await retainC1Evidence(
      { planFile: f.planFile, authority: f.authority() },
      { backup: f.backup, now: () => "2030-01-03T00:00:00Z" },
    );
    expect(result.state, JSON.stringify(result)).toBe("RETAINED");
    expect(f.calls).toBe(1);
  });
  it("independently rereads, authenticates acknowledgement and reuses identical deliveries without overwriting", async () => {
    const f = fixture(),
      first = await f.run(),
      second = await f.run();
    expect(second).toEqual(first);
    expect(f.calls).toBe(1);
    writeFileSync(f.plan.files[0].backupPath, "substitution");
    expect((await f.run()).state).toBe("STOP");
    expect(f.calls).toBe(1);
  });
  it.each([
    "same custodian",
    "existing original",
    "existing backup",
    "partial copy",
    "stale acknowledgement",
    "forged acknowledgement",
    "crash",
    "extra receipt file",
    "omitted receipt file",
    "unsafe diagnostic receipt",
  ])("refuses %s and preserves partial state", async (attack) => {
    const f = fixture(),
      retain = f.backup.retain.bind(f.backup);
    if (attack === "same custodian") f.plan.backup.custodian = f.plan.original.custodian;
    if (attack === "existing original") {
      mkdirSync(f.plan.original.prefix);
      writeFileSync(f.plan.files[0].originalPath, "old");
    }
    if (attack === "existing backup") {
      mkdirSync(f.plan.backup.prefix);
      writeFileSync(f.plan.files[0].backupPath, "old");
    }
    if (
      [
        "partial copy",
        "stale acknowledgement",
        "forged acknowledgement",
        "extra receipt file",
        "omitted receipt file",
        "unsafe diagnostic receipt",
        "crash",
      ].includes(attack)
    )
      f.backup.retain = async (request) => {
        if (attack === "crash") throw new Error("synthetic-sensitive-marker");
        const ack = await retain(request);
        if (attack === "partial copy") writeFileSync(request.files[0].backupPath, "partial");
        if (attack === "stale acknowledgement") ack.payload.acknowledgedAt = start;
        if (attack === "forged acknowledgement") ack.signature = Buffer.alloc(64).toString("base64");
        if (attack === "extra receipt file") ack.payload.files.push(ack.payload.files[0]);
        if (attack === "omitted receipt file") ack.payload.files.pop();
        if (attack === "unsafe diagnostic receipt") ack.stderr = "synthetic-sensitive-marker";
        return ack;
      };
    f.save();
    const result = await f.run();
    expect(result.state).toBe("STOP");
    expect(existsSync(f.plan.manifestPath)).toBe(false);
    expect(JSON.stringify(result)).not.toContain("synthetic-sensitive-marker");
    if (attack.startsWith("existing")) {
      expect(result.partial).toBe(false);
      expect(
        readFileSync(
          attack === "existing original" ? f.plan.files[0].originalPath : f.plan.files[0].backupPath,
          "utf8",
        ),
      ).toBe("old");
    }
  });
});
