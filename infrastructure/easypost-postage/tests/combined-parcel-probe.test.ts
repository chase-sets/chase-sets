import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";
import { createEasyPostPostageLabelProvider } from "../index";
import { easyPostTestMemberParcel, easyPostTestRecipient, easyPostTestSender } from "./easypost-test-fixtures";
import {
  bodyHash,
  caseIds,
  caseRequest,
  checkpoints,
  confirmation,
  digest,
  executePhase,
  focusedCommand,
  freshState,
  guardProvider,
  observedFetch,
  operatorHandoff,
  phases,
  privateArtifactName,
  privateFilename,
  publicArtifactName,
  publicFilename,
  requireProbe,
  resumeInput,
  runCase,
  runOperatorPhase,
  transition,
  validateArtifact,
  validatePublicEvidence,
  validatePublicRecord,
  validateState,
  validateUploadedRecord,
  workflowPath,
  type Identity,
  type PrivateState,
  type PublicRecord,
  type Receipt,
  type UploadedRecord,
} from "./combined-parcel-probe";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const now = "2026-09-29T18:00:00.000Z";
const key = "EZTK-SYNTHETIC-NOT-A-CREDENTIAL";
const identity: Identity = {
  repository: "chase-sets/chase-sets",
  sourceSha: "a".repeat(40),
  runId: "900000001",
  runAttempt: "1",
};
const environment = {
  GITHUB_ACTIONS: "true",
  GITHUB_EVENT_NAME: "workflow_dispatch",
  GITHUB_JOB: "combined-parcel-probe",
  GITHUB_REPOSITORY: identity.repository,
  GITHUB_WORKFLOW_REF: `chase-sets/chase-sets/${workflowPath}@refs/heads/main`,
  GITHUB_REF: "refs/heads/main",
  GITHUB_SHA: identity.sourceSha,
  GITHUB_RUN_ID: identity.runId,
  GITHUB_RUN_ATTEMPT: identity.runAttempt,
  EASYPOST_API_KEY: key,
  EASYPOST_MODE: "test",
  COMBINED_PARCEL_PROBE_CONFIRM: confirmation,
  COMBINED_PARCEL_PROBE_WORKFLOW_CONFIRM: confirmation,
  COMBINED_PARCEL_PROBE_ENVIRONMENT: "staging",
  COMBINED_PARCEL_PROBE_SOURCE_SHA: identity.sourceSha,
  COMBINED_PARCEL_PROBE_CHECKED_OUT_SHA: identity.sourceSha,
  COMBINED_PARCEL_PROBE_PHASE: "pre-a",
};
const rate = { id: "rate_SYNTHETIC", carrier: "USPS", service: "GroundAdvantage", rate: "5.25", currency: "USD" };
const created = { id: "shp_SYNTHETIC", mode: "test", rates: [rate] };
const purchased = {
  ...created,
  selected_rate: rate,
  postage_label: { id: "pl_SYNTHETIC", label_url: "https://synthetic.invalid/PRIVATE-LABEL" },
  tracking_code: "TRACKING_SYNTHETIC",
};
const refunded = { ...purchased, refund_status: "submitted" };
type Scenario =
  | "success"
  | "refusal"
  | "no-rates"
  | "transport"
  | "no-echo"
  | "buy-lost"
  | "created-not-bought"
  | "missing-correlation"
  | "recovery-unknown"
  | "void-failure"
  | "production";
function syntheticProvider(scenario: Scenario = "success") {
  const calls: { method: string; path: string; body: unknown }[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const url = new URL(String(input));
    expect(url.origin).toBe("https://api.easypost.com");
    const method = init?.method ?? "GET",
      path = url.pathname;
    calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (scenario === "transport") throw new Error("SECRET-ERROR-SYNTHETIC");
    if (scenario === "refusal" && path.endsWith("/shipments"))
      return Response.json({ mode: "test", error: { message: "SECRET-ERROR-SYNTHETIC" } }, { status: 422 });
    if (path.endsWith("/buy") && ["buy-lost", "created-not-bought", "recovery-unknown"].includes(scenario))
      throw new Error("SECRET-BUY-SYNTHETIC");
    if (path.endsWith("/refund") && scenario === "void-failure")
      return Response.json({ mode: "test", error: "SECRET-VOID-SYNTHETIC" }, { status: 500 });
    if (method === "GET" && scenario === "recovery-unknown") return new Response("", { status: 404 });
    const body: Record<string, unknown> = structuredClone(
      path.endsWith("/refund")
        ? refunded
        : path.endsWith("/buy") || (method === "GET" && scenario !== "created-not-bought")
          ? purchased
          : created,
    );
    if (scenario === "no-echo") delete body.mode;
    if (scenario === "production") body.mode = "production";
    if (scenario === "no-rates") body.rates = [];
    if (scenario === "missing-correlation") delete body.id;
    return Response.json(body);
  });
  return { fetch, calls };
}
function receipt(payload: string, checkpoint: (typeof checkpoints)[number], owner = identity): UploadedRecord {
  return {
    payload,
    receipt: {
      runId: owner.runId,
      runAttempt: owner.runAttempt,
      checkpoint,
      artifactId: "900000010",
      artifactDigest: `sha256:${"b".repeat(64)}`,
      payloadDigest: digest(payload),
    },
  };
}
function harness(scenario: Scenario = "success", env = environment) {
  const provider = syntheticProvider(scenario);
  const local: Partial<Record<(typeof checkpoints)[number], string>> = {};
  const uploaded: Partial<Record<(typeof checkpoints)[number], UploadedRecord>> = {};
  let publicPayload: string | undefined;
  const phase = async (phase: (typeof phases)[number], resume?: UploadedRecord) =>
    executePhase({
      env: { ...env, COMBINED_PARCEL_PROBE_PHASE: phase },
      now,
      fetch: provider.fetch,
      local,
      uploaded,
      resume,
      write: async (checkpoint, payload) => {
        local[checkpoint] = payload;
      },
      publish: async (payload) => {
        publicPayload = payload;
      },
    });
  const upload = (stage: (typeof checkpoints)[number]) => {
    uploaded[stage] = receipt(local[stage]!, stage, {
      ...identity,
      runId: env.GITHUB_RUN_ID,
      runAttempt: env.GITHUB_RUN_ATTEMPT,
    });
  };
  const complete = async () => {
    await phase("pre-a");
    upload("pre-a");
    await phase("case-a-pre-b");
    upload("post-a");
    upload("pre-b");
    await phase("case-b");
  };
  return {
    ...provider,
    phase,
    upload,
    complete,
    local,
    uploaded,
    publicPayload: () => publicPayload,
    state: (stage: (typeof checkpoints)[number]) => JSON.parse(local[stage]!) as PrivateState,
  };
}
const authorityFixtures: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const directory of authorityFixtures.splice(0)) {
    requireProbe(
      resolve(directory).startsWith(resolve(tmpdir(), "combined-parcel-authority-")),
      "fixture-cleanup-path",
    );
    await rm(directory, { recursive: true, force: true });
  }
});
function forbidNetwork() {
  const sentinel = vi.fn(() => {
    throw new Error("GLOBAL-NETWORK-RESOLUTION-SENTINEL");
  });
  vi.stubGlobal("fetch", sentinel);
  return sentinel;
}

