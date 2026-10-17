import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { canonicalRefinedInventoryProbeBytes, deriveMonthlyRefinedInventoryWindow } from "./roadmap-status.mjs";
import {
  collectCountedPages,
  readAuthorityArchive,
  RoadmapAuthorityProbeError,
  runAuthorityProbe,
  validateAuthorityReceipt,
} from "./roadmap-authority-probe.mjs";

const HEAD = "a".repeat(40);
const NONCE = "b".repeat(32);
const RUN_ID = 101;
const JOB_ID = 202;
const ARTIFACT_ID = 303;

function probePayload(overrides = {}) {
  const window = deriveMonthlyRefinedInventoryWindow(Date.parse("2026-08-30T00:00:00.000Z"));
  const digest = "c".repeat(64);
  return {
    schemaVersion: "roadmap-refined-inventory-authority-probe/v1",
    repository: "chase-sets/chase-sets",
    workflow: "backlog-roadmap-status.yml",
    runId: RUN_ID,
    runAttempt: 1,
    jobId: JOB_ID,
    headSha: HEAD,
    nonce: NONCE,
    checkedAt: "2026-08-30T00:00:00.000Z",
    query: window.query,
    month: window.month,
    windowStart: window.windowStart,
    windowEndExclusive: window.windowEndExclusive,
    attempts: [
      { attempt: 1, pages: 1, count: 0, digest },
      { attempt: 2, pages: 1, count: 0, digest },
    ],
    acceptedAttempts: [1, 2],
    mergedPrCount: 0,
    cap: 0,
    identitySha256: digest,
    ...overrides,
  };
}

function zip(entries) {
  const locals = [];
  const centrals = [];
  let localOffset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const contents = Buffer.from(entry.contents);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(contents.length, 18);
    local.writeUInt32LE(contents.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, contents);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(0, 16);
    central.writeUInt32LE(contents.length, 20);
    central.writeUInt32LE(contents.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt32LE((entry.externalAttributes ?? 0) >>> 0, 38);
    central.writeUInt32LE(localOffset, 42);
    centrals.push(central, name);
    localOffset += local.length + name.length + contents.length;
  }
  const localBytes = Buffer.concat(locals);
  const centralBytes = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(localBytes.length, 16);
  return Buffer.concat([localBytes, centralBytes, end]);
}

function countedClient(pages) {
  let index = 0;
  return { json: async () => pages[index++] };
}

function terminalJob(overrides = {}) {
  return {
    id: JOB_ID,
    name: "probe-authority",
    status: "completed",
    conclusion: "success",
    steps: [
      { name: "Produce refined inventory authority probe", status: "completed", conclusion: "success" },
      { name: "Validate refined inventory authority probe", status: "completed", conclusion: "success" },
      { name: "Upload refined inventory authority probe", status: "completed", conclusion: "success" },
    ],
    ...overrides,
  };
}

function fakeProbeAuthority(overrides = {}) {
  const payloadBytes = canonicalRefinedInventoryProbeBytes(probePayload(overrides.payload));
  const archiveBytes = zip([{ name: "roadmap-refined-inventory-authority-probe.json", contents: payloadBytes }]);
  const run = {
    id: RUN_ID,
    run_attempt: 1,
    event: "workflow_dispatch",
    head_sha: HEAD,
    head_branch: "codex/issue-7560-monthly-refined-cap-r1",
    display_title: `Backlog Roadmap Status probe ${NONCE}`,
    status: "completed",
    conclusion: "success",
  };
  const artifact = {
    id: ARTIFACT_ID,
    name: `roadmap-refined-inventory-authority-${RUN_ID}-1`,
    expired: false,
    size_in_bytes: archiveBytes.length,
    digest: `sha256:${"d".repeat(64)}`,
    archive_download_url: "https://api.github.com/artifacts/303.zip",
  };
  const mutations = [];
  let runCollections = 0;
  let artifactCollections = 0;
  const client = {
    json: async (path) => {
      if (path === "/graphql") {
        return {
          data: {
            repository: {
              pullRequests: {
                totalCount: 1,
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  {
                    number: 7563,
                    headRefName: run.head_branch,
                    headRefOid: HEAD,
                    baseRefName: "main",
                    isDraft: false,
                  },
                ],
              },
            },
          },
        };
      }
      if (path.includes("/actions/workflows/") && path.includes("/runs?")) {
        runCollections += 1;
        return runCollections === 1 ? { total_count: 0, workflow_runs: [] } : { total_count: 1, workflow_runs: [run] };
      }
      if (path.includes(`/actions/runs/${RUN_ID}/attempts/1/jobs`)) {
        const jobs = overrides.jobs ?? [terminalJob()];
        return { total_count: jobs.length, jobs };
      }
      if (path.includes(`/actions/runs/${RUN_ID}/artifacts`)) {
        artifactCollections += 1;
        const selected =
          artifactCollections > 1 && overrides.finalArtifact ? { ...artifact, ...overrides.finalArtifact } : artifact;
        return { total_count: 1, artifacts: [selected] };
      }
      if (path === `/repos/chase-sets/chase-sets/actions/runs/${RUN_ID}`) return run;
      throw new Error(`Unhandled fake JSON request: ${path}`);
    },
    request: async (path, init = {}) => {
      if (path.includes("/dispatches")) {
        mutations.push({ path, init });
        return { response: { status: 204 }, bytes: Buffer.alloc(0) };
      }
      if (path === artifact.archive_download_url) return { response: { status: 200 }, bytes: archiveBytes };
      throw new Error(`Unhandled fake request: ${path}`);
    },
  };
  const runChild = async (_command, args) => {
    if (args[0] === "status")
      return { stdout: overrides.dirty ? " M scripts/roadmap-status.mjs" : "", stderr: "", code: 0 };
    if (args[0] === "rev-parse") return { stdout: `${HEAD}\n`, stderr: "", code: 0 };
    if (args[0] === "ls-remote") {
      return { stdout: `${HEAD}\trefs/heads/${run.head_branch}\n`, stderr: "", code: 0 };
    }
    throw new Error(`Unhandled child: ${args.join(" ")}`);
  };
  return { client, runChild, mutations, payloadBytes };
}

