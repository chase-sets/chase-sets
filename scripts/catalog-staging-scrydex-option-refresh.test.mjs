import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { runInNewContext } from "node:vm";
import { parse as parseYaml } from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import { scrydexCacheCaptureUnits } from "../bounded-contexts/catalog/features/scope-sync-batches/domain/scrydex-cache-capture.ts";
import {
  applyScrydexOptionRefreshRouteFence,
  runScrydexOptionRefresh,
  writeRefreshArtifact,
} from "./catalog-staging-scrydex-option-refresh.mjs";
import * as refresh from "./catalog-staging-scrydex-option-refresh.mjs";
import * as refreshDomain from "../bounded-contexts/catalog/features/scope-sync-batches/domain/scrydex-option-refresh.ts";
import {
  classifyScrydexOptionRefreshRequest,
  evaluateScrydexUsagePreflight,
  providerPagesUpperBound,
  scrydexOptionRefreshArtifactPath,
  scrydexOptionRefreshDiagnosticArtifactPath,
  scrydexOptionRefreshMaxBytes,
  validateScrydexOptionRefreshReceipt,
} from "../bounded-contexts/catalog/features/scope-sync-batches/domain/scrydex-option-refresh.ts";

const temporaryWorkspaces = [];

afterEach(async () => {
  await Promise.all(temporaryWorkspaces.splice(0).map((workspace) => rm(workspace, { recursive: true, force: true })));
});

const sha = "a".repeat(40);
const imageDigest = `sha256:${"b".repeat(64)}`;
const profileSources = scrydexCacheCaptureUnits.map(() => ({
  supportedScopes: ["set-name"],
  optionQueries: [
    {
      queryKind: "sets",
      queryKeySynonyms: ["set"],
      displayName: "Set",
      scope: "set-name",
      parentScope: null,
    },
  ],
}));

function profiles() {
  return scrydexCacheCaptureUnits.map((unit, index) => {
    const source = profileSources[index];
    return {
      providerKey: "scrydex",
      profileKey: `profile-${index}`,
      profileVersion: index < 3 ? "2026.06.22" : "2026.06.23",
      ingestionUnitKey: unit.unitKey,
      active: true,
      languageOptions: ["en"],
      supportedScopes: [...source.supportedScopes],
      sourceOptionKinds: source.optionQueries.map((query) => ({
        queryKind: query.queryKind,
        queryKeySynonyms: "queryKeySynonyms" in query ? [...(query.queryKeySynonyms ?? [])] : [],
        displayName: query.displayName,
        scope: query.scope,
        parentScope: query.parentScope,
        parentRequired: "parentValue" in query ? Boolean(query.parentValue?.required) : false,
        parentValueKind: "parentValue" in query ? (query.parentValue?.valueKind ?? null) : null,
        parentDiagnosticText: "parentValue" in query ? (query.parentValue?.diagnosticText ?? null) : null,
      })),
    };
  });
}

function responseBody(total = 0) {
  return {
    status: 200,
    body: {
      total,
      cache: {
        status: "live",
        source: "live",
        fetchedAt: "2026-10-21T00:00:00.000Z",
        expiresAt: "2026-10-21T00:15:00.000Z",
        staleUntil: "2026-10-22T00:00:00.000Z",
      },
    },
  };
}

function runnerInput(overrides = {}) {
  const forcedReads = [];
  return {
    runner: {
      sha,
      runId: "1",
      runAttempt: "1",
      journeyScope: "scrydex-force-refresh-bounded",
      origin: "admin.staging.chasesets.com",
    },
    now: () => "2026-10-21T00:00:00.000Z",
    dispatchId: "synthetic-refresh-dispatch",
    periodReserve: {
      runId: "synthetic-refresh-dispatch",
      startsAt: "2026-10-01T00:00:00.000Z",
      endsAt: "2026-11-01T00:00:00.000Z",
      observedAt: "2026-10-21T00:00:00.000Z",
      credits: 0,
    },
    selectDeployment: async () => ({ deployedHead: sha, imageDigest }),
    signIn: async () => {},
    read: async (path) => {
      if (path.includes("integration-control-plane"))
        return {
          providerReadiness: {
            providers: [
              {
                providerKey: "scrydex",
                readiness: "ready",
                usageBudget: {
                  readiness: "ready",
                  freshness: "fresh",
                  creditBalance: 4000,
                  creditAllowance: 5000,
                  billingPeriod: {
                    startsAt: "2026-10-01T00:00:00.000Z",
                    endsAt: "2026-11-01T00:00:00.000Z",
                    overageCreditsConsumed: 0,
                  },
                  observedAt: "2026-10-21T00:00:00.000Z",
                },
              },
            ],
          },
          providerSendWindow: { state: "disabled" },
          readiness: { rolloutControls: { controls: [] } },
        };
      if (path.includes("provider-profiles")) return { items: profiles(), total: 5, count: 5 };
      forcedReads.push(path);
      return responseBody();
    },
    forcedReads,
    ...overrides,
  };
}