describe("provider-free combined-parcel probe", () => {
  it("collects only the combined-parcel test file under the focused command", () => {
    const packageRoot = resolve(root, "infrastructure/easypost-postage");
    const scriptArgs = focusedCommand.split(" run test")[1]!.trim().split(/\s+/);
    const result = spawnSync(
      process.execPath,
      [
        join(dirname(createRequire(import.meta.url).resolve("vitest/package.json")), "vitest.mjs"),
        "list",
        "--filesOnly",
        "--json",
        "--config",
        "./vitest.config.ts",
        ...scriptArgs,
      ],
      {
        cwd: packageRoot,
        encoding: "utf8",
        env: { ...process.env, EASYPOST_API_KEY: "", COMBINED_PARCEL_PROBE_PHASE: "" },
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    const files = (JSON.parse(result.stdout) as { file: string }[]).map(({ file }) =>
      relative(packageRoot, resolve(packageRoot, file)).replaceAll("\\", "/"),
    );
    expect(files).toEqual(["tests/combined-parcel-probe.test.ts"]);
  });

  it("preserves the existing EasyPost smoke request", async () => {
    const sentinel = forbidNetwork(),
      provider = syntheticProvider();
    await createEasyPostPostageLabelProvider({ apiKey: key, mode: "test", fetch: provider.fetch }).purchaseUspsLabel({
      subjectKind: "shipment",
      subjectId: "SYNTHETIC-SMOKE",
      idempotencyKey: "SYNTHETIC-SMOKE",
      serviceLevel: "GroundAdvantage",
      sender: easyPostTestSender,
      recipient: easyPostTestRecipient,
      package: easyPostTestMemberParcel,
    });
    expect(provider.calls[0].body).toEqual({
      shipment: {
        reference: "SYNTHETIC-SMOKE",
        from_address: {
          name: "Chase Sets Seller",
          company: null,
          street1: "417 Montgomery St",
          street2: null,
          city: "San Francisco",
          state: "CA",
          zip: "94104",
          country: "US",
          phone: "4155550100",
          email: "seller@example.com",
        },
        to_address: {
          name: "Chase Sets Buyer",
          company: null,
          street1: "388 Townsend St",
          street2: null,
          city: "San Francisco",
          state: "CA",
          zip: "94107",
          country: "US",
          phone: "4155550101",
          email: "buyer@example.com",
        },
        parcel: { length: 7, width: 5, height: 1, weight: 4 },
        options: { label_format: "PDF" },
      },
    });
    const smoke = readFileSync(join(root, "infrastructure/easypost-postage/easypost-smoke.test.ts"), "utf8");
    expect(smoke).toContain("sender: easyPostTestSender");
    expect(smoke).toContain("package: easyPostTestMemberParcel");
    expect(sentinel).not.toHaveBeenCalled();
  });

  it("keeps the combined-parcel provider path unreachable unless every guard agrees", async () => {
    const sentinel = forbidNetwork();
    const invalid: Record<string, string>[] = [
      { COMBINED_PARCEL_PROBE_CONFIRM: "" },
      { COMBINED_PARCEL_PROBE_CONFIRM: `${confirmation} ` },
      { COMBINED_PARCEL_PROBE_WORKFLOW_CONFIRM: "verify sandbox providers" },
      { COMBINED_PARCEL_PROBE_SOURCE_SHA: "main" },
      { COMBINED_PARCEL_PROBE_CHECKED_OUT_SHA: "b".repeat(40) },
      { GITHUB_SHA: "b".repeat(40) },
      { EASYPOST_MODE: "production" },
      { EASYPOST_API_KEY: "" },
      { EASYPOST_API_KEY: "EZAK-SYNTHETIC" },
      { GITHUB_JOB: "verify-sandbox-provider-evidence" },
      { GITHUB_ACTIONS: "false" },
      { GITHUB_EVENT_NAME: "pull_request" },
      { GITHUB_REF: "refs/heads/other" },
      { GITHUB_REPOSITORY: "synthetic/other" },
      { GITHUB_WORKFLOW_REF: "wrong" },
      { COMBINED_PARCEL_PROBE_ENVIRONMENT: "production" },
      { GITHUB_RUN_ID: "" },
      { GITHUB_RUN_ATTEMPT: "0" },
      { COMBINED_PARCEL_PROBE_PHASE: "unknown" },
    ];
    for (const mutation of invalid) expect(() => guardProvider({ ...environment, ...mutation })).toThrow();
    expect(() => guardProvider({})).toThrow();
    for (const phase of phases)
      expect(guardProvider({ ...environment, COMBINED_PARCEL_PROBE_PHASE: phase }).phase).toBe(phase);
    const h = harness();
    await h.phase("pre-a");
    expect(h.calls).toEqual([]);
    await expect(h.phase("case-a-pre-b")).rejects.toThrow("uploaded-pre-lock-required");
    expect(h.calls).toEqual([]);
    h.upload("pre-a");
    h.uploaded["pre-a"]!.payload += " ";
    await expect(h.phase("case-a-pre-b")).rejects.toThrow("uploaded-record-binding");
    expect(h.calls).toEqual([]);
    expect(sentinel).not.toHaveBeenCalled();
  });

  it("serializes the two cases through the executable mapper with only reference and insurance differences", async () => {
    const sentinel = forbidNetwork(),
      h = harness();
    await h.complete();
    expect(h.calls.map((c) => c.path)).toEqual([
      "/v2/shipments",
      "/v2/shipments/shp_SYNTHETIC/buy",
      "/v2/shipments/shp_SYNTHETIC/refund",
      "/v2/shipments",
      "/v2/shipments/shp_SYNTHETIC/buy",
      "/v2/shipments/shp_SYNTHETIC/refund",
    ]);
    const a = (h.calls[0].body as { shipment: Record<string, unknown> }).shipment;
    const b = (h.calls[3].body as { shipment: Record<string, unknown> }).shipment;
    expect(a.parcel).toEqual({ length: 7, width: 5, height: 2, weight: 8 });
    expect(a.reference).toBe("CHASE-SETS-PROBE-6461-UNINSURED-SYNTHETIC-SHIPMENT");
    expect(b.reference).toBe("CHASE-SETS-PROBE-6461-INSURED-SYNTHETIC-SHIPMENT");
    expect(b.options).toEqual({ label_format: "PDF", insurance: "600.00" });
    expect({ ...b, reference: a.reference, options: a.options }).toEqual(a);
    expect(Object.keys(a).sort()).toEqual(["from_address", "options", "parcel", "reference", "to_address"]);
    expect(sentinel).not.toHaveBeenCalled();
  });

  it("derives public facts from observed calls", async () => {
    forbidNetwork();
    const h = harness();
    await h.complete();
    const records = JSON.parse(h.publicPayload()!) as PublicRecord[];
    expect(records[0]).toMatchObject({
      outcome: "accepted",
      providerModeEchoed: "test",
      ratesReturnedCount: 1,
      uspsRatesReturnedCount: 1,
      serviceLevelMatched: true,
      selectedRateAmountCents: 525,
      selectedRateCurrency: "USD",
      cleanupState: "voided",
      refundStatusEchoed: "submitted",
    });
    const missing = harness("no-echo");
    await missing.complete();
    expect(JSON.parse(missing.publicPayload()!)[0]).toMatchObject({
      outcome: "inconclusive",
      providerModeEchoed: null,
      cleanupState: "voided",
    });
    const provider = syntheticProvider("no-echo");
    const mapped = await createEasyPostPostageLabelProvider({
      apiKey: key,
      mode: "test",
      fetch: provider.fetch,
    }).purchaseUspsLabel(caseRequest(caseIds[0]));
    expect(mapped.providerMode).toBe("test");
    const production = harness("production");
    await production.phase("pre-a");
    production.upload("pre-a");
    await expect(production.phase("case-a-pre-b")).rejects.toThrow("blocked-case-a");
    expect(production.state("post-a").cases[caseIds[0]].publicRecord).toMatchObject({
      outcome: "inconclusive",
      providerModeEchoed: "production",
    });
    expect(production.calls).toHaveLength(1);
  });

  it("redacts every public surface", async () => {
    forbidNetwork();
    const log = vi.spyOn(console, "log"),
      warn = vi.spyOn(console, "warn"),
      error = vi.spyOn(console, "error");
    for (const scenario of ["success", "refusal", "transport", "buy-lost"] as const) {
      const h = harness(scenario);
      await h.complete();
      const surface = h.publicPayload()!;
      for (const marker of [
        key,
        digest(key),
        "shp_SYNTHETIC",
        "pl_SYNTHETIC",
        "rate_SYNTHETIC",
        "TRACKING_SYNTHETIC",
        "PRIVATE-LABEL",
        "SECRET-ERROR-SYNTHETIC",
        "SECRET-BUY-SYNTHETIC",
        "417 Montgomery",
        "388 Townsend",
        "seller@example.com",
        "Authorization",
      ])
        expect(surface).not.toContain(marker);
      const mutated = JSON.parse(surface);
      mutated[0].parcel.secret = key;
      expect(() => validatePublicEvidence(mutated)).toThrow("closed-schema");
      mutated[0] = { ...JSON.parse(surface)[0], refundStatusEchoed: key };
      expect(() => validatePublicEvidence(mutated)).toThrow();
    }
    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it.each([429, 500, 422])("does not treat a %i error or configured mode as an external echo", async (status) => {
    const sentinel = forbidNetwork();
    const h = harness();
    await h.phase("pre-a");
    const state = h.state("pre-a");
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({ error: { message: "SECRET-ERROR-NO-MODE" } }, { status }),
    );
    await runCase(state, caseIds[0], identity, key, fetch, now);
    expect(state.cases[caseIds[0]].publicRecord).toMatchObject({
      providerModeEchoed: null,
      outcome: "inconclusive",
      httpStatus: status,
      cleanupState: "not-purchased",
    });
    expect(JSON.stringify(state)).not.toContain("SECRET-ERROR-NO-MODE");
    expect(sentinel).not.toHaveBeenCalled();
  });

  it("keeps the response deadline over the entire body projection", async () => {
    forbidNetwork();
    const h = harness();
    await h.phase("pre-a");
    vi.useFakeTimers();
    try {
      const c = h.state("pre-a").cases[caseIds[0]];
      const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(new ReadableStream({ start() {} })));
      const pending = observedFetch(c, fetch)("https://api.easypost.com/v2/shipments", { method: "POST" });
      const assertion = expect(pending).rejects.toThrow("provider-deadline");
      await vi.advanceTimersByTimeAsync(30_000);
      await assertion;
      expect(c.observations.create.mode).toBeNull();
      expect(c.createCount).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("blocks contradictory shipment authority and does not call projection failures provider refusals", async () => {
    forbidNetwork();
    for (const conflicting of [false, true]) {
      const h = harness();
      await h.phase("pre-a");
      const state = h.state("pre-a"),
        calls: string[] = [];
      const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
        const path = new URL(String(input)).pathname;
        calls.push(path);
        return Response.json(
          conflicting
            ? path.endsWith("/buy")
              ? { ...purchased, id: "shp_CONTRADICTORY_SYNTHETIC" }
              : created
            : { ...created, rates: Array.from({ length: 501 }, () => rate) },
        );
      });
      await runCase(state, caseIds[0], identity, key, fetch, now);
      const c = state.cases[caseIds[0]];
      expect(c.publicRecord?.outcome).toBe("inconclusive");
      expect(c.phase).toBe(conflicting ? "reconciliation-required" : "not-purchased");
      expect(c.recoveryCount).toBe(0);
      expect(c.voidCount).toBe(0);
      expect(calls).toHaveLength(conflicting ? 2 : 1);
    }
  });

  it("accepts only the closed transition DAG and never rebuys an attempted case", async () => {
    forbidNetwork();
    const edges: Record<string, string[]> = {
      unattempted: ["attempt-locked"],
      "attempt-locked": ["not-purchased", "purchase-ambiguous", "purchase-confirmed"],
      "purchase-ambiguous": ["not-purchased", "purchase-confirmed", "reconciliation-required"],
      "purchase-confirmed": ["voided", "void-failed", "reconciliation-required"],
      voided: [],
      "not-purchased": [],
      "void-failed": [],
      "reconciliation-required": [],
    };
    for (const [from, allowed] of Object.entries(edges))
      for (const to of Object.keys(edges)) {
        const c = freshState(identity, key, now).cases[caseIds[0]];
        c.phase = from as typeof c.phase;
        if (allowed.includes(to)) expect(() => transition(c, to as typeof c.phase)).not.toThrow();
        else expect(() => transition(c, to as typeof c.phase)).toThrow("illegal-transition");
      }
    const original = harness();
    await original.phase("pre-a");
    const originalState = original.state("pre-a");
    expect(originalState.cases[caseIds[0]]).toMatchObject({
      phase: "attempt-locked",
      purchaseAttemptCount: 1,
      createCount: 0,
    });
    const resumeEnv = {
      ...environment,
      GITHUB_RUN_ID: "900000002",
      COMBINED_PARCEL_PROBE_RESUME_RUN_ID: identity.runId,
      COMBINED_PARCEL_PROBE_RESUME_RUN_ATTEMPT: "1",
      COMBINED_PARCEL_PROBE_RESUME_CHECKPOINT: "pre-a",
    };
    const resumed = harness("success", resumeEnv);
    await resumed.phase("pre-a", receipt(original.local["pre-a"]!, "pre-a"));
    resumed.upload("pre-a");
    await expect(resumed.phase("case-a-pre-b")).rejects.toThrow("blocked-case-a");
    expect(resumed.calls).toEqual([]);
    expect(resumed.local["post-a"]).toBeDefined();
    expect(resumed.local["pre-b"]).toBeUndefined();
    expect(resumed.state("post-a").cases[caseIds[0]].phase).toBe("reconciliation-required");
    for (const phase of phases) {
      const h = harness("success", { ...environment, EASYPOST_API_KEY: `${key}-ROTATED` });
      if (phase === "pre-a")
        await expect(
          executePhase({
            env: { ...resumeEnv, EASYPOST_API_KEY: `${key}-ROTATED` },
            now,
            fetch: h.fetch,
            resume: receipt(original.local["pre-a"]!, "pre-a"),
            write: async () => {},
            publish: async () => {},
          }),
        ).rejects.toThrow("credential-continuity");
      else {
        const complete = harness();
        await complete.complete();
        await expect(
          executePhase({
            env: { ...environment, EASYPOST_API_KEY: `${key}-ROTATED`, COMBINED_PARCEL_PROBE_PHASE: phase },
            now,
            fetch: h.fetch,
            uploaded: {
              "pre-a": receipt(complete.local["pre-a"]!, "pre-a"),
              "post-a": receipt(complete.local["post-a"]!, "post-a"),
              "pre-b": receipt(complete.local["pre-b"]!, "pre-b"),
            },
            local: complete.local,
            write: async () => {},
            publish: async () => {},
          }),
        ).rejects.toThrow("credential-continuity");
      }
      expect(h.calls).toEqual([]);
    }
    const final = harness();
    await final.complete();
    const terminal = final.state("final");
    const inert = syntheticProvider();
    for (const id of caseIds) await runCase(terminal, id, identity, key, inert.fetch, now);
    expect(inert.calls).toEqual([]);
    const invalidStates: ((s: PrivateState) => void)[] = [
      (s) => {
        s.bodyHash = "b".repeat(64);
      },
      (s) => {
        s.sourceSha = "b".repeat(40);
      },
      (s) => {
        s.createdAt = "2026-09-29";
      },
      (s) => {
        s.expiresAt = now;
      },
      (s) => {
        s.updatedAt = "2026-09-28T18:00:00Z";
      },
      (s) => {
        s.cases[caseIds[0]].purchaseAttemptCount = 2;
      },
      (s) => {
        s.cases[caseIds[0]].buyCount = 2;
      },
      (s) => {
        s.cases[caseIds[0]].phase = "unattempted";
      },
      (s) => {
        s.cases[caseIds[0]].publicRecord!.providerModeEchoed = null;
      },
    ];
    for (const mutate of invalidStates) {
      const s = structuredClone(terminal);
      mutate(s);
      expect(() => validateState(s, identity, now, key)).toThrow();
    }
    expect(() => validateState(originalState, identity, now, key, terminal)).toThrow();
    const counter = structuredClone(terminal.cases[caseIds[0]]);
    await expect(
      observedFetch(counter, inert.fetch)("https://api.easypost.com/v2/shipments", { method: "POST" }),
    ).rejects.toThrow("at-most-once-operation");
  });

  it("reconciles ambiguous purchases and blocks Case B until Case A cleanup", async () => {
    forbidNetwork();
    const matrix = [
      ["success", "voided", 1, 0, 1],
      ["refusal", "not-purchased", 0, 0, 0],
      ["no-rates", "not-purchased", 0, 0, 0],
      ["transport", "not-purchased", 0, 0, 0],
      ["no-echo", "voided", 1, 0, 1],
      ["buy-lost", "voided", 1, 1, 1],
      ["created-not-bought", "not-purchased", 1, 1, 0],
      ["recovery-unknown", "reconciliation-required", 1, 1, 0],
      ["void-failure", "void-failed", 1, 0, 1],
    ] as const;
    for (const [scenario, phase, buy, recovery, voids] of matrix) {
      const h = harness(scenario);
      await h.phase("pre-a");
      h.upload("pre-a");
      if (["void-failed", "reconciliation-required"].includes(phase))
        await expect(h.phase("case-a-pre-b")).rejects.toThrow("blocked-case-a");
      else await h.phase("case-a-pre-b");
      const state = h.state("post-a"),
        a = state.cases[caseIds[0]];
      expect(a).toMatchObject({ phase, buyCount: buy, recoveryCount: recovery, voidCount: voids });
      expect(state.cases[caseIds[1]].phase).toBe("unattempted");
      if (recovery) expect(h.calls.find((call) => call.method === "GET")!.path).toBe("/v2/shipments/shp_SYNTHETIC");
      if (["void-failed", "reconciliation-required"].includes(phase)) {
        expect(h.local["pre-b"]).toBeUndefined();
        expect(h.publicPayload()).toBeUndefined();
        const calls = h.calls.length;
        await runCase(state, caseIds[0], identity, key, h.fetch, now);
        expect(h.calls).toHaveLength(calls);
      }
    }
  });

  it("validates combined-parcel-probe-evidence/v1 recursively and fail-closed", async () => {
    forbidNetwork();
    const h = harness();
    await h.complete();
    const records = JSON.parse(h.publicPayload()!) as PublicRecord[];
    validatePublicEvidence(records);
    const mutations: ((r: PublicRecord) => unknown)[] = [
      (r) => ({ ...r, extra: "forbidden" }),
      (r) => ({ ...r, parcel: { ...r.parcel, extra: 1 } }),
      (r) => ({ ...r, capturedAt: "2026-09-29" }),
      (r) => ({ ...r, capturedAt: "2026-02-30T10:00:00Z" }),
      (r) => ({ ...r, parcel: { ...r.parcel, weightOunces: 1121 } }),
      (r) => ({ ...r, selectedRateAmountCents: 1_000_001 }),
      (r) => ({ ...r, ratesReturnedCount: 501 }),
      (r) => ({ ...r, uspsRatesReturnedCount: 2 }),
      (r) => ({ ...r, providerModeEchoed: null }),
      (r) => ({ ...r, providerModeEchoed: "production" }),
      (r) => ({ ...r, purchaseAttemptCount: 2 }),
      (r) => ({ ...r, cleanupState: "purchased" }),
      (r) => ({ ...r, errorReasonCategory: "other" }),
      (r) => ({ ...r, errorReasonCategoryAssignedBy: "operator" }),
      (r) => ({ ...r, privateCorrelationReference: "shp_SYNTHETIC" }),
      (r) => ({ ...r, refundStatusEchoed: "https://secret.invalid" }),
    ];
    for (const mutate of mutations) expect(() => validatePublicRecord(mutate(records[0]))).toThrow();
    for (const name of Object.keys(records[0])) {
      const incomplete = { ...records[0] } as Record<string, unknown>;
      delete incomplete[name];
      expect(() => validatePublicRecord(incomplete)).toThrow();
    }
    expect(() => validatePublicEvidence([...records].reverse())).toThrow();
    expect(() => validatePublicEvidence([records[0]])).toThrow();
    validatePublicRecord({ ...records[0], outcome: "inconclusive", providerModeEchoed: null });
  });

  it("publishes only exact provenance-bound artifacts", async () => {
    const sentinel = forbidNetwork(),
      h = harness();
    await h.complete();
    for (const stage of checkpoints) {
      const uploaded = receipt(h.local[stage]!, stage);
      expect(validateUploadedRecord(uploaded, identity, stage, now, h.local[stage]).checkpoint).toBe(stage);
      expect(() => validateUploadedRecord(uploaded, { ...identity, runAttempt: "2" }, stage, now)).toThrow();
      expect(() => validateUploadedRecord(uploaded, identity, stage, "2026-11-01T00:00:00Z")).toThrow();
      expect(() => validateUploadedRecord(uploaded, identity, stage, now, `${h.local[stage]} `)).toThrow();
    }
    expect(resumeInput({})).toBeNull();
    for (const env of [
      { COMBINED_PARCEL_PROBE_RESUME_RUN_ID: "1" },
      {
        COMBINED_PARCEL_PROBE_RESUME_RUN_ID: "1",
        COMBINED_PARCEL_PROBE_RESUME_RUN_ATTEMPT: "1",
        COMBINED_PARCEL_PROBE_RESUME_CHECKPOINT: "latest",
      },
    ])
      expect(() => resumeInput(env)).toThrow();
    const directory = await mkdtemp(join(tmpdir(), "combined-parcel-download-"));
    try {
      const payload = h.local["pre-a"]!;
      await writeFile(join(directory, privateFilename), payload);
      const archiveBytes = new TextEncoder().encode("SYNTHETIC-ARCHIVE-NOT-LIVE-EVIDENCE");
      const archiveDigest = `sha256:${digest(archiveBytes)}`;
      const run = {
        id: Number(identity.runId),
        run_attempt: 1,
        path: workflowPath,
        head_sha: identity.sourceSha,
        repository: { full_name: identity.repository },
        event: "workflow_dispatch",
        head_branch: "main",
        status: "completed",
      };
      const artifact = {
        id: 900000010,
        name: privateArtifactName(identity.runId, "1", "pre-a"),
        expired: false,
        expires_at: "2026-10-29T18:00:00Z",
        workflow_run: { id: Number(identity.runId) },
        digest: archiveDigest,
      };
      const github = (mutate: (value: Record<string, unknown>, path: string) => void = () => {}) =>
        vi.fn<typeof fetch>(async (input) => {
          const url = new URL(String(input));
          expect(url.origin).toBe("https://api.github.com");
          if (url.pathname.endsWith("/zip")) return new Response(archiveBytes);
          const body: Record<string, unknown> = structuredClone(
            url.pathname.includes("/attempts/") || url.pathname.endsWith(`/runs/${identity.runId}`)
              ? run
              : url.pathname.endsWith("/artifacts")
                ? url.searchParams.get("name") === artifact.name
                  ? { total_count: 1, artifacts: [artifact] }
                  : { total_count: 0, artifacts: [] }
                : artifact,
          );
          mutate(body, url.pathname);
          return Response.json(body);
        });
      const input = {
        identity,
        checkpoint: "pre-a" as const,
        directory,
        now,
        token: "SYNTHETIC-GITHUB-TOKEN",
        fetch: github(),
        archivePayload: async () => payload,
        localPayload: payload,
        artifactId: "900000010",
        artifactDigest: digest(archiveBytes),
      };
      const verified = await validateArtifact(input);
      expect(verified.receipt.artifactDigest).toBe(archiveDigest);
      const resume = await validateArtifact({ ...input, artifactId: undefined, artifactDigest: undefined });
      expect(resume.payload).toBe(payload);
      const wrong: ((body: Record<string, unknown>, path: string) => void)[] = [
        (b, p) => {
          if (p.includes("/attempts/")) b.path = "wrong-workflow";
        },
        (b, p) => {
          if (p.includes("/attempts/")) b.repository = { full_name: "synthetic/other" };
        },
        (b, p) => {
          if (p.endsWith("/900000010")) b.expired = true;
        },
        (b, p) => {
          if (p.endsWith("/900000010")) b.digest = `sha256:${"0".repeat(64)}`;
        },
        (b, p) => {
          if (p.endsWith("/900000010")) b.name = privateArtifactName(identity.runId, "2", "pre-a");
        },
      ];
      for (const mutate of wrong) await expect(validateArtifact({ ...input, fetch: github(mutate) })).rejects.toThrow();
      await expect(
        validateArtifact({
          ...input,
          artifactId: undefined,
          fetch: github((b, p) => {
            if (p.endsWith("/artifacts") && b.total_count === 1) {
              b.total_count = 2;
              b.artifacts = [artifact, artifact];
            }
          }),
        }),
      ).rejects.toThrow("one-exact-artifact-required");
      await expect(
        validateArtifact({
          ...input,
          artifactId: undefined,
          fetch: github((b, p) => {
            if (p.endsWith("/artifacts") && b.total_count === 0) {
              b.total_count = 1;
              b.artifacts = [artifact];
            }
          }),
        }),
      ).rejects.toThrow("resume-checkpoint-rollback");
      await expect(
        validateArtifact({
          ...input,
          artifactId: undefined,
          fetch: github((b, p) => {
            if (p.endsWith(`/runs/${identity.runId}`)) b.run_attempt = 2;
          }),
        }),
      ).rejects.toThrow("resume-attempt-not-quiescent");
      await expect(validateArtifact({ ...input, archivePayload: async () => "{}" })).rejects.toThrow(
        "archive-payload-mismatch",
      );
      expect(sentinel).not.toHaveBeenCalled();
    } finally {
      requireProbe(
        resolve(directory).startsWith(resolve(tmpdir(), "combined-parcel-download-")),
        "fixture-cleanup-path",
      );
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("carries each resume checkpoint through the three phases without a second purchase", async () => {
    forbidNetwork();
    const original = harness();
    await original.complete();
    for (const checkpoint of checkpoints) {
      const env = {
        ...environment,
        GITHUB_RUN_ID: "900000002",
        COMBINED_PARCEL_PROBE_RESUME_RUN_ID: identity.runId,
        COMBINED_PARCEL_PROBE_RESUME_RUN_ATTEMPT: "1",
        COMBINED_PARCEL_PROBE_RESUME_CHECKPOINT: checkpoint,
      };
      const h = harness("success", env);
      await h.phase("pre-a", receipt(original.local[checkpoint]!, checkpoint));
      h.upload("pre-a");
      if (checkpoint === "pre-a") await expect(h.phase("case-a-pre-b")).rejects.toThrow("blocked-case-a");
      else {
        await h.phase("case-a-pre-b");
        h.upload("post-a");
        h.upload("pre-b");
        if (checkpoint === "pre-b") await expect(h.phase("case-b")).rejects.toThrow("ordered-clean-records-required");
        else await h.phase("case-b");
      }
      expect(h.calls.filter((c) => c.path.endsWith("/buy"))).toHaveLength(checkpoint === "post-a" ? 1 : 0);
    }
  });

  it("refuses fresh state on a rerun attempt so a GitHub re-run cannot rebuy Case A", async () => {
    const sentinel = forbidNetwork();
    const rerun = harness("success", { ...environment, GITHUB_RUN_ATTEMPT: "2" });
    await expect(rerun.phase("pre-a")).rejects.toThrow("fresh-state-requires-first-attempt");
    expect(rerun.local).toEqual({});
    expect(rerun.calls).toEqual([]);
    expect(sentinel).not.toHaveBeenCalled();
  });

  it("refuses explicit resume on a rerun attempt so a GitHub re-run cannot rebuy Case B", async () => {
    const sentinel = forbidNetwork();
    const original = harness();
    await original.phase("pre-a");
    original.upload("pre-a");
    await original.phase("case-a-pre-b");
    const source = receipt(original.local["post-a"]!, "post-a");
    expect(validateUploadedRecord(source, identity, "post-a", now).cases[caseIds[1]].phase).toBe("unattempted");
    const resumeEnv = {
      ...environment,
      GITHUB_RUN_ID: "900000002",
      GITHUB_RUN_ATTEMPT: "2",
      COMBINED_PARCEL_PROBE_RESUME_RUN_ID: identity.runId,
      COMBINED_PARCEL_PROBE_RESUME_RUN_ATTEMPT: "1",
      COMBINED_PARCEL_PROBE_RESUME_CHECKPOINT: "post-a",
    };
    const rerun = harness("success", resumeEnv);
    await expect(rerun.phase("pre-a", source)).rejects.toThrow("resume-requires-first-attempt");
    expect(rerun.local).toEqual({});
    expect(rerun.calls).toEqual([]);
    expect(sentinel).not.toHaveBeenCalled();
  });

  it("commits the complete provider-free operator handoff without live values", () => {
    expect(operatorHandoff).toMatchObject({
      bodyHash,
      workflowPath,
      confirmation,
      jobId: "combined-parcel-probe",
      permissions: { contents: "read", actions: "read" },
      focusedCommand,
      phases,
      checkpoints,
      privateFilename,
      publicFilename,
      retentionDays: 30,
      liveValues: null,
    });
    expect(operatorHandoff.resumeInputs).toEqual([
      "combined_parcel_probe_resume_run_id",
      "combined_parcel_probe_resume_run_attempt",
      "combined_parcel_probe_resume_checkpoint",
    ]);
    expect(operatorHandoff.operatorEvidenceFields).toEqual([
      "immutableSourceSha",
      "workflowPath",
      "approvalIdentity",
      "approvalUrl",
      "runId",
      "runAttempt",
      "runUrl",
      "jobId",
      "jobUrl",
      "jobConclusion",
      "executedSteps",
      "resumeInputs",
      "checkpoint",
      "privateArtifactId",
      "privateArtifactName",
      "privateArtifactDigest",
      "privatePayloadDigest",
      "privateProvenance",
      "privateExpiry",
      "downloadResult",
      "reconciliationResult",
      "credentialContinuityResult",
      "uninsuredCleanup",
      "insuredCleanup",
      "publicArtifactId",
      "publicArtifactName",
      "publicArtifactDigest",
      "finalRedactedEvidenceUrl",
      "redactedCommentUrl",
      "issue6462HandoffUrl",
    ]);
    expect(publicArtifactName(identity.runId, "2")).toBe(`combined-parcel-probe-public-${identity.runId}-2`);
  });
});

type Step = {
  id?: string;
  name?: string;
  run?: string;
  uses?: string;
  if?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
  permissions?: unknown;
};
type Job = {
  permissions?: Record<string, string>;
  env: Record<string, string>;
  steps: Step[];
  if?: string;
  environment?: string;
  needs?: string;
};
type Workflow = {
  permissions: Record<string, string>;
  jobs: Record<string, Job>;
  on: { workflow_dispatch: { inputs: Record<string, unknown> } };
};
const workflow = (): Workflow => parse(readFileSync(join(root, workflowPath), "utf8")) as Workflow;
function assertWorkflow(w: Workflow) {
  const job = w.jobs["combined-parcel-probe"],
    steps = job.steps;
  requireProbe(JSON.stringify(w.permissions) === JSON.stringify({ contents: "read" }), "workflow-permissions");
  requireProbe(
    JSON.stringify(job.permissions) === JSON.stringify({ contents: "read", actions: "read" }),
    "job-permissions",
  );
  requireProbe(
    job.environment === "staging" &&
      job.needs === "refuse-unconfirmed" &&
      job.if === `always() && needs.refuse-unconfirmed.result == 'skipped' && inputs.confirm == '${confirmation}'`,
    "job-authority",
  );
  requireProbe(
    w.jobs["refuse-unconfirmed"].if ===
      `inputs.confirm != 'seed staging commerce' && inputs.confirm != 'verify sandbox providers' && inputs.confirm != '${confirmation}'`,
    "refusal-reachability",
  );
  requireProbe(job.env.EASYPOST_API_KEY === "${{ secrets.EASYPOST_API_KEY }}", "job-ingress");
  const keySteps = steps.filter((s) => s.env?.EASYPOST_API_KEY !== "");
  requireProbe(
    keySteps.length === 3 &&
      keySteps.every(
        (s, i) =>
          s.run === focusedCommand &&
          s.env?.COMBINED_PARCEL_PROBE_PHASE === phases[i] &&
          s.id === phases[i] &&
          !s.if &&
          !s.uses &&
          !Object.hasOwn(s.env, "EASYPOST_API_KEY"),
      ),
    "three-exact-key-phases",
  );
  requireProbe(
    steps.every((s) => !s.permissions),
    "step-permissions",
  );
  const ids = steps.map((s) => s.id).filter(Boolean);
  requireProbe(new Set(ids).size === ids.length, "duplicate-step");
  const index = (id: string) => {
    const i = steps.findIndex((s) => s.id === id);
    requireProbe(i >= 0, "missing-step");
    return i;
  };
  const ordered = [
    "pre-a",
    "upload-pre-a",
    "download-pre-a",
    "validate-pre-a",
    "case-a-pre-b",
    "upload-post-a",
    "upload-pre-b",
    "download-post-a",
    "validate-post-a",
    "download-pre-b",
    "validate-pre-b",
    "case-b",
    "upload-final",
    "download-final",
    "validate-final",
    "upload-public",
  ];
  requireProbe(
    ordered.every((id, i) => i === 0 || index(id) > index(ordered[i - 1])),
    "phase-upload-order",
  );
  for (const checkpoint of checkpoints) {
    const upload = steps[index(`upload-${checkpoint}`)],
      download = steps[index(`download-${checkpoint}`)],
      validation = steps[index(`validate-${checkpoint}`)];
    requireProbe(
      upload.uses === "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a" &&
        upload.with?.["if-no-files-found"] === "error" &&
        upload.with?.["retention-days"] === 30,
      "fail-closed-upload",
    );
    requireProbe(
      upload.with.name ===
        `combined-parcel-probe-private-${"${{ github.run_id }}"}-${"${{ github.run_attempt }}"}-${checkpoint}` &&
        upload.with.path === `artifacts/combined-parcel-probe/${checkpoint}/${privateFilename}`,
      "exact-private-artifact",
    );
    requireProbe(
      upload.if ===
        (["post-a", "final"].includes(checkpoint)
          ? `\${{ !cancelled() && hashFiles('artifacts/combined-parcel-probe/${checkpoint}/${privateFilename}') != '' }}`
          : undefined),
      "blocked-private-durability",
    );
    requireProbe(
      download.uses === "actions/download-artifact@37930b1c2abaa49bbe596cd826c3c89aef350131" &&
        download.with?.name === upload.with.name &&
        download.with?.path === `artifacts/combined-parcel-probe/download-${checkpoint}` &&
        !download.if &&
        !download.with?.["run-id"],
      "exact-re-download",
    );
    requireProbe(
      !validation.if &&
        validation.run ===
          `pnpm exec tsx infrastructure/easypost-postage/tests/combined-parcel-probe.ts ${checkpoint}` &&
        validation.env?.COMBINED_PARCEL_PROBE_ARTIFACT_ID ===
          `\${{ steps.upload-${checkpoint}.outputs.artifact-id }}` &&
        validation.env?.COMBINED_PARCEL_PROBE_ARTIFACT_DIGEST ===
          `\${{ steps.upload-${checkpoint}.outputs.artifact-digest }}`,
      "prior-record-validation",
    );
  }
  for (const s of steps.filter((s) => s.uses?.startsWith("actions/upload-artifact@")))
    requireProbe(
      s.with?.["if-no-files-found"] === "error" && s.with?.["retention-days"] === 30,
      "all-uploads-fail-closed",
    );
  const resume = steps[index("download-resume")];
  requireProbe(
    resume.with?.["run-id"] === "${{ inputs.combined_parcel_probe_resume_run_id }}" &&
      resume.with?.["github-token"] === "${{ github.token }}" &&
      resume.with?.repository === "${{ github.repository }}" &&
      resume.with?.name ===
        "combined-parcel-probe-private-${{ inputs.combined_parcel_probe_resume_run_id }}-${{ inputs.combined_parcel_probe_resume_run_attempt }}-${{ inputs.combined_parcel_probe_resume_checkpoint }}" &&
      resume.with.path === "artifacts/combined-parcel-probe/download-resume",
    "exact-resume-download",
  );
  requireProbe(
    steps[index("validate-resume")].run ===
      "pnpm exec tsx infrastructure/easypost-postage/tests/combined-parcel-probe.ts resume" &&
      index("validate-resume") < index("pre-a"),
    "resume-validation",
  );
  const publicUpload = steps[index("upload-public")];
  requireProbe(
    !publicUpload.if &&
      publicUpload.with?.name === "combined-parcel-probe-public-${{ github.run_id }}-${{ github.run_attempt }}" &&
      publicUpload.with?.path === `artifacts/combined-parcel-probe/public/${publicFilename}`,
    "canonical-public-upload",
  );
}
describe("parsed combined-parcel workflow authority", () => {
  it("requires exactly the new managed-authority grant before matching the new ingress", async () => {
    const directory = await mkdtemp(join(tmpdir(), "combined-parcel-authority-"));
    authorityFixtures.push(directory);
    await mkdir(join(directory, ".github/workflows"), { recursive: true });
    await mkdir(join(directory, ".github/actions/setup-pnpm-workspace"), { recursive: true });
    await mkdir(join(directory, ".github/actions/export-managed-postgres-authority"), { recursive: true });
    await mkdir(join(directory, "scripts"), { recursive: true });
    const w = workflow();
    await writeFile(
      join(directory, workflowPath),
      stringify({
        permissions: w.permissions,
        jobs: {
          "combined-parcel-probe": w.jobs["combined-parcel-probe"],
          "synthetic-boundary-control": {
            steps: [
              {
                uses: "./.github/actions/export-managed-postgres-authority",
                with: { mode: "trust-only-kubernetes-secret" },
                env: { DIGITALOCEAN_ACCESS_TOKEN: "${{ secrets.DIGITALOCEAN_ACCESS_TOKEN }}" },
              },
            ],
          },
        },
      }),
    );
    const action = ".github/actions/setup-pnpm-workspace/action.yml";
    await writeFile(join(directory, action), readFileSync(join(root, action)));
    await writeFile(
      join(directory, ".github/actions/export-managed-postgres-authority/action.yml"),
      stringify({
        name: "Synthetic boundary control",
        runs: { using: "composite", steps: [{ shell: "bash", run: "echo synthetic" }] },
      }),
    );
    const baselineGrant = {
      file: workflowPath,
      jobId: "synthetic-boundary-control",
      stepAnchor: "uses:./.github/actions/export-managed-postgres-authority",
      secretName: "DIGITALOCEAN_ACCESS_TOKEN",
      purpose: "managed-postgres-boundary",
    };
    const schema = "scripts/managed-postgres-authority-manifest.schema.json";
    await writeFile(join(directory, schema), readFileSync(join(root, schema)));
    const manifestFile = "scripts/managed-postgres-authority-manifest.json";
    const manifest = JSON.parse(readFileSync(join(root, manifestFile), "utf8")) as { grants: Record<string, string>[] };
    const grants = manifest.grants.filter((g) => g.file === workflowPath && g.jobId === "combined-parcel-probe");
    expect(grants).toEqual([
      {
        file: workflowPath,
        jobId: "combined-parcel-probe",
        stepAnchor: "job",
        secretName: "EASYPOST_API_KEY",
        purpose: "test-credentials",
      },
    ]);
    for (const present of [false, true]) {
      await writeFile(
        join(directory, manifestFile),
        JSON.stringify({ schemaVersion: 1, grants: [baselineGrant, ...(present ? grants : [])], dockerConsumers: [] }),
      );
      const result = spawnSync(
        process.execPath,
        [join(root, "scripts/managed-postgres-authority-guard.mjs"), "--repository-root", directory],
        {
          encoding: "utf8",
          windowsHide: true,
          env: {
            ...process.env,
            EASYPOST_API_KEY: "",
            COMBINED_PARCEL_PROBE_CONFIRM: "",
            COMBINED_PARCEL_PROBE_PHASE: "",
          },
        },
      );
      const report = JSON.parse(result.stdout) as {
        violations: { code: string; file: string; jobId: string; secretName: string }[];
        ingressCoverage: string;
      };
      if (present) {
        expect(result.status).toBe(0);
        expect(report.violations).toEqual([]);
        expect(report.ingressCoverage).toBe("2/2");
      } else {
        expect(result.status).toBe(1);
        expect(report.violations).toEqual([
          expect.objectContaining({
            code: "unmanifested-secret-ingress",
            file: workflowPath,
            jobId: "combined-parcel-probe",
            stepAnchor: "job",
          }),
        ]);
      }
    }
  });
  it("accepts the candidate and rejects named structural bypass mutants", () => {
    assertWorkflow(workflow());
    const mutations: [string, (w: Workflow, job: Job) => void][] = [
      [
        "remove actions read",
        (_, j) => {
          delete j.permissions!.actions;
        },
      ],
      [
        "hoist actions read",
        (w, j) => {
          delete j.permissions!.actions;
          w.permissions.actions = "read";
        },
      ],
      [
        "wrong job scope",
        (w, j) => {
          delete j.permissions!.actions;
          w.jobs["refuse-unconfirmed"].permissions = { actions: "read" };
        },
      ],
      [
        "step scope",
        (_, j) => {
          delete j.permissions!.actions;
          j.steps[0].permissions = { actions: "read" };
        },
      ],
      [
        "write permission",
        (_, j) => {
          j.permissions!.actions = "write";
        },
      ],
      [
        "refusal clause omitted",
        (w) => {
          w.jobs["refuse-unconfirmed"].if =
            "inputs.confirm != 'seed staging commerce' && inputs.confirm != 'verify sandbox providers'";
        },
      ],
      [
        "missing phase",
        (_, j) => {
          j.steps = j.steps.filter((s) => s.id !== "pre-a");
        },
      ],
      [
        "duplicate phase",
        (_, j) => {
          j.steps.push(structuredClone(j.steps.find((s) => s.id === "pre-a")!));
        },
      ],
      [
        "reordered phase",
        (_, j) => {
          const a = j.steps.find((s) => s.id === "pre-a")!,
            b = j.steps.find((s) => s.id === "case-b")!;
          [a.env, b.env] = [b.env, a.env];
        },
      ],
      [
        "broader secret inheritance",
        (_, j) => {
          delete j.steps[0].env!.EASYPOST_API_KEY;
        },
      ],
      ...[
        "pnpm --filter @chase-sets/easypost-postage run test",
        focusedCommand.replace("combined-parcel-probe.test.ts", "easypost-smoke.test.ts"),
        focusedCommand.replace("combined-parcel-probe.test.ts", "*.test.ts"),
        `${focusedCommand} easypost-smoke.test.ts`,
        `${focusedCommand} && echo bypass`,
        "pnpm --filter @chase-sets/easypost-postage run test -- tests/combined-parcel-probe.test.ts",
      ].map((command): [string, (w: Workflow, j: Job) => void] => [
        command,
        (_, j) => {
          j.steps.find((s) => s.id === "pre-a")!.run = command;
        },
      ]),
    ];
    for (const checkpoint of checkpoints)
      for (const part of ["upload", "download", "validate"]) {
        mutations.push([
          `missing ${part}-${checkpoint}`,
          (_, j) => {
            j.steps = j.steps.filter((s) => s.id !== `${part}-${checkpoint}`);
          },
        ]);
        mutations.push([
          `skipped ${part}-${checkpoint}`,
          (_, j) => {
            j.steps.find((s) => s.id === `${part}-${checkpoint}`)!.if = "false";
          },
        ]);
      }
    for (const value of [undefined, "warn", "ignore"])
      mutations.push([
        `upload behavior ${value}`,
        (_, j) => {
          j.steps.find((s) => s.id === "upload-pre-a")!.with!["if-no-files-found"] = value;
        },
      ]);
    for (const [name, mutate] of mutations) {
      const w = workflow();
      mutate(w, w.jobs["combined-parcel-probe"]);
      expect(() => assertWorkflow(w), name).toThrow();
    }
  });
});

it("runs only the explicitly selected operator phase", async () => {
  if (!process.env.COMBINED_PARCEL_PROBE_PHASE) return;
  try {
    await runOperatorPhase(process.env);
  } catch {
    throw new Error(
      "combined-parcel-probe: operator-phase-blocked; inspect private checkpoint, never retry a purchase",
    );
  }
});