describe("roadmap refined-inventory foreground authority probe", () => {
  it("reconciles counted provider pages and fails closed at 999/1,000/1,001", async () => {
    const rows = Array.from({ length: 999 }, (_, index) => ({ id: index + 1 }));
    const pages = Array.from({ length: 10 }, (_, index) => ({
      total_count: 999,
      items: rows.slice(index * 100, (index + 1) * 100),
    }));
    await expect(collectCountedPages(countedClient(pages), "/authority", "items")).resolves.toMatchObject({
      pages: 10,
      total: 999,
    });
    for (const total of [1_000, 1_001]) {
      await expect(
        collectCountedPages(countedClient([{ total_count: total, items: [] }]), "/authority", "items"),
      ).rejects.toMatchObject({ code: "ROADMAP_AUTHORITY_PROVIDER_LIMIT" });
    }
    await expect(
      collectCountedPages(
        countedClient([
          { total_count: 101, items: rows.slice(0, 100) },
          { total_count: 102, items: rows.slice(100, 101) },
        ]),
        "/authority",
        "items",
      ),
    ).rejects.toMatchObject({ code: "ROADMAP_AUTHORITY_TOTAL_CHANGED" });
  });

  it("accepts exactly one root basename payload and rejects nested, extra, symlink, and oversized entries", () => {
    const payloadBytes = canonicalRefinedInventoryProbeBytes(probePayload());
    expect(
      readAuthorityArchive(zip([{ name: "roadmap-refined-inventory-authority-probe.json", contents: payloadBytes }])),
    ).toMatchObject({ payload: probePayload() });
    for (const archive of [
      zip([{ name: "root/roadmap-refined-inventory-authority-probe.json", contents: payloadBytes }]),
      zip([
        { name: "roadmap-refined-inventory-authority-probe.json", contents: payloadBytes },
        { name: "decoy.txt", contents: "decoy" },
      ]),
      zip([
        {
          name: "roadmap-refined-inventory-authority-probe.json",
          contents: payloadBytes,
          externalAttributes: 0o120000 << 16,
        },
      ]),
      zip([
        {
          name: "roadmap-refined-inventory-authority-probe.json",
          contents: Buffer.alloc(512 * 1024 + 1),
        },
      ]),
    ]) {
      expect(() => readAuthorityArchive(archive)).toThrow(RoadmapAuthorityProbeError);
    }
  });

  it("binds clean local/remote/PR head through exact job steps, artifact, payload, and final receipt", async () => {
    const parent = mkdtempSync(join(tmpdir(), "roadmap-authority-parent-"));
    const fake = fakeProbeAuthority();
    try {
      const result = await runAuthorityProbe(
        {
          cwd: process.cwd(),
          repository: "chase-sets/chase-sets",
          workflow: "backlog-roadmap-status.yml",
          branch: "codex/issue-7560-monthly-refined-cap-r1",
          expectedHead: HEAD,
          artifactParent: parent,
        },
        {
          token: "withheld-from-output",
          nonce: NONCE,
          client: fake.client,
          runChild: fake.runChild,
          sleep: async () => {},
        },
      );
      expect(fake.mutations).toHaveLength(1);
      expect(fake.mutations[0].init.body).toEqual({
        ref: "codex/issue-7560-monthly-refined-cap-r1",
        inputs: { authority_nonce: NONCE },
      });
      expect(validateAuthorityReceipt(result.receipt)).toBe(true);
      expect(result.receipt).toMatchObject({
        jobId: JOB_ID,
        headSha: HEAD,
        nonce: NONCE,
        runId: RUN_ID,
        runAttempt: 1,
        artifactId: ARTIFACT_ID,
        payloadPath: "roadmap-refined-inventory-authority-probe.json",
      });
      expect(readFileSync(result.receiptPath, "utf8")).toBe(`${JSON.stringify(result.receipt)}\n`);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("withholds dispatch on dirty preflight and rejects skipped producer or replaced final artifact", async () => {
    const parent = mkdtempSync(join(tmpdir(), "roadmap-authority-negative-"));
    try {
      const dirty = fakeProbeAuthority({ dirty: true });
      await expect(
        runAuthorityProbe(
          {
            cwd: process.cwd(),
            repository: "chase-sets/chase-sets",
            workflow: "backlog-roadmap-status.yml",
            branch: "codex/issue-7560-monthly-refined-cap-r1",
            expectedHead: HEAD,
            artifactParent: parent,
          },
          { token: "token", nonce: NONCE, client: dirty.client, runChild: dirty.runChild },
        ),
      ).rejects.toMatchObject({ code: "ROADMAP_AUTHORITY_WORKTREE_DIRTY" });
      expect(dirty.mutations).toEqual([]);

      const skipped = fakeProbeAuthority({
        jobs: [
          terminalJob({
            steps: [
              { name: "Produce refined inventory authority probe", status: "completed", conclusion: "skipped" },
              { name: "Validate refined inventory authority probe", status: "completed", conclusion: "success" },
              { name: "Upload refined inventory authority probe", status: "completed", conclusion: "success" },
            ],
          }),
        ],
      });
      await expect(
        runAuthorityProbe(
          {
            cwd: process.cwd(),
            repository: "chase-sets/chase-sets",
            workflow: "backlog-roadmap-status.yml",
            branch: "codex/issue-7560-monthly-refined-cap-r1",
            expectedHead: HEAD,
            artifactParent: parent,
          },
          { token: "token", nonce: NONCE, client: skipped.client, runChild: skipped.runChild, sleep: async () => {} },
        ),
      ).rejects.toMatchObject({ code: "ROADMAP_AUTHORITY_JOB_STEP_INVALID" });

      const replaced = fakeProbeAuthority({
        finalArtifact: {
          digest: `sha256:${"e".repeat(64)}`,
        },
      });
      await expect(
        runAuthorityProbe(
          {
            cwd: process.cwd(),
            repository: "chase-sets/chase-sets",
            workflow: "backlog-roadmap-status.yml",
            branch: "codex/issue-7560-monthly-refined-cap-r1",
            expectedHead: HEAD,
            artifactParent: parent,
          },
          { token: "token", nonce: NONCE, client: replaced.client, runChild: replaced.runChild, sleep: async () => {} },
        ),
      ).rejects.toMatchObject({ code: "ROADMAP_AUTHORITY_FINAL_RECONCILIATION_FAILED" });
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("recursively closes the receipt and rejects stale or reordered authority", () => {
    const receipt = {
      schemaVersion: "roadmap-refined-inventory-authority-receipt/v1",
      repository: "chase-sets/chase-sets",
      workflow: "backlog-roadmap-status.yml",
      job: "probe-authority",
      jobId: JOB_ID,
      ref: "refs/heads/codex/issue-7560-monthly-refined-cap-r1",
      headSha: HEAD,
      nonce: NONCE,
      runId: RUN_ID,
      runAttempt: 1,
      artifactId: ARTIFACT_ID,
      artifactName: `roadmap-refined-inventory-authority-${RUN_ID}-1`,
      artifactDigest: `sha256:${"d".repeat(64)}`,
      payloadPath: "roadmap-refined-inventory-authority-probe.json",
      payloadSha256: "e".repeat(64),
      checkedAt: "2026-08-30T00:00:00.000Z",
    };
    expect(validateAuthorityReceipt(receipt)).toBe(true);
    expect(validateAuthorityReceipt({ ...receipt, stale: true })).toBe(false);
    const reordered = Object.fromEntries(Object.entries(receipt).reverse());
    expect(validateAuthorityReceipt(reordered)).toBe(false);
  });
});