async function temporaryWorkspace() {
  const workspace = await mkdtemp(join(tmpdir(), "scrydex-option-refresh-test-"));
  temporaryWorkspaces.push(workspace);
  await writeFile(
    join(workspace, "package.json"),
    JSON.stringify({ name: "scrydex-refresh-isolated-input", private: true }),
  );
  return workspace;
}

async function completeReceipt() {
  return runScrydexOptionRefresh(runnerInput());
}

async function stoppedReceipt() {
  return runScrydexOptionRefresh(
    runnerInput({
      read: async (path) => {
        if (path.includes("integration-control-plane")) return runnerInput().read(path);
        if (path.includes("provider-profiles")) return { items: profiles(), total: 5, count: 5 };
        return { status: 500, body: null };
      },
    }),
  );
}

it("runs five injected route-shaped profile reads and five bounded option reads", async () => {
  const input = runnerInput();
  const receipt = await runScrydexOptionRefresh(input);
  expect(receipt.outcome).toBe("complete");
  expect(receipt.requests).toEqual({ forced: 5, refusals: 0 });
  expect(input.forcedReads).toHaveLength(5);
  expect(
    input.forcedReads.every(
      (path) => new URL(path, "https://admin.staging.chasesets.com").searchParams.get("limit") === "100",
    ),
  ).toBe(true);
  expect(validateScrydexOptionRefreshReceipt(receipt)).toEqual([]);
});

it("refuses the period cap and unknown cross-path reserve before any forced read", async () => {
  for (const reserve of [undefined, { ...runnerInput().periodReserve, credits: 45 }]) {
    const base = runnerInput();
    const input = runnerInput({
      periodReserve: reserve,
      read: async (path) => {
        const response = await base.read(path);
        if (path.includes("integration-control-plane"))
          Object.assign(response.providerReadiness.providers[0].usageBudget, {
            creditAllowance: 100_000,
            creditBalance: 50_100,
          });
        return response;
      },
    });
    const receipt = await runScrydexOptionRefresh(input);
    expect(receipt).toMatchObject({
      outcome: "refused",
      reason: "usage-period-cap",
      requests: { forced: 0 },
      periodLedger: { decision: { plannedCredits: 56 }, outcome: "refused" },
    });
    expect(base.forcedReads).toEqual([]);
  }
});

it("rechecks observation freshness at the forced-send boundary", async () => {
  let at = "2026-10-21T00:00:00.000Z";
  const base = runnerInput();
  const input = runnerInput({
    now: () => at,
    read: async (path) => {
      const response = await base.read(path);
      if (path.includes("provider-profiles")) at = "2026-10-21T00:15:00.001Z";
      return response;
    },
  });
  expect(await runScrydexOptionRefresh(input)).toMatchObject({
    outcome: "refused",
    reason: "usage-period-cap",
    requests: { forced: 0 },
  });
  expect(base.forcedReads).toEqual([]);
});

it("stops on the first uncertain response and leaves remaining units unattempted", async () => {
  let reads = 0;
  const input = runnerInput({
    read: async (path) => {
      if (path.includes("integration-control-plane")) return runnerInput().read(path);
      if (path.includes("provider-profiles")) return { items: profiles(), total: 5, count: 5 };
      reads += 1;
      return reads === 1 ? { status: 500, body: null } : responseBody();
    },
  });
  const receipt = await runScrydexOptionRefresh(input);
  expect(receipt.outcome).toBe("stopped");
  expect(receipt.units.filter((unit) => unit.status === "not-attempted")).toHaveLength(4);
  expect(receipt.units[0]).toMatchObject({ status: "uncertain", total: null, providerPagesUpperBound: null });
  expect(receipt.creditsSpentUpperBound).toBe(1);
  expect(validateScrydexOptionRefreshReceipt(receipt)).toEqual([]);
});

it("treats an over-cap response as uncertain without reading another unit", async () => {
  const input = runnerInput({
    read: async (path) => {
      if (path.includes("integration-control-plane")) return runnerInput().read(path);
      if (path.includes("provider-profiles")) return { items: profiles(), total: 5, count: 5 };
      input.readCount = (input.readCount ?? 0) + 1;
      return { status: 200, body: null, overCap: true };
    },
    readCount: 0,
  });
  const receipt = await runScrydexOptionRefresh(input);
  expect(receipt.outcome).toBe("stopped");
  expect(input.readCount).toBe(1);
  expect(receipt.units[0]).toMatchObject({ status: "uncertain", total: null, providerPagesUpperBound: null });
  expect(validateScrydexOptionRefreshReceipt(receipt)).toEqual([]);
});

describe("refresh artifact contract", () => {
  it("writes a valid complete receipt to the complete artifact path", async () => {
    const workspace = await temporaryWorkspace();
    const receipt = await completeReceipt();
    const artifact = await writeRefreshArtifact(receipt, {}, workspace);

    expect(artifact.path).toBe(join(workspace, scrydexOptionRefreshArtifactPath));
    expect(JSON.parse(await readFile(artifact.path, "utf8"))).toEqual(receipt);
  });

  it("writes a valid stopped receipt to the diagnostic artifact path", async () => {
    const workspace = await temporaryWorkspace();
    const receipt = await stoppedReceipt();
    const artifact = await writeRefreshArtifact(receipt, {}, workspace);

    expect(artifact.path).toBe(join(workspace, scrydexOptionRefreshDiagnosticArtifactPath));
    expect(JSON.parse(await readFile(artifact.path, "utf8"))).toEqual(receipt);
  });

  it("rejects invalid evidence and injected credential values", async () => {
    const workspace = await temporaryWorkspace();
    const receipt = await completeReceipt();
    const invalidReceipt = { ...receipt, requests: { ...receipt.requests, forced: 4 } };

    await expect(writeRefreshArtifact(invalidReceipt, {}, workspace)).rejects.toThrow(
      "scrydex-option-refresh-refused:receipt-invalid",
    );

    const credentialReceipt = { ...receipt, assumptions: [...receipt.assumptions, "synthetic-secret"] };
    await expect(writeRefreshArtifact(credentialReceipt, { GH_TOKEN: "synthetic-secret" }, workspace)).rejects.toThrow(
      "scrydex-option-refresh-refused:receipt-invalid",
    );
  });

  it("rejects a serialized receipt over the byte cap", async () => {
    const workspace = await temporaryWorkspace();
    const receipt = await completeReceipt();
    Object.defineProperty(receipt, "toJSON", {
      value: () => "x".repeat(scrydexOptionRefreshMaxBytes + 1),
      enumerable: false,
    });

    await expect(writeRefreshArtifact(receipt, {}, workspace)).rejects.toThrow(
      "scrydex-option-refresh-refused:receipt-invalid",
    );
  });

  it("refuses a non-empty target artifact directory", async () => {
    const workspace = await temporaryWorkspace();
    const receipt = await completeReceipt();
    const targetDirectory = join(workspace, "artifacts/catalog-scrydex-option-refresh");
    await mkdir(targetDirectory, { recursive: true });
    await writeFile(join(targetDirectory, "placeholder"), "not the artifact");

    await expect(writeRefreshArtifact(receipt, {}, workspace)).rejects.toThrow(
      "scrydex-option-refresh-refused:artifact-directory-not-empty",
    );
  });
});

const runnerUrl = new URL("./catalog-staging-scrydex-option-refresh.mjs", import.meta.url);
const source = () => readFile(runnerUrl, "utf8");
async function functionSource(name) {
  const original = await source();
  const start = original.indexOf(`export async function ${name}(`);
  expect(start).toBeGreaterThan(-1);
  const end = original.indexOf("\nexport ", start + 1);
  return original
    .slice(start, end === -1 ? undefined : end)
    .trim()
    .replace(/^export /, "");
}
const runnerEnv = (workspace) => ({
  ...process.env,
  GITHUB_ACTIONS: "true",
  ADMIN_WEB_URL: "https://admin.staging.chasesets.com",
  GITHUB_SHA: sha,
  EXPECTED_SHA: sha,
  GITHUB_RUN_ID: "1",
  GITHUB_RUN_ATTEMPT: "1",
  CATALOG_STAGING_PROVIDER_UAT_SCOPE: "scrydex-force-refresh-bounded",
  RUNNER_TEMP: workspace,
  TEMP: workspace,
  TMP: workspace,
  TMPDIR: workspace,
  TSX_DISABLE_CACHE: "1",
  FORCE_COLOR: undefined,
  GITHUB_OUTPUT: join(workspace, "output"),
  CATALOG_ADMIN_E2E_EMAIL: "",
  CATALOG_ADMIN_E2E_PASSWORD: "",
  GH_TOKEN: "",
});

async function tsx(args, cwd, env) {
  const argv = ["--import", import.meta.resolve("tsx"), ...args];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, argv, {
      cwd,
      env,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => {
      stdout += data;
    });
    child.stderr.on("data", (data) => {
      stderr += data;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function mutantModule(workspace, before, after) {
  const original = await source();
  expect(original).toContain(before);
  const changed = original
    .replace(before, after)
    .replace(/from "(\.[^"]+)"/g, (_, specifier) => `from "${new URL(specifier, runnerUrl).href}"`);
  const path = join(workspace, "mutant.mjs");
  await writeFile(path, changed);
  return path;
}

async function fourAttemptReceipt() {
  let count = 0;
  const input = runnerInput();
  const read = input.read;
  input.read = (path) =>
    path.includes("forceRefresh=true") && ++count === 4 ? Promise.resolve({ status: 500, body: null }) : read(path);
  const receipt = await runScrydexOptionRefresh(input);
  expect(receipt.requests.forced).toBe(4);
  expect(receipt.creditsSpentUpperBound).toBe(7);
  expect(validateScrydexOptionRefreshReceipt(receipt)).toEqual([]);
  return receipt;
}

describe("serialized bounded page reader", () => {
  async function probe(readerSource, kind) {
    const timers = [];
    const calls = [];
    let signal;
    let cancel = 0;
    let reads = 0;
    const body = {
      items: Array.from({ length: 100 }, (_, index) => ({
        providerKey: "scrydex",
        queryKind: "sets",
        value: `synthetic-set-${index}`,
        label: `Synthetic set ${index}`,
        description: "",
        parentValue: null,
        imageUrl: null,
        aliases: [],
        metadata: { setId: `synthetic-set-${index}`, languageCode: "en" },
      })),
      total: 1000,
      count: 100,
      page: { cursor: null, nextCursor: "offset:100", limit: 100, hasMore: true },
      cache: {
        ...responseBody().body.cache,
        cacheKey: "synthetic-cache-key",
        cacheOnly: false,
        forceRefresh: true,
        degraded: false,
        diagnostics: [],
      },
    };
    const emptyBytes = Buffer.byteLength(JSON.stringify(body));
    body.items[0].description = "x".repeat(scrydexOptionRefreshMaxBytes - emptyBytes);
    const encoded = new TextEncoder().encode(JSON.stringify(body));
    expect(encoded.byteLength).toBe(scrydexOptionRefreshMaxBytes);
    const pending = () =>
      new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted"))));
    const fetchImpl = async (path, init) => {
      calls.push([path, init]);
      signal = init.signal;
      if (kind === "fetch-stall") return pending();
      return {
        ok: true,
        status: 200,
        body: {
          getReader: () => ({
            read: async () => {
              reads += 1;
              if (kind === "body-stall") return pending();
              if (reads === 1) return { done: false, value: encoded };
              if (kind === "cap" && reads === 2) return { done: false, value: new Uint8Array([32]) };
              if (reads > 2) throw new Error("unbounded-read");
              return { done: true };
            },
            cancel: async () => {
              cancel += 1;
            },
            releaseLock: () => {},
          }),
        },
      };
    };
    const reader = runInNewContext(`(${readerSource})`, {
      fetch: fetchImpl,
      AbortController,
      TextDecoder,
      JSON,
      setTimeout: (fn, ms) => {
        timers.push({ fn, ms });
        return 1;
      },
      clearTimeout: () => {},
      console: {
        log: () => {
          throw new Error("body-logged");
        },
        error: () => {
          throw new Error("body-logged");
        },
      },
    });
    let settled;
    const result = reader({ path: "/synthetic", byteCap: scrydexOptionRefreshMaxBytes, deadlineMs: 30_000 }).then(
      (value) => {
        settled = { value };
      },
      (error) => {
        settled = { error };
      },
    );
    for (let i = 0; i < 15; i += 1) await Promise.resolve();
    if (kind.endsWith("stall")) {
      expect(settled).toBeUndefined();
      expect(timers.map(({ ms }) => ms)).toEqual([30_000]);
      timers[0].fn();
      for (let i = 0; i < 15; i += 1) await Promise.resolve();
      expect(signal.aborted).toBe(true);
      expect(settled?.error).toBeDefined();
    }
    await result;
    if (kind === "valid") expect(settled).toEqual({ value: { status: 200, body } });
    if (kind === "cap") {
      expect(settled?.error?.message).toBe("refresh-read-refused");
      expect(reads).toBe(2);
      expect(cancel).toBe(1);
    }
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toMatchObject({
      method: "GET",
      credentials: "same-origin",
      redirect: "error",
      cache: "no-store",
    });
  }

  it.each(["valid", "cap", "fetch-stall", "body-stall"])("executes source in a fresh VM: %s", async (kind) => {
    expect(refresh.readRefreshJsonInPage).toBeTypeOf("function");
    await probe(refresh.readRefreshJsonInPage.toString(), kind);
  });
  it.each([
    ["closure", "bytes > byteCap", "bytes > scrydexOptionRefreshMaxBytes", "valid"],
    ["cap-bypass", "bytes > byteCap", "false", "cap"],
    ["deadline-bypass", "controller.abort()", "undefined", "fetch-stall"],
    ["body-deadline-bypass", "controller.abort()", "undefined", "body-stall"],
  ])("rejects the %s mutant with the unchanged oracle", async (_, before, after, kind) => {
    const original = refresh.readRefreshJsonInPage.toString();
    expect(original).toContain(before);
    await expect(probe(original.replace(before, after), kind)).rejects.toThrow();
  });
});

describe("support-safe refusal and stopped diagnostics", () => {
  async function errorOracle(run, stage, name) {
    const error = new Error("page.waitForURL: Timeout 30000ms exceeded.\nCall log:\n  synthetic-secret-bearing text");
    error.name = name;
    const input = runnerInput();
    if (stage === "sign-in")
      input.signIn = async () => {
        throw error;
      };
    else
      input.read = async () => {
        throw error;
      };
    const receipt = await run(input);
    expect(receipt).toMatchObject({ outcome: "refused", reason: `runner-error:${name}`, requests: { forced: 0 } });
    expect(validateScrydexOptionRefreshReceipt(receipt)).toEqual([]);
    const workspace = await temporaryWorkspace();
    expect((await writeRefreshArtifact(receipt, {}, workspace)).path).toBe(
      join(workspace, scrydexOptionRefreshDiagnosticArtifactPath),
    );
  }
  it.each(
    ["TimeoutError", "ReferenceError", "TypeError"].flatMap((name) =>
      ["sign-in", "overview"].map((stage) => [stage, name]),
    ),
  )("writes a valid diagnostic for %s %s", async (stage, name) => errorOracle(runScrydexOptionRefresh, stage, name));

  it("rejects the raw-message mutant with the unchanged oracle", async () => {
    const original = await functionSource("runScrydexOptionRefresh");
    expect(original).toContain("runner-error:");
    const globals = {
      ...refreshDomain,
      scrydexCacheCaptureUnits,
      selectRefreshRequests: refresh.selectRefreshRequests,
      refused: (reason) => new Error(`scrydex-option-refresh-refused:${reason}`),
      Error,
    };
    await errorOracle(runInNewContext(`(${original})`, globals), "overview", "TimeoutError");
    const run = runInNewContext(`(${original.replace(/`runner-error:\$\{[^`]+\}`/, "error.message")})`, globals);
    await expect(errorOracle(run, "overview", "TimeoutError")).rejects.toThrow();
  });

  it("retains first success and marks the second interrupted forced unit uncertain with null evidence", async () => {
    const input = runnerInput();
    const read = input.read;
    let forced = 0;
    input.read = async (path) => {
      if (path.includes("forceRefresh=true") && ++forced === 2)
        return {
          get status() {
            throw new ReferenceError("synthetic private page details\nnot a reason");
          },
        };
      return read(path);
    };
    const receipt = await runScrydexOptionRefresh(input);
    expect(receipt).toMatchObject({
      outcome: "stopped",
      reason: "runner-error:ReferenceError",
      requests: { forced: 2 },
      creditsSpentUpperBound: 3,
    });
    expect(receipt.units[0].status).toBe("live");
    expect(receipt.units[1]).toMatchObject({
      status: "uncertain",
      httpStatus: null,
      cache: null,
      total: null,
      providerPagesUpperBound: null,
      completedAt: null,
    });
    expect(validateScrydexOptionRefreshReceipt(receipt)).toEqual([]);
    const workspace = await temporaryWorkspace();
    expect((await writeRefreshArtifact(receipt, {}, workspace)).path).toBe(
      join(workspace, scrydexOptionRefreshDiagnosticArtifactPath),
    );
  });
});

describe("independent artifact guards", () => {
  const secret = "synthetic-secret-not-for-output-11200";
  const refusalPrefix = "scrydex-option-refresh-refused:receipt-invalid:";

  class ArtifactGuardBypass extends Error {
    constructor(kind) {
      super(`artifact-guard-bypass:${kind}`);
      this.kind = kind;
    }
  }

  async function guardInput(kind) {
    const receipt = await fourAttemptReceipt();
    if (kind === "schema") receipt.reason = "invalid reason\nprivate";
    if (kind === "credential") receipt.assumptions.push(secret);
    const serialized = JSON.stringify(receipt);
    expect(validateScrydexOptionRefreshReceipt(JSON.parse(serialized)).length > 0).toBe(kind === "schema");
    expect(Buffer.byteLength(serialized)).toBeLessThanOrEqual(scrydexOptionRefreshMaxBytes);
    expect(Buffer.byteLength(serialized)).toBeGreaterThan(1);
    expect(serialized.includes(secret)).toBe(kind === "credential");
    return Object.freeze({
      serialized,
      env: Object.freeze({ GH_TOKEN: kind === "credential" ? secret : "" }),
      options: Object.freeze(kind === "size" ? { maxBytes: 1 } : {}),
    });
  }

  function assertRefusal(message, kind) {
    expect(message.startsWith(refusalPrefix)).toBe(true);
    expect(message.length).toBeLessThan(2500);
    expect(message).not.toContain(secret);
    const diagnostic = JSON.parse(message.slice(refusalPrefix.length));
    expect(diagnostic).toEqual({
      class: kind,
      errors: expect.any(Array),
      requests: { forced: 4 },
      creditsSpentUpperBound: 7,
    });
    expect(diagnostic.errors.length).toBeLessThanOrEqual(20);
    expect(diagnostic.errors.length > 0).toBe(kind === "schema");
  }

  async function assertAbsent(path, read = readFile) {
    try {
      await read(path);
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    expect.fail(`unexpected artifact: ${path}`);
  }

  async function rejectionOracle(
    kind,
    input,
    { loadWriter = async () => writeRefreshArtifact, createWorkspace = temporaryWorkspace, read = readFile } = {},
  ) {
    const workspace = await createWorkspace();
    const writer = await loadWriter();
    let refusal;
    try {
      await writer(JSON.parse(input.serialized), input.env, workspace, input.options);
    } catch (error) {
      if (!error.message?.startsWith(refusalPrefix)) throw error;
      refusal = error;
    }
    if (!refusal) throw new ArtifactGuardBypass(kind);
    assertRefusal(refusal.message, kind);
    await assertAbsent(join(workspace, scrydexOptionRefreshDiagnosticArtifactPath), read);
    await assertAbsent(join(workspace, scrydexOptionRefreshArtifactPath), read);
  }

  async function guardBypassVerdict(kind, oracle) {
    try {
      await oracle();
    } catch (error) {
      if (!(error instanceof ArtifactGuardBypass)) throw error;
      expect(error.kind).toBe(kind);
      expect(error.message).toBe(`artifact-guard-bypass:${kind}`);
      return;
    }
    expect.fail(`missing semantic guard bypass: ${kind}`);
  }

  async function bypassWriter(before, after) {
    const original = await functionSource("writeRefreshArtifact");
    expect(original).toContain(before);
    return runInNewContext(`(${original.replace(before, after)})`, {
      ...refreshDomain,
      Buffer,
      JSON,
      Error,
      dirname,
      resolve,
      mkdir,
      readdir,
      writeFile,
      forbiddenNames: ["CATALOG_ADMIN_E2E_EMAIL", "CATALOG_ADMIN_E2E_PASSWORD", "GH_TOKEN"],
      refused: (reason) => new Error(`scrydex-option-refresh-refused:${reason}`),
      sha256: (value) => createHash("sha256").update(value).digest("hex"),
    });
  }

  it("unrelated setup import and I/O failures are not guard bypass kills", async () => {
    for (const kind of ["schema", "size", "credential"]) {
      const input = await guardInput(kind);
      for (const stage of ["setup", "launch/import", "writer I/O"]) {
        const sentinel = new Error(`unrelated ${stage} sentinel`);
        const fail = async () => {
          throw sentinel;
        };
        const controls = {
          setup: { createWorkspace: fail },
          "launch/import": { loadWriter: fail },
          "writer I/O": { loadWriter: async () => fail },
        };
        await expect(guardBypassVerdict(kind, () => rejectionOracle(kind, input, controls[stage]))).rejects.toBe(
          sentinel,
        );
      }
      for (const relativePath of [scrydexOptionRefreshDiagnosticArtifactPath, scrydexOptionRefreshArtifactPath]) {
        const sentinel = Object.assign(new Error("unrelated artifact permission sentinel"), { code: "EACCES" });
        let attempted = false;
        await expect(
          guardBypassVerdict(kind, () =>
            rejectionOracle(kind, input, {
              read: async (path) => {
                if (path.endsWith(join(relativePath))) {
                  attempted = true;
                  throw sentinel;
                }
                return readFile(path);
              },
            }),
          ),
        ).rejects.toBe(sentinel);
        expect(attempted).toBe(true);
      }
      await expect(
        guardBypassVerdict(kind, () =>
          rejectionOracle(kind, input, {
            loadWriter: async () => async () => {
              throw new Error(`${refusalPrefix}{`);
            },
          }),
        ),
      ).rejects.toBeInstanceOf(SyntaxError);
      const impostor = new Error(`artifact-guard-bypass:${kind}`);
      await expect(
        guardBypassVerdict(kind, async () => {
          throw impostor;
        }),
      ).rejects.toBe(impostor);
    }
  });

  it.each(["schema", "size", "credential"])("refuses only the %s guard with bounded counts and no file", async (kind) =>
    rejectionOracle(kind, await guardInput(kind)),
  );
  it.each([
    ["schema", "errors.length > 0", "false"],
    ["size", "Buffer.byteLength(serialized) > maxBytes", "false"],
    ["credential", "forbiddenNames.some((name) => env[name] && serialized.includes(env[name]))", "false"],
  ])("rejects the %s bypass mutant with its unchanged oracle", async (kind, before, after) => {
    const input = await guardInput(kind);
    await rejectionOracle(kind, input);
    let completed = false;
    await guardBypassVerdict(kind, () =>
      rejectionOracle(kind, input, {
        loadWriter: async () => {
          const writer = await bypassWriter(before, after);
          return async (...args) => {
            const result = await writer(...args);
            completed = true;
            return result;
          };
        },
      }),
    );
    expect(completed).toBe(true);
  });

  it("retains isolated writer import serialization and refusal output", async () => {
    const workspace = await temporaryWorkspace();
    const inputs = await Promise.all(
      ["schema", "size", "credential"].map(async (kind) => ({
        kind,
        ...(await guardInput(kind)),
        workspace: join(workspace, kind),
      })),
    );
    await writeFile(join(workspace, "input.json"), JSON.stringify(inputs));
    const script = join(workspace, "write.mjs");
    await writeFile(
      script,
      `import {readFile} from ${JSON.stringify("node:fs/promises")};
import {writeRefreshArtifact} from ${JSON.stringify(runnerUrl.href)};
const inputs = JSON.parse(await readFile(new URL('./input.json', import.meta.url)));
for (const input of inputs) {
  try { await writeRefreshArtifact(JSON.parse(input.serialized), input.env, input.workspace, input.options); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}`,
    );
    const result = await tsx([script], process.cwd(), runnerEnv(workspace));
    expect(result.code, result.stderr.slice(0, 2000)).toBe(1);
    expect(result.stdout).toBe("");
    const lines = result.stderr
      .trim()
      .split(/\r?\n/)
      .filter((line) => !line.includes("NO_COLOR") && !line.includes("trace-warnings"));
    expect(lines, result.stderr.slice(0, 2000)).toHaveLength(inputs.length);
    for (const [index, input] of inputs.entries()) {
      assertRefusal(lines[index], input.kind);
      await assertAbsent(join(input.workspace, scrydexOptionRefreshDiagnosticArtifactPath));
      await assertAbsent(join(input.workspace, scrydexOptionRefreshArtifactPath));
    }
  });
});

describe("spawned tsx upload validator", () => {
  async function validateOracle(kind, mutation) {
    const workspace = await temporaryWorkspace();
    const receipt = kind === "diagnostic" ? await stoppedReceipt() : await completeReceipt();
    const complete = join(workspace, scrydexOptionRefreshArtifactPath);
    const diagnostic = join(workspace, scrydexOptionRefreshDiagnosticArtifactPath);
    if (kind === "nested") receipt.units[0].cache.unknown = true;
    if (kind === "wrong-shape") receipt.requests = [];
    if (kind === "runner-sha") receipt.runner.sha = "c".repeat(40);
    if (kind === "runner-run") receipt.runner.runId = "2";
    if (kind === "runner-attempt") receipt.runner.runAttempt = "2";
    const path = kind === "diagnostic" ? diagnostic : complete;
    if (kind !== "neither") {
      await mkdir(join(path, ".."), { recursive: true });
      await writeFile(
        path,
        kind === "malformed"
          ? "{"
          : kind === "over-cap"
            ? " ".repeat(scrydexOptionRefreshMaxBytes + 1)
            : JSON.stringify(receipt),
      );
    }
    if (kind === "both") {
      await mkdir(join(diagnostic, ".."), { recursive: true });
      await writeFile(diagnostic, JSON.stringify(await stoppedReceipt()));
    }
    const module = mutation ? await mutantModule(workspace, ...mutation) : fileURLToPath(runnerUrl);
    const result = await tsx([module, "validate"], workspace, runnerEnv(workspace));
    if (["complete", "diagnostic"].includes(kind)) {
      expect(result.code, (result.stdout + result.stderr).slice(0, 2000)).toBe(0);
      expect(await readFile(join(workspace, "output"), "utf8")).toBe(`refresh_outcome=${receipt.outcome}\n`);
    } else {
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("scrydex-option-refresh-refused:");
      await expect(readFile(join(workspace, "output"))).rejects.toThrow();
    }
  }
  it.each([
    "complete",
    "diagnostic",
    "neither",
    "both",
    "malformed",
    "over-cap",
    "wrong-shape",
    "nested",
    "runner-sha",
    "runner-run",
    "runner-attempt",
  ])("validates isolated %s input", (kind) => validateOracle(kind));
  it.each([
    ["no-op-stub", "complete", "await validateRefreshUpload();", "process.exitCode = 0;"],
    ["both-paths-accepted", "both", "candidates.length !== 1", "candidates.length === 0"],
    ["runner-binding-bypass", "runner-run", "JSON.stringify(receipt.runner) !== JSON.stringify(identity)", "false"],
  ])("rejects the %s mutant with the unchanged oracle", async (_, kind, before, after) => {
    expect(await source()).toContain(before);
    await expect(validateOracle(kind, [before, after])).rejects.toThrow();
  });
});

describe("isolated sign-in and workflow wiring", () => {
  async function signInOracle(signIn, offered = true) {
    const calls = [];
    const page = {
      goto: async (url) => {
        calls.push(["goto", url]);
      },
      getByRole: (role, { name }) => ({
        fill: async () => {
          calls.push(["fill", role]);
        },
        click: async () => {
          calls.push(["click", String(name)]);
        },
        isVisible: async () => {
          calls.push(["radio-visible"]);
          return offered;
        },
        check: async () => {
          calls.push(["radio-check", role, String(name)]);
        },
      }),
      locator: () => ({
        first: () => ({
          fill: async () => {
            calls.push(["password"]);
          },
        }),
      }),
      waitForURL: async (url) => {
        calls.push(["wait", url]);
      },
    };
    await signIn(page, { CATALOG_ADMIN_E2E_EMAIL: "synthetic", CATALOG_ADMIN_E2E_PASSWORD: "synthetic" }, () =>
      calls.push(["refresh"]),
    );
    expect(new URL(calls[0][1]).searchParams.get("returnTo")).toBe("/catalog/scopes/sync-batches");
    if (offered) expect(calls.findIndex(([call]) => call === "radio-check")).toBeGreaterThan(-1);
    if (offered)
      expect(calls.find(([call]) => call === "radio-check")).toEqual(["radio-check", "radio", "/^Password$/"]);
    expect(calls.findIndex(([call]) => call === "radio-visible")).toBeLessThan(
      calls.findIndex(([call]) => call === "password"),
    );
    expect(calls.filter(([call]) => call === "refresh")).toHaveLength(1);
    expect(calls.slice(-2)).toEqual([
      ["wait", "https://admin.staging.chasesets.com/catalog/scopes/sync-batches"],
      ["refresh"],
    ]);
  }
  it.each([true, false])("selects Password when offered (%s), then waits before refresh", async (offered) => {
    expect(refresh.signInForRefresh).toBeTypeOf("function");
    await signInOracle(refresh.signInForRefresh, offered);
  });
  it.each([
    ["phase-before-waitForURL", "await page.waitForURL", "enterRefresh(); await page.waitForURL"],
    ["skipped-radio", "await passwordChoice.check()", "undefined"],
    ["integrations-landing", "scrydexCacheCaptureLandingPath", '"/catalog/integrations"'],
  ])("rejects the %s mutant with the unchanged oracle", async (_, before, after) => {
    const original = await functionSource("signInForRefresh");
    expect(original).toContain(before);
    const globals = {
      scrydexOptionRefreshOrigin: "https://admin.staging.chasesets.com",
      scrydexCacheCaptureLandingPath: "/catalog/scopes/sync-batches",
    };
    await signInOracle(runInNewContext(`(${original})`, globals));
    const signIn = runInNewContext(`(${original.replaceAll(before, after)})`, globals);
    await expect(signInOracle(signIn)).rejects.toThrow();
  });
  it("unconditionally pins the actual reader, phase transition, validator command and step-4 authority anchor", async () => {
    const runnerSource = await source();
    expect(runnerSource).toContain("page.evaluate(readRefreshJsonInPage, {");
    expect(runnerSource).toContain("await signInForRefresh(page, env, () => {");
    const workflowSource = await readFile(
      new URL("../.github/workflows/catalog-staging-provider-uat.yml", import.meta.url),
      "utf8",
    );
    const workflow = parseYaml(workflowSource);
    const steps = workflow.jobs["scrydex-force-refresh-bounded"].steps;
    expect(steps[3].id).toBe("refresh");
    expect(steps.find((step) => step.id === "refresh-receipt").run.trim()).toBe(
      "pnpm exec tsx scripts/catalog-staging-scrydex-option-refresh.mjs validate",
    );
    for (const job of Object.values(workflow.jobs))
      for (const step of job.steps ?? []) expect(step.run ?? "").not.toMatch(/\bnode\b[^\n]*import[^\n]*\.ts['"]/);
  });
});

describe("hosted Scrydex option refresh contract", () => {
  it("fences refresh routes to the two preflights and five forced reads", () => {
    const overview =
      "https://admin.staging.chasesets.com/api/catalog/source-observations/integration-control-plane/overview?audience=daily";
    const profiles = "https://admin.staging.chasesets.com/api/catalog/source-observations/provider-profiles";
    const forced = scrydexCacheCaptureUnits.map(
      ({ unitKey }, index) =>
        `https://admin.staging.chasesets.com/api/catalog/source-observations/integration-options?providerKey=scrydex&profileKey=p${index}&profileVersion=v&ingestionUnitKey=${encodeURIComponent(unitKey)}&queryKind=sets&limit=100&forceRefresh=true`,
    );
    const requests = [
      { method: "GET", url: overview },
      { method: "GET", url: profiles },
      ...forced.map((url) => ({ method: "GET", url })),
    ];
    const routeOutcomes = requests.map((request) => {
      const calls = [];
      applyScrydexOptionRefreshRouteFence(
        {
          request: () => ({ method: () => request.method, url: () => request.url }),
          abort: (reason) => calls.push(["abort", reason]),
          continue: () => calls.push(["continue"]),
        },
        "refresh",
      );
      return calls[0][0];
    });
    expect(routeOutcomes).toEqual(["continue", "continue", "continue", "continue", "continue", "continue", "continue"]);
    const rejected = [];
    applyScrydexOptionRefreshRouteFence(
      {
        request: () => ({
          method: () => "POST",
          url: () => "https://admin.staging.chasesets.com/api/catalog/source-observations/provider-transport",
        }),
        abort: (reason) => rejected.push(["abort", reason]),
        continue: () => rejected.push(["continue"]),
      },
      "refresh",
    );
    expect(rejected).toEqual([["abort", "blockedbyclient"]]);
  });

  it("uses the bounded page arithmetic", () => {
    expect([0, 100, 101].map(providerPagesUpperBound)).toEqual([2, 2, 3]);
    expect(providerPagesUpperBound(1001)).toBeNull();
  });

  it("refuses usage until the provider is fresh, ready and funded", () => {
    expect(
      evaluateScrydexUsagePreflight({
        providerKey: "scrydex",
        usageBudget: { readiness: "ready", freshness: "stale", creditBalance: 5000, creditAllowance: 5000 },
      }),
    ).toMatchObject({ admitted: false, reason: "usage-stale:stale" });
    expect(
      evaluateScrydexUsagePreflight({
        providerKey: "scrydex",
        usageBudget: { readiness: "ready", freshness: "fresh", creditBalance: 5000, creditAllowance: 5000 },
      }),
    ).toMatchObject({ admitted: true });
  });

  it("fences cursor, cache-only and non-Scrydex requests", () => {
    const href =
      "https://admin.staging.chasesets.com/api/catalog/source-observations/integration-options?providerKey=scrydex&profileKey=p&profileVersion=v&ingestionUnitKey=scrydex:one-piece:set:reference-data&queryKind=sets&limit=100&forceRefresh=true";
    expect(classifyScrydexOptionRefreshRequest({ method: "GET", url: href }).allowed).toBe(true);
    expect(classifyScrydexOptionRefreshRequest({ method: "GET", url: `${href}&cursor=offset:1` }).allowed).toBe(false);
    expect(
      classifyScrydexOptionRefreshRequest({
        method: "GET",
        url: href.replace("providerKey=scrydex", "providerKey=tcgdex"),
      }).allowed,
    ).toBe(false);
  });
});
