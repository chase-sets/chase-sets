import { createHash, X509Certificate } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, get, type IncomingMessage, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import type { LookupFunction } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { BrowserContext, Page, Response as BrowserResponse } from "@playwright/test";
import { linkIntentOrigins } from "@chase-sets/platform-runtime/link-intents";
import { TCGPLAYER_CONNECTOR_REDIRECT_URI } from "@chase-sets/channels";
import {
  cleanDrillProfile,
  correlateFakePopupDocument,
  createDeployedPopupObserver,
  deployedBrowserArgs,
  deployedInputRefusal,
  deployedPausedClaimsValid,
  deployedUnpairedClaimObserved,
  digestConnectorDist,
  drillBrowserEnvironment,
  installDeployedResponses,
  openRawCdpTransport,
  PairingDrillRefusal,
  providerEnvironmentPattern,
  retainDeployedReceipt,
  runPairingDrill,
  type DeployedPairingDrillReceipt,
  type DeployedClaimResponseRow,
  type DeployedClaimRow,
  type DeployedPageRow,
  type DrillLaunchOptions,
  type FakeDocumentResponse,
  type FakePopupBoundary,
  type FakePopupMainDocument,
  type PairingDrillDeployBinding,
  type PairingDrillRefusalCode,
} from "../e2e/pairing-drill";
import {
  parseStagingDrillArgs,
  runStagingDrill,
  stagingPreflightRows,
  stagingReceiptComment,
  type DeployBindingResult,
  type StagingDrillPorts,
} from "../e2e/pairing-drill-staging";
import {
  createFakeDocumentRecorder,
  drillTestCertificate,
  stagingFakePlatform,
  stagingSynthetic,
  synthetic,
} from "../e2e/loopback-platform";

const staging = linkIntentOrigins["marketplace-web"].staging;
const production = linkIntentOrigins["marketplace-web"].production;
const stagingHost = new URL(staging).host;

describe("installed deployed response subscription", () => {
  const id = "subscription-connection";
  const path = `/channel-connector/oauth/connections/${id}/claim`;
  const storedPath = "/channel-connector/oauth/connections/<connectionId>/claim";
  function response(
    options: {
      worker?: boolean;
      url?: string;
      method?: string;
      type?: string;
      status?: number;
      json?: () => Promise<unknown>;
    } = {},
  ) {
    const frame = vi.fn(() => {
      throw new Error("worker-has-no-frame");
    });
    const value = {
      request: () => ({
        serviceWorker: () => (options.worker === false ? null : {}),
        url: () => options.url ?? `${staging}${path}`,
        method: () => options.method ?? "POST",
        resourceType: () => options.type ?? "fetch",
        frame,
      }),
      headers: () => ({ "content-type": "text/html" }),
      status: () => options.status ?? 200,
      json: options.json ?? (async () => ({ reservation: null })),
    } as unknown as BrowserResponse;
    return { value, frame };
  }
  function installed() {
    const page = new EventEmitter();
    const context = Object.assign(new EventEmitter(), { pages: () => [page as unknown as Page] });
    const pages: DeployedPageRow[] = [];
    const claims: DeployedClaimRow[] = [];
    const responses: DeployedClaimResponseRow[] = [];
    let phase: DeployedClaimRow["phase"] = "paused";
    const close = installDeployedResponses(context as unknown as BrowserContext, {
      platformOrigin: staging,
      connectionId: () => id,
      phase: () => phase,
      pages,
      claims,
      responses,
    });
    const emit = async (value: BrowserResponse, onPage = false) => {
      context.emit("response", value);
      if (onPage) page.emit("response", value);
      await Promise.resolve();
    };
    return {
      page,
      context,
      pages,
      claims,
      responses,
      close,
      emit,
      unpair: () => {
        phase = "unpaired";
      },
    };
  }
  it("retains two distinct context-only worker claims without reading a frame", async () => {
    const run = installed();
    try {
      const first = response();
      const second = response();
      await run.emit(first.value);
      await run.emit(second.value);
      expect(run.claims).toEqual(
        [0, 1].map(() => ({
          phase: "paused",
          path: storedPath,
          status: 200,
          reservation: null,
          bodyCode: null,
        })),
      );
      expect(deployedPausedClaimsValid(run.claims, storedPath)).toBe(true);
      expect(first.frame).not.toHaveBeenCalled();
      expect(second.frame).not.toHaveBeenCalled();
    } finally {
      run.close();
    }
  });
  it("keeps context and Page document delivery disjoint and each worker response single", async () => {
    const run = installed();
    try {
      await run.emit(
        response({ worker: false, type: "document", method: "GET", url: `${staging}/account/channels/${id}` }).value,
        true,
      );
      await run.emit(response().value, true);
      expect(run.pages).toHaveLength(1);
      expect(run.pages[0]).toMatchObject({ method: "GET", path: "/account/channels/<connectionId>", status: 200 });
      expect(run.claims).toHaveLength(1);
    } finally {
      run.close();
    }
  });
  it.each([
    ["page fetch", { worker: false }],
    ["other origin", { url: `https://other.invalid${path}` }],
    ["other path", { url: `${staging}${path}/extra` }],
    ["other connection", { url: `${staging}/channel-connector/oauth/connections/other/claim` }],
    ["other method", { method: "GET" }],
  ])("rejects %s as stored worker claim authority", async (_name, options) => {
    const run = installed();
    try {
      await run.emit(response(options).value, true);
      expect(run.claims).toEqual([]);
      expect(deployedPausedClaimsValid(run.claims, storedPath)).toBe(false);
    } finally {
      run.close();
    }
  });
  it.each([
    ["reservation present", async (): Promise<unknown> => ({ reservation: {} }), "present"],
    ["reservation missing", async () => ({}), "unreadable"],
    ["malformed body", async (): Promise<unknown> => null, "unreadable"],
    ["array body", async () => [], "unreadable"],
    [
      "unreadable JSON",
      async () => {
        throw new SyntaxError("invalid-json");
      },
      "unreadable",
    ],
  ] as const)("refuses two paused claims with %s", async (_name, json, reservation) => {
    const run = installed();
    try {
      await run.emit(response({ json }).value);
      await run.emit(response({ json }).value);
      expect(run.claims).toHaveLength(2);
      expect(run.claims.filter((claim) => claim.phase === "paused").map((claim) => claim.reservation)).toEqual([
        reservation,
        reservation,
      ]);
      expect(deployedPausedClaimsValid(run.claims, storedPath)).toBe(false);
    } finally {
      run.close();
    }
  });
  it("refuses a single otherwise-valid paused row", async () => {
    const run = installed();
    try {
      await run.emit(response().value);
      expect(run.claims).toHaveLength(1);
      expect(deployedPausedClaimsValid(run.claims, storedPath)).toBe(false);
    } finally {
      run.close();
    }
  });
  it("refuses two null-reservation paused rows with the wrong status", async () => {
    const run = installed();
    try {
      await run.emit(response({ status: 201 }).value);
      await run.emit(response({ status: 201 }).value);
      expect(run.claims).toHaveLength(2);
      expect(deployedPausedClaimsValid(run.claims, storedPath)).toBe(false);
    } finally {
      run.close();
    }
  });
  it("refuses two otherwise-valid paused rows for a different stored path", async () => {
    const run = installed();
    try {
      await run.emit(response().value);
      await run.emit(response().value);
      expect(deployedPausedClaimsValid(run.claims, `${storedPath}/other`)).toBe(false);
    } finally {
      run.close();
    }
  });
  it("captures phase before delayed JSON and retains the observer through the post-Unpair claim", async () => {
    const run = installed();
    let finish!: (body: unknown) => void;
    const body = new Promise<unknown>((resolve) => {
      finish = resolve;
    });
    try {
      await run.emit(response({ status: 401, json: () => body }).value);
      const boundary = run.responses.length;
      run.unpair();
      finish({ error: "invalid-credential" });
      await body;
      await Promise.resolve();
      expect(run.claims).toEqual([
        { phase: "paused", path: storedPath, status: 401, reservation: "unreadable", bodyCode: "invalid-credential" },
      ]);
      expect(deployedUnpairedClaimObserved(run.responses, boundary)).toBe(false);
      await run.emit(response({ status: 401, json: async () => ({ error: "invalid-credential" }) }).value);
      expect(run.context.listenerCount("response")).toBe(1);
      expect(deployedUnpairedClaimObserved(run.responses, boundary)).toBe(true);
      expect(run.claims).toContainEqual({
        phase: "unpaired",
        path: storedPath,
        status: 401,
      });
    } finally {
      run.close();
    }
  });
  it("requires an actual post-boundary 401, not an earlier 401 or a later 200", async () => {
    const run = installed();
    try {
      const boundary = run.responses.length;
      await run.emit(response({ status: 401 }).value);
      run.unpair();
      await run.emit(response().value);
      expect(deployedUnpairedClaimObserved(run.responses, boundary)).toBe(false);
      await run.emit(response({ status: 401 }).value);
      expect(deployedUnpairedClaimObserved(run.responses, boundary)).toBe(true);
    } finally {
      run.close();
    }
  });
  it("applies the phase and response boundary to the status authority", () => {
    expect(deployedUnpairedClaimObserved([{ phase: "paused", status: 401, body: "settled" }], 0)).toBe(false);
    const rows = [
      { phase: "unpaired", status: 401, body: "pending" },
      { phase: "unpaired", status: 401, body: "pending" },
    ] as const;
    expect(deployedUnpairedClaimObserved(rows, 1)).toBe(true);
    expect(deployedUnpairedClaimObserved(rows, 2)).toBe(false);
  });
  it("removes owned listeners and discards in-flight JSON on cleanup without retaining a second run", async () => {
    const first = installed();
    let finish!: (body: unknown) => void;
    const body = new Promise<unknown>((resolve) => {
      finish = resolve;
    });
    await first.emit(response({ json: () => body }).value);
    first.close();
    finish({ reservation: null });
    await body;
    await Promise.resolve();
    expect(first.context.listenerCount("response")).toBe(0);
    expect(first.context.listenerCount("page")).toBe(0);
    expect(first.page.listenerCount("response")).toBe(0);
    await first.emit(response().value, true);
    expect(first.claims).toEqual([]);
    const second = installed();
    try {
      await second.emit(response().value);
      expect(second.claims).toHaveLength(1);
      expect(first.claims).toEqual([]);
    } finally {
      second.close();
    }
  });
  it("keeps each stored claim response's body state, pending until it settles and frozen at cleanup", async () => {
    const run = installed();
    let finish!: (body: unknown) => void;
    const held = new Promise<unknown>((resolve) => {
      finish = resolve;
    });
    let finishLate!: (body: unknown) => void;
    const late = new Promise<unknown>((resolve) => {
      finishLate = resolve;
    });
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
    try {
      await run.emit(response({ status: 401, json: () => held }).value);
      await run.emit(
        response({
          json: async () => {
            throw new SyntaxError("invalid-json");
          },
        }).value,
      );
      await run.emit(response({ method: "GET" }).value);
      await settle();
      expect(run.responses).toEqual([
        { phase: "paused", status: 401, body: "pending" },
        { phase: "paused", status: 200, body: "unreadable" },
      ]);
      finish({ error: "invalid-credential" });
      await settle();
      expect(run.responses[0]).toEqual({ phase: "paused", status: 401, body: "settled" });
      run.unpair();
      await run.emit(response({ status: 401, json: () => late }).value);
    } finally {
      run.close();
    }
    finishLate({ error: "invalid-credential" });
    await settle();
    expect(run.responses.at(-1)).toEqual({ phase: "unpaired", status: 401, body: "pending" });
    expect(run.claims.map(({ phase, status }) => [phase, status])).toEqual([
      ["paused", 200],
      ["paused", 401],
      ["unpaired", 401],
    ]);
  });

  /** When the post-Unpair claim reaches the installed listener, relative to the product's visible revocation. */
  type PostUnpairDelivery =
    | "settled-then-revoked"
    | "revoked-after-first-read"
    | "event-after-revoked"
    | "body-after-revoked"
    | "missing"
    | "post-boundary-200"
    | "pre-boundary-late-401"
    | "body-unresolved";
  /** Deliveries that never satisfy the post-Unpair gate, so the run reaches the leg's deadline. */
  const pendingEvidence: readonly PostUnpairDelivery[] = [
    "missing",
    "post-boundary-200",
    "pre-boundary-late-401",
    "body-unresolved",
  ];
  const invalidCredential = async (): Promise<unknown> => ({ error: "invalid-credential" });
  /** Real driver over synthetic browser APIs: installed listeners, consumption and lifetime, not browser proof. */
  async function syntheticDrill(
    options: Readonly<{
      pausedReservation?: boolean;
      postUnpair?: PostUnpairDelivery;
      onUnpairedFire?: () => void;
    }> = {},
  ) {
    const postUnpair = options.postUnpair ?? "settled-then-revoked";
    const fake = await stagingFakePlatform();
    const outputDir = mkdtempSync(join(tmpdir(), "connector-drill-subscription-"));
    const marker = "8c3aee36-8c7d-4cf3-8802-57cb8f195144";
    let title = "unpaired";
    let unpaired = false;
    let sequence = 0;
    let actions = 0;
    const postJoinListeners: number[] = [];
    let route!: (route: unknown) => Promise<void>;
    const changes: ((change: unknown, area: string) => void)[] = [];
    const change = (state: string) => {
      title = state;
      for (const listener of changes) listener({ "channel-connector-profile": { newValue: { state } } }, "local");
    };
    const revoke = () => {
      change("cleanup-pending");
      change("revoked");
    };
    const emit = (status: number, json: () => Promise<unknown>) =>
      context.emit("response", response({ status, json }).value);
    // A held body settles only when the run, or a later test step, releases it.
    let release: () => void = () => undefined;
    const held = () =>
      new Promise<unknown>((resolve) => {
        release = () => resolve({ error: "invalid-credential" });
      });
    // Lands after the driver's next profile read returns, as a late browser event or product write would.
    let afterNextRead: (() => void) | undefined;
    let ticker: ReturnType<typeof setInterval> | undefined;
    const deliveries: Record<PostUnpairDelivery, () => void> = {
      "settled-then-revoked": () => {
        emit(401, invalidCredential);
        revoke();
      },
      "revoked-after-first-read": () => {
        emit(401, invalidCredential);
        afterNextRead = revoke;
      },
      "event-after-revoked": () => {
        revoke();
        afterNextRead = () => emit(401, invalidCredential);
      },
      "body-after-revoked": () => {
        emit(401, held);
        revoke();
        afterNextRead = () => release();
      },
      missing: revoke,
      "post-boundary-200": () => {
        emit(200, async () => ({ reservation: null }));
        revoke();
      },
      "pre-boundary-late-401": () => {
        release();
        revoke();
      },
      "body-unresolved": () => {
        emit(401, held);
        revoke();
      },
    };
    const chrome = {
      action: { getTitle: async () => title, getBadgeText: async () => (title === "paired-idle" ? "ON" : "!") },
      storage: {
        onChanged: { addListener: (listener: (typeof changes)[number]) => changes.push(listener) },
        local: {
          get: async () => {
            if (afterNextRead) setTimeout(afterNextRead, 0);
            afterNextRead = undefined;
            return { "channel-connector-profile": { state: title } };
          },
        },
      },
      alarms: {
        create: () => {
          if (!unpaired) {
            emit(200, async () => ({ reservation: options.pausedReservation ? {} : null }));
            return;
          }
          options.onUnpairedFire?.();
          if (pendingEvidence.includes(postUnpair)) {
            // Only Date is faked, the package's established timer seam: the 10 s leg ends without a 10 s sleep.
            vi.useFakeTimers({ toFake: ["Date"] });
            ticker = setInterval(() => vi.setSystemTime(Date.now() + 1_000), 10);
          }
          deliveries[postUnpair]();
        },
      },
    };
    const worker = {
      url: () => "chrome-extension://synthetic/background.js",
      evaluate: async (fn: (arg: unknown) => unknown, arg: unknown) => {
        if (arg === "https://connector-drill.invalid/canary") {
          await route({
            request: () => ({ url: () => arg, serviceWorker: () => worker }),
            abort: async () => undefined,
          });
          return;
        }
        return fn(arg);
      },
    };
    let currentUrl = `${staging}/account/channels`;
    const page = Object.assign(new EventEmitter(), {
      url: () => currentUrl,
      goto: async (url: string) => {
        currentUrl = url;
        return { status: () => 200 };
      },
      bringToFront: async () => undefined,
      locator: (selector: string) => ({
        click: async () => {
          if (!selector.includes("connector-unpair")) return;
          unpaired = true;
          // A claim in flight at Unpair: its 401 is paused-phase evidence however late its body lands.
          if (postUnpair === "pre-boundary-late-401") emit(401, held);
        },
      }),
      evaluate: async (_fn: unknown, request: { method: string; path: string }) => {
        if (actions === 2 && request.path.endsWith("/connector-pairing")) {
          const active = context.listenerCount("response");
          postJoinListeners.push(active);
          if (!active) throw new Error("synthetic-producer-detached-after-marker-join");
        }
        let body: unknown = {};
        if (request.path === "/api/channels/connections")
          body = request.method === "GET" ? { items: [] } : { connectionId: id, status: "pending-setup" };
        else if (request.path === "/api/inventory/storage-locations")
          body = { items: [{ is_archived: false, storage_location_id: "location" }] };
        else if (request.path.endsWith("/activate")) body = { status: "active" };
        else if (request.path.endsWith("/pause")) body = { status: "paused" };
        else if (request.path.endsWith("/disconnect")) body = { status: "disconnected" };
        else
          body = {
            state: unpaired ? "unpaired" : actions ? "paired" : currentUrl.endsWith(id) ? "code" : "unpaired",
            pairingId: "synthetic-pairing",
          };
        return { status: 200, contentType: "application/json", body };
      },
    });
    const frame = {
      evaluate: async () => ({ url: `${staging}/account/channels/${id}`, top: true, markers: [marker] }),
      parentFrame: () => null,
      page: () => popup,
    };
    const popup = Object.assign(new EventEmitter(), {
      url: () => `${staging}/account/channels/${id}`,
      context: () => context,
      mainFrame: () => frame,
      waitForLoadState: async () => undefined,
    });
    const context = Object.assign(new EventEmitter(), {
      pages: () => (actions > 1 ? [page, popup] : [page]),
      serviceWorkers: () => [worker],
      route: async (_pattern: string, listener: typeof route) => {
        route = listener;
      },
      cookies: async () => [],
      tracing: { start: async () => undefined, stop: async () => undefined },
      close: async () => undefined,
      waitForEvent: (event: string) => new Promise((resolve) => context.once(event, resolve)),
      newCDPSession: async (target: unknown) => ({
        send: async (method: string) =>
          method === "Target.getTargets"
            ? { targetInfos: [{ targetId: "source" }] }
            : {
                targetInfo: {
                  targetId: target === page ? "source" : "popup",
                  type: "page",
                  browserContextId: "context",
                  url: target === page ? currentUrl : popup.url(),
                },
              },
        detach: async () => undefined,
      }),
      browser: () => ({
        newBrowserCDPSession: async () => ({
          send: async (method: string) => {
            if (method === "Target.getTargets") return { targetInfos: [{ targetId: "source", url: currentUrl }] };
            actions++;
            if (actions === 1) change("paired-idle");
            else {
              sequence++;
              context.emit("page", popup);
            }
            return {};
          },
          detach: async () => undefined,
        }),
      }),
    });
    vi.stubGlobal("chrome", chrome);
    try {
      const outcome = await runPairingDrill({
        mode: "deployed",
        smoke: false,
        platformOrigin: staging,
        deployRun: run,
        deployCommit: commit,
        dist,
        clientId: stagingSynthetic.clientId,
        artifactDigest: digest,
        personaAlias: stagingSynthetic.personaAlias,
        outputDir,
        preflight: {
          deploy: binding(),
          rows: await stagingPreflightRows(staging, stagingSynthetic.clientId, fake.resolver),
        },
        signIn: async () => undefined,
        resolver: fake.resolver,
        fakeDocuments: {
          sequence: () => sequence,
          responses: () =>
            sequence
              ? [
                  {
                    sequence,
                    marker,
                    host: stagingHost,
                    path: `/account/channels/${id}`,
                    method: "GET",
                    status: 200,
                    session: true,
                    completed: "finish",
                  },
                ]
              : [],
        },
        launch: async () => context as unknown as BrowserContext,
      }).then(
        (result) => ({ receipt: result.receipt, error: undefined }),
        (error: unknown) => ({ receipt: undefined, error }),
      );
      return { outcome, actions, postJoinListeners, context, page, popup, release: () => release() };
    } finally {
      clearInterval(ticker);
      vi.useRealTimers();
      await fake.close();
      vi.unstubAllGlobals();
      delete (globalThis as { connectorDrillLifecycle?: unknown }).connectorDrillLifecycle;
      delete (globalThis as { connectorDrillDisplay?: unknown }).connectorDrillDisplay;
      rmSync(outputDir, { recursive: true, force: true });
    }
  }
  const expectReleased = (run: Awaited<ReturnType<typeof syntheticDrill>>) => {
    expect(run.context.listenerCount("response")).toBe(0);
    expect(run.context.listenerCount("page")).toBe(0);
    expect(run.page.listenerCount("response")).toBe(0);
    expect(run.popup.listenerCount("response")).toBe(0);
  };
  const pausedClaim = { phase: "paused", path: storedPath, status: 200, reservation: null, bodyCode: null };
  const unpairedClaim = {
    phase: "unpaired",
    path: storedPath,
    status: 401,
  };
  const pausedResponse = { phase: "paused", status: 200, body: "settled" };
  it.each([false, true])(
    "keeps the installed producer after the actual marker join until success/refusal (%s)",
    async (refuse) => {
      const run = await syntheticDrill({ pausedReservation: refuse });
      expect(run.actions).toBe(2);
      expect(run.postJoinListeners.length).toBeGreaterThan(0);
      expect(run.postJoinListeners.every((count) => count === 1)).toBe(true);
      expect(codeOf(run.outcome.error)).toBe(refuse ? "connector-drill-paused-claim-refused" : undefined);
      const evidence =
        run.outcome.error instanceof PairingDrillRefusal ? run.outcome.error.evidence.deployed : run.outcome.receipt;
      expect(evidence?.pages.filter((row) => row.fakeDocument)).toHaveLength(1);
      expect(evidence?.claims.filter((row) => row.phase === "paused")).toHaveLength(2);
      if (!refuse)
        expect(run.outcome.receipt?.claims).toContainEqual(expect.objectContaining({ phase: "unpaired", status: 401 }));
      expectReleased(run);
    },
  );
  it.each(["settled-then-revoked", "revoked-after-first-read", "event-after-revoked", "body-after-revoked"] as const)(
    "consumes the browser's own post-Unpair 401 and the revocation in either order (%s)",
    async (postUnpair) => {
      const run = await syntheticDrill({ postUnpair });
      expect(codeOf(run.outcome.error)).toBeUndefined();
      expect(run.outcome.receipt?.claims).toEqual([pausedClaim, pausedClaim, unpairedClaim]);
      expect(run.outcome.receipt?.lifecycle).toEqual(["paired-idle", "cleanup-pending", "revoked"]);
      expect(run.outcome.receipt?.display.map(({ state }) => state)).toEqual([
        "paired-idle",
        "cleanup-pending",
        "revoked",
      ]);
      // The response/body diagnostic is refusal evidence only.
      expect(run.outcome.receipt).not.toHaveProperty("claimResponses");
      expectReleased(run);
    },
  );
  it.each([
    ["missing", []],
    ["post-boundary-200", [{ phase: "unpaired", status: 200, body: "settled" }]],
    ["pre-boundary-late-401", [{ phase: "paused", status: 401, body: "settled" }]],
  ] as const)(
    "refuses %s browser authority at the leg deadline although the product revoked",
    async (postUnpair, late) => {
      const run = await syntheticDrill({ postUnpair });
      expect(codeOf(run.outcome.error)).toBe("connector-drill-lifecycle-refused");
      const { evidence } = run.outcome.error as PairingDrillRefusal;
      expect(evidence.lifecycle).toEqual(["paired-idle", "cleanup-pending", "revoked"]);
      expect(evidence.deployed?.claims).not.toContainEqual(unpairedClaim);
      expect(evidence.deployed?.claimResponses).toEqual([pausedResponse, pausedResponse, ...late]);
      expect(evidence.deployed?.steps.at(-1)).toMatchObject({ step: "disconnect", bodyCode: "disconnected" });
      expect(evidence.deployed?.profile?.deleted).toBe(true);
      expectReleased(run);
    },
  );
  it("accepts a post-Unpair 401 event with a body still pending at the deadline", async () => {
    const first = await syntheticDrill({ postUnpair: "body-unresolved" });
    expect(codeOf(first.outcome.error)).toBeUndefined();
    expect(first.outcome.receipt?.claims).toEqual([pausedClaim, pausedClaim, unpairedClaim]);
    expectReleased(first);
    // The first run's body settles while the second run's own post-Unpair claim is in flight.
    const second = await syntheticDrill({ onUnpairedFire: first.release });
    expect(codeOf(second.outcome.error)).toBeUndefined();
    expect(second.outcome.receipt?.claims).toEqual([pausedClaim, pausedClaim, unpairedClaim]);
    expectReleased(second);
  });
});

describe("fake response completion and main-document join", () => {
  const path = "/account/channels/producer-connection";
  const boundary: FakePopupBoundary = {
    origin: staging,
    path,
    sourceTargetId: "source",
    browserContextId: "context",
    targetIds: ["source", "old-tab"],
    sequence: 0,
  };
  const mainDocument = (marker: string): FakePopupMainDocument => ({
    targetId: "new-tab",
    type: "page",
    browserContextId: "context",
    openerId: null,
    newPage: true,
    mainDocument: true,
    url: `${staging}${path}`,
    targetUrl: `${staging}${path}`,
    documentUrl: `${staging}${path}`,
    markers: [marker],
  });
  async function produce(options: { abort?: boolean; status?: number } = {}, recorder = createFakeDocumentRecorder()) {
    let beforeFinish: readonly FakeDocumentResponse[] = [];
    let startedSequence = 0;
    const server = createServer((request, reply) => {
      const meta = recorder.begin(request, reply, true);
      startedSequence = recorder.sequence();
      reply.writeHead(options.status ?? 200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
      beforeFinish = recorder.responses();
      if (options.abort) reply.destroy();
      else reply.end(`<!doctype html><title>Producer</title>${meta}`);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("producer-listen-refused");
      const body = await new Promise<string>((resolve, reject) => {
        get({ hostname: "127.0.0.1", port: address.port, path, headers: { Host: stagingHost } }, (response) => {
          let body = "";
          response.setEncoding("utf8");
          response.on("data", (chunk: string) => {
            body += chunk;
          });
          response.on("end", () => resolve(body));
          response.on("error", reject);
        }).on("error", (error) => (options.abort ? resolve("") : reject(error)));
      });
      // This extracts server markup for unit correlation, not browser receipt evidence.
      const marker = /<meta name="connector-drill-response" content="([a-f0-9-]+)">/.exec(body)?.[1] ?? "";
      return { marker, beforeFinish, startedSequence, rows: recorder.responses() };
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  }
  it("publishes only on actual finish, not unfinished writeHead intent", async () => {
    const produced = await produce();
    expect(produced.beforeFinish).toEqual([]);
    expect(produced.startedSequence).toBe(1);
    expect(produced.rows).toEqual([
      {
        sequence: 1,
        marker: produced.marker,
        host: stagingHost,
        path,
        method: "GET",
        status: 200,
        session: true,
        completed: "finish",
      },
    ]);
  });
  it("does not publish an aborted response", async () => {
    const produced = await produce({ abort: true });
    expect(produced.startedSequence).toBe(1);
    expect(produced.rows).toEqual([]);
  });
  it("records emitted status rather than assuming successful intent", async () => {
    const produced = await produce({ status: 503 });
    expect(produced.rows[0]?.status).toBe(503);
    expect(correlateFakePopupDocument(boundary, mainDocument(produced.marker), produced.rows)).toBeUndefined();
  });
  it("joins a unique completed response before Page discovery, including null opener", async () => {
    const produced = await produce();
    const document = mainDocument(produced.marker);
    expect(correlateFakePopupDocument(boundary, document, produced.rows)).toEqual(produced.rows[0]);
    expect(correlateFakePopupDocument(boundary, { ...document, openerId: "source" }, produced.rows)).toEqual(
      produced.rows[0],
    );
    expect((await produce()).marker).not.toBe(produced.marker);
  });
  const documentControls: readonly [string, Partial<FakePopupMainDocument>][] = [
    ["old Page", { newPage: false }],
    ["subframe", { mainDocument: false }],
    ["worker-only", { type: "service_worker" }],
    ["source target", { targetId: "source" }],
    ["missing target", { targetId: "" }],
    ["old same-URL target", { targetId: "old-tab" }],
    ["different context", { browserContextId: "other-context" }],
    ["wrong opener", { openerId: "other-source" }],
    ["wrong origin", { url: `https://other.invalid${path}` }],
    ["wrong path", { url: `${staging}/account/channels/other` }],
    ["wrong target URL", { targetUrl: `${staging}${path}?other` }],
    ["different main document", { documentUrl: `${staging}${path}?other` }],
    ["missing marker", { markers: [] }],
    ["malformed marker", { markers: ["driver-injected"] }],
    ["wrong driver-injected marker", { markers: ["a".repeat(36)] }],
  ];
  it.each(documentControls)("refuses %s with all other inputs frozen", async (_name, change) => {
    const produced = await produce();
    const changedDocument = { ...mainDocument(produced.marker), ...change };
    // Keep the other URL authorities aligned so only the declared origin/path rule can reject it.
    if (_name === "wrong origin" || _name === "wrong path") {
      Object.assign(changedDocument, { targetUrl: changedDocument.url, documentUrl: changedDocument.url });
    }
    const isolatedBoundary = _name === "source target" ? { ...boundary, targetIds: ["old-tab"] } : boundary;
    expect(correlateFakePopupDocument(isolatedBoundary, changedDocument, produced.rows)).toBeUndefined();
  });
  const responseControls: readonly [string, Partial<FakeDocumentResponse>][] = [
    ["prior sequence", { sequence: 0 }],
    ["wrong Host", { host: "other.invalid" }],
    ["wrong response path", { path: "/account/channels/other" }],
    ["non-GET", { method: "POST" }],
    ["non-200", { status: 404 }],
    ["missing session", { session: false }],
  ];
  it.each(responseControls)("refuses %s with all other inputs frozen", async (_name, change) => {
    const produced = await produce();
    expect(
      correlateFakePopupDocument(boundary, mainDocument(produced.marker), [{ ...produced.rows[0]!, ...change }]),
    ).toBeUndefined();
  });
  it("refuses replayed marker even when a newer response exists", async () => {
    const recorder = createFakeDocumentRecorder();
    const produced = await produce({}, recorder);
    const newer = await produce({}, recorder);
    expect(newer.rows.map((row) => row.sequence)).toEqual([1, 2]);
    expect(
      correlateFakePopupDocument({ ...boundary, sequence: 1 }, mainDocument(produced.marker), newer.rows),
    ).toBeUndefined();
  });
  it("refuses missing context authority", async () => {
    const produced = await produce();
    expect(
      correlateFakePopupDocument(
        { ...boundary, browserContextId: "" },
        { ...mainDocument(produced.marker), browserContextId: "" },
        produced.rows,
      ),
    ).toBeUndefined();
  });
  it("refuses a non-finish row even with the correct document marker", async () => {
    const produced = await produce();
    Object.defineProperty(produced.rows[0], "completed", { value: "close" });
    expect(correlateFakePopupDocument(boundary, mainDocument(produced.marker), produced.rows)).toBeUndefined();
  });
  it("refuses duplicate response identity", async () => {
    const produced = await produce();
    expect(
      correlateFakePopupDocument(boundary, mainDocument(produced.marker), [...produced.rows, ...produced.rows]),
    ).toBeUndefined();
  });
  it("refuses duplicate document marker", async () => {
    const produced = await produce();
    expect(
      correlateFakePopupDocument(
        boundary,
        { ...mainDocument(produced.marker), markers: [produced.marker, produced.marker] },
        produced.rows,
      ),
    ).toBeUndefined();
  });
  it("refuses malformed response marker with other join inputs frozen", async () => {
    const produced = await produce();
    Object.defineProperty(produced.rows[0], "marker", { value: "driver-injected" });
    expect(correlateFakePopupDocument(boundary, mainDocument("driver-injected"), produced.rows)).toBeUndefined();
  });
  it("refuses server-only, URL-only and driver-injected document-only evidence", async () => {
    const produced = await produce();
    expect(
      correlateFakePopupDocument(boundary, { ...mainDocument(produced.marker), markers: [] }, produced.rows),
    ).toBeUndefined();
    expect(correlateFakePopupDocument(boundary, mainDocument(produced.marker), [])).toBeUndefined();
  });
});

describe("live deployed popup browser-response refusals", () => {
  const path = "/account/channels/synthetic-popup-connection";
  const url = `${staging}${path}`;
  type Transport = Parameters<typeof createDeployedPopupObserver>[1];
  type Event = Parameters<Parameters<Transport["on"]>[0]>[0];
  const observers: ReturnType<typeof createDeployedPopupObserver>[] = [];
  afterEach(async () => {
    for (const observer of observers.splice(0)) await observer.close();
  });
  async function scenario(
    overrides: {
      openerId?: string | null;
      browserContextId?: string;
      omitContext?: boolean;
      targetType?: string;
      requestSession?: string;
      responseSession?: string;
      method?: string;
      navigationUrl?: string;
      resourceType?: string;
      status?: number;
      response?: boolean;
      bind?: boolean;
      pageTargetId?: string;
      pageUrl?: string;
      targetId?: string;
      existingTargetIds?: readonly string[];
      beforeAction?: boolean;
      tabWaiting?: boolean;
      tabContext?: string;
      parentSession?: string | null;
      responseUrl?: string;
      targetUrl?: string;
      mainUrl?: string;
      responseRequestId?: string;
      requestFrame?: string;
      responseFrame?: string;
      responseLoader?: string;
      mainFrame?: string | null;
      mainLoader?: string;
      request?: boolean;
      failCommand?: string;
      holdNetworkAck?: boolean;
      holdCommand?: { method: string; sessionId?: string };
    } = {},
  ) {
    // Keep all URL signals consistent so only the declared origin/path guard
    // can reject these controls, not an unrelated page-binding mismatch.
    const navigationUrl = overrides.navigationUrl ?? url;
    const commands: { method: string; params: Record<string, unknown>; sessionId?: string }[] = [];
    const listeners = new Set<Parameters<Transport["on"]>[0]>();
    let networkAck: (() => void) | undefined;
    let held = false;
    const transport: Transport = {
      send(method, params = {}, sessionId) {
        commands.push({ method, params, sessionId });
        if (method === overrides.failCommand) return Promise.reject(new Error("synthetic-command-error"));
        if (
          !held &&
          ((method === "Network.enable" && overrides.holdNetworkAck) ||
            (overrides.holdCommand?.method === method && overrides.holdCommand.sessionId === sessionId))
        ) {
          held = true;
          return new Promise<void>((resolve) => {
            networkAck = resolve;
          });
        }
        return Promise.resolve({});
      },
      on(listener) {
        listeners.add(listener);
      },
      off(listener) {
        listeners.delete(listener);
      },
      close: vi.fn(async () => undefined),
    };
    const emit = (event: Event) => {
      for (const listener of listeners) listener(event);
    };
    const observer = createDeployedPopupObserver(
      {
        sourceTargetId: "synthetic-source",
        browserContextId: "synthetic-context",
        origin: staging,
        path,
      },
      transport,
    );
    observers.push(observer);
    await observer.start();
    if (!overrides.beforeAction) observer.startAction(overrides.existingTargetIds ?? ["synthetic-source"]);
    emit({
      method: "Target.attachedToTarget",
      params: {
        sessionId: "synthetic-tab-session",
        waitingForDebugger: overrides.tabWaiting ?? true,
        targetInfo: {
          targetId: "synthetic-tab",
          type: "tab",
          url: "",
          browserContextId: overrides.tabContext ?? "synthetic-context",
        },
      },
    });
    emit({
      method: "Target.attachedToTarget",
      sessionId: overrides.parentSession === null ? undefined : (overrides.parentSession ?? "synthetic-tab-session"),
      params: {
        sessionId: "synthetic-child-session",
        waitingForDebugger: false,
        targetInfo: {
          targetId: overrides.targetId ?? "synthetic-popup",
          type: overrides.targetType ?? "page",
          openerId: overrides.openerId === undefined ? "synthetic-source" : overrides.openerId,
          ...(overrides.omitContext ? {} : { browserContextId: overrides.browserContextId ?? "synthetic-context" }),
          url: "",
        },
      },
    });
    if (overrides.beforeAction) observer.startAction(["synthetic-source", "synthetic-popup"]);
    emit({
      method: "Target.targetInfoChanged",
      params: {
        targetInfo: {
          targetId: overrides.targetId ?? "synthetic-popup",
          url: overrides.targetUrl ?? navigationUrl,
        },
      },
    });
    if (overrides.request !== false)
      emit({
        method: "Network.requestWillBeSent",
        sessionId: overrides.requestSession ?? "synthetic-child-session",
        params: {
          requestId: "synthetic-request",
          frameId: overrides.requestFrame ?? "synthetic-main-frame",
          loaderId: "synthetic-loader",
          type: "Document",
          request: { method: overrides.method ?? "GET", url: navigationUrl },
        },
      });
    if (overrides.response !== false)
      emit({
        method: "Network.responseReceived",
        sessionId: overrides.responseSession ?? "synthetic-child-session",
        params: {
          requestId: overrides.responseRequestId ?? "synthetic-request",
          frameId: overrides.responseFrame ?? overrides.requestFrame ?? "synthetic-main-frame",
          loaderId: overrides.responseLoader ?? "synthetic-loader",
          type: overrides.resourceType ?? "Document",
          response: {
            url: overrides.responseUrl ?? navigationUrl,
            status: overrides.status ?? 200,
            mimeType: "text/html",
          },
        },
      });
    if (overrides.mainFrame !== null)
      emit({
        method: "Page.frameNavigated",
        sessionId: "synthetic-child-session",
        params: {
          frame: {
            id: overrides.mainFrame ?? "synthetic-main-frame",
            loaderId: overrides.mainLoader ?? "synthetic-loader",
            url: overrides.mainUrl ?? navigationUrl,
          },
        },
      });
    // The actual observer must retain a response arriving before Playwright's page.
    expect(observer.document()).toBeUndefined();
    if (overrides.bind !== false)
      observer.bindPage(overrides.pageTargetId ?? "synthetic-popup", overrides.pageUrl ?? navigationUrl);
    await Promise.resolve();
    return { observer, commands, emit, transport, listeners, acknowledgeNetwork: () => networkAck?.() };
  }

  it("retains response-before-page ordering", async () => {
    expect((await scenario()).observer.document()).toMatchObject({
      targetId: "synthetic-popup",
      sessionId: "synthetic-child-session",
      method: "GET",
      status: 200,
      url,
    });
  });
  it("accepts null opener only for a newly attached action target", async () => {
    expect((await scenario({ openerId: null })).observer.document()).toMatchObject({
      targetId: "synthetic-popup",
      status: 200,
    });
  });
  it("refuses null opener on a pre-existing target", async () => {
    expect(
      (
        await scenario({ openerId: null, existingTargetIds: ["synthetic-source", "synthetic-popup"] })
      ).observer.document(),
    ).toBeUndefined();
  });
  it("refuses a target attached before the action", async () => {
    expect((await scenario({ beforeAction: true })).observer.document()).toBeUndefined();
  });
  it("refuses the source target as the surfaced page", async () => {
    expect(
      (
        await scenario({ targetId: "synthetic-source", pageTargetId: "synthetic-source", existingTargetIds: [] })
      ).observer.document(),
    ).toBeUndefined();
  });
  it("refuses wrong target session", async () => {
    expect((await scenario({ responseSession: "synthetic-unrelated-session" })).observer.document()).toBeUndefined();
  });
  it("refuses wrong request session", async () => {
    expect((await scenario({ requestSession: "synthetic-unrelated-session" })).observer.document()).toBeUndefined();
  });
  it("refuses wrong opener", async () => {
    expect((await scenario({ openerId: "synthetic-other-opener" })).observer.document()).toBeUndefined();
  });
  it("refuses wrong browser context", async () => {
    expect((await scenario({ browserContextId: "synthetic-other-context" })).observer.document()).toBeUndefined();
  });
  it("refuses a missing browser context binding", async () => {
    expect((await scenario({ openerId: null, omitContext: true })).observer.document()).toBeUndefined();
  });
  it("refuses wrong origin", async () => {
    expect((await scenario({ navigationUrl: `https://unrelated.example${path}` })).observer.document()).toBeUndefined();
  });
  it("refuses wrong stored path", async () => {
    expect(
      (await scenario({ navigationUrl: `${staging}/account/channels/synthetic-wrong-connection` })).observer.document(),
    ).toBeUndefined();
  });
  it("refuses non-Document resource", async () => {
    expect((await scenario({ resourceType: "Stylesheet" })).observer.document()).toBeUndefined();
  });
  it("refuses non-200 response", async () => {
    expect((await scenario({ status: 404 })).observer.document()).toBeUndefined();
  });
  it("refuses non-GET request", async () => {
    expect((await scenario({ method: "POST" })).observer.document()).toBeUndefined();
  });
  it("refuses missing target-page binding", async () => {
    expect((await scenario({ bind: false })).observer.document()).toBeUndefined();
  });
  it("refuses same-URL wrong page target", async () => {
    expect((await scenario({ pageTargetId: "synthetic-unrelated-page" })).observer.document()).toBeUndefined();
  });
  it("refuses wrong surfaced page URL", async () => {
    expect(
      (await scenario({ pageUrl: `${staging}/account/channels/synthetic-other-page` })).observer.document(),
    ).toBeUndefined();
  });
  it("refuses same-path different page URL", async () => {
    expect((await scenario({ pageUrl: `${url}?synthetic-different-document` })).observer.document()).toBeUndefined();
  });
  it("refuses fake-server receipt with no target response", async () => {
    const fakeServerReceipt = { method: "GET", url, status: 200 };
    expect(fakeServerReceipt.status).toBe(200);
    expect((await scenario({ response: false })).observer.document()).toBeUndefined();
  });
  it("refuses service-worker-only evidence", async () => {
    expect((await scenario({ targetType: "service_worker" })).observer.document()).toBeUndefined();
  });
  it("refuses URL-only evidence", async () => {
    expect((await scenario({ response: false })).observer.document()).toBeUndefined();
  });
  it("refuses a mismatched response URL", async () => {
    expect((await scenario({ responseUrl: `${url}?synthetic-other-response` })).observer.document()).toBeUndefined();
  });
  it("refuses a mismatched target URL", async () => {
    expect((await scenario({ targetUrl: `${url}?synthetic-other-target` })).observer.document()).toBeUndefined();
  });
  it("refuses a mismatched main-frame URL", async () => {
    expect((await scenario({ mainUrl: `${url}?synthetic-other-frame` })).observer.document()).toBeUndefined();
  });
  it("refuses a response without its request", async () => {
    expect((await scenario({ request: false })).observer.document()).toBeUndefined();
  });
  it("refuses wrong request identity", async () => {
    expect((await scenario({ responseRequestId: "synthetic-other-request" })).observer.document()).toBeUndefined();
  });
  it("refuses request-response frame mismatch", async () => {
    expect((await scenario({ responseFrame: "synthetic-subframe" })).observer.document()).toBeUndefined();
  });
  it("refuses request-response loader mismatch", async () => {
    expect((await scenario({ responseLoader: "synthetic-other-loader" })).observer.document()).toBeUndefined();
  });
  it("refuses same-URL subframe Document evidence", async () => {
    const { observer, emit } = await scenario({ requestFrame: "synthetic-subframe" });
    emit({
      method: "Page.frameNavigated",
      sessionId: "synthetic-child-session",
      params: {
        frame: {
          id: "synthetic-subframe",
          parentId: "synthetic-main-frame",
          loaderId: "synthetic-loader",
          url,
        },
      },
    });
    expect(observer.document()).toBeUndefined();
  });
  it("requires top-level frame identity even with a complete response", async () => {
    expect((await scenario({ mainFrame: null })).observer.document()).toBeUndefined();
  });
  it("refuses a stale main-frame loader", async () => {
    expect((await scenario({ mainLoader: "synthetic-new-loader" })).observer.document()).toBeUndefined();
  });
  it("refuses load-only evidence", async () => {
    const { observer, emit } = await scenario({ response: false });
    emit({ method: "Page.lifecycleEvent", sessionId: "synthetic-child-session", params: { name: "load" } });
    emit({
      method: "Network.loadingFinished",
      sessionId: "synthetic-child-session",
      params: { requestId: "synthetic-request" },
    });
    expect(observer.document()).toBeUndefined();
  });
  it("refuses command failure and cleans up every owned session through its parent", async () => {
    const { observer, commands, listeners, transport } = await scenario({ failCommand: "Network.enable" });
    expect(observer.failure).toBe("Network.enable:command-error");
    expect(observer.document()).toBeUndefined();
    const setupCount = commands.length;
    await observer.close();
    expect(commands.slice(setupCount, setupCount + 2)).toEqual([
      { method: "Runtime.runIfWaitingForDebugger", params: {}, sessionId: "synthetic-tab-session" },
      { method: "Runtime.runIfWaitingForDebugger", params: {}, sessionId: "synthetic-child-session" },
    ]);
    expect(commands).toEqual(
      expect.arrayContaining([
        {
          method: "Target.detachFromTarget",
          params: { sessionId: "synthetic-child-session" },
          sessionId: "synthetic-tab-session",
        },
        { method: "Target.detachFromTarget", params: { sessionId: "synthetic-tab-session" }, sessionId: undefined },
        {
          method: "Target.setAutoAttach",
          params: { autoAttach: false, waitForDebuggerOnStart: false, flatten: true },
          sessionId: undefined,
        },
        {
          method: "Target.setAutoAttach",
          params: { autoAttach: false, waitForDebuggerOnStart: false, flatten: true },
          sessionId: "synthetic-tab-session",
        },
      ]),
    );
    expect(listeners.size).toBe(0);
    expect(transport.close).toHaveBeenCalledOnce();
    observers.splice(observers.indexOf(observer), 1);
  });
  it("sanitizes chronology without losing raw event counts and correlation failures", async () => {
    const { observer } = await scenario({
      navigationUrl: `${url}?token=synthetic-secret`,
      responseFrame: "synthetic-other-frame",
    });
    const diagnostic = observer.diagnostic();
    expect(diagnostic.targets[1]).toMatchObject({
      rawDocumentRequests: 1,
      rawDocumentResponses: 1,
      rejections: { "request-response-identity": 1 },
    });
    expect(JSON.stringify(diagnostic)).not.toContain("synthetic-secret");
    expect(JSON.stringify(diagnostic)).not.toContain("synthetic-popup-connection");
    expect(diagnostic.chronology).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event: "request", host: stagingHost, path: "/account/channels/<connectionId>" }),
      ]),
    );
  });
});

it("routes direct-root commands and flattened child events without a synthetic browser session", async () => {
  const profile = mkdtempSync(join(tmpdir(), "connector-cdp-root-control-"));
  writeFileSync(join(profile, "DevToolsActivePort"), "12345\n");
  const commands: { id: number; method: string; sessionId?: string }[] = [];
  let socket: SyntheticSocket | undefined;
  class SyntheticSocket extends EventTarget {
    static OPEN = 1;
    readyState = SyntheticSocket.OPEN;
    constructor(readonly url: string) {
      super();
      socket = this;
      queueMicrotask(() => this.dispatchEvent(new Event("open")));
    }
    emit(message: unknown) {
      this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(message) }));
    }
    send(data: string) {
      const command = JSON.parse(data) as (typeof commands)[number];
      commands.push(command);
      queueMicrotask(() => this.emit({ id: command.id, result: {} }));
    }
    close() {
      this.dispatchEvent(new Event("close"));
    }
  }
  vi.stubGlobal("WebSocket", SyntheticSocket);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ webSocketDebuggerUrl: "ws://127.0.0.1:12345/devtools/browser/synthetic" })),
  );
  try {
    const transport = await openRawCdpTransport(profile);
    try {
      expect(commands).toEqual([]);
      await transport.send("Target.getTargets");
      await transport.send("Target.setAutoAttach", { autoAttach: true, flatten: true, waitForDebuggerOnStart: true });
      const events: unknown[] = [];
      const observe = vi.fn<Parameters<typeof transport.on>[0]>((event) => {
        events.push(event);
      });
      transport.on(observe);
      const attached = { method: "Target.attachedToTarget", params: { sessionId: "synthetic-child" } };
      const response = {
        method: "Network.responseReceived",
        params: { type: "Document" },
        sessionId: "synthetic-child",
      };
      socket!.emit(attached);
      await transport.send("Network.enable", {}, "synthetic-child");
      await transport.send("Runtime.runIfWaitingForDebugger", {}, "synthetic-child");
      socket!.emit(response);
      expect(events).toEqual([attached, response]);
      expect(commands.map(({ method, sessionId }) => ({ method, sessionId }))).toEqual([
        { method: "Target.getTargets", sessionId: undefined },
        { method: "Target.setAutoAttach", sessionId: undefined },
        { method: "Network.enable", sessionId: "synthetic-child" },
        { method: "Runtime.runIfWaitingForDebugger", sessionId: "synthetic-child" },
      ]);
      transport.off(observe);
      socket!.emit(response);
      expect(observe).toHaveBeenCalledTimes(2);
    } finally {
      await transport.close();
    }
  } finally {
    vi.unstubAllGlobals();
    rmSync(profile, { recursive: true, force: true });
  }
});
const authorizePath = "/channel-connector/oauth/authorize";
const run = "1";
const commit = `${"0".repeat(39)}1`;
let dist: string;
let digest: string;

beforeAll(() => {
  // A synthetic dist that passes the origin, client and digest checks, so a run reaches its launch.
  dist = mkdtempSync(join(tmpdir(), "connector-drill-unit-dist-"));
  writeFileSync(join(dist, "manifest.json"), JSON.stringify({ host_permissions: [`${staging}/*`] }));
  writeFileSync(join(dist, "background.js"), `const clientId = "${stagingSynthetic.clientId}";\n`);
  digest = digestConnectorDist(dist);
});
afterAll(() => rmSync(dist, { recursive: true, force: true }));

const binding = (overrides: Partial<PairingDrillDeployBinding> = {}): PairingDrillDeployBinding => ({
  runId: run,
  runAttempt: 1,
  jobId: "1",
  jobCompletedAt: "2026-01-01T00:00:00Z",
  deployedHead: commit,
  requiredMerges: [10110, 9985, 10639, 10640].map((issue) => ({
    issue,
    pullRequest: issue,
    mergeCommit: "0".repeat(40),
    contained: true,
  })),
  receiptFloorRunId: run,
  ...overrides,
});
const pairingArgs = (overrides: Record<string, string | null> = {}) =>
  Object.entries({
    "--deploy-run": run,
    "--deploy-commit": commit,
    "--platform-origin": staging,
    "--client-id": stagingSynthetic.clientId,
    "--artifact-digest": "",
    "--persona-alias": stagingSynthetic.personaAlias,
    ...overrides,
  }).flatMap(([flag, value]) =>
    value === null ? [] : [flag, flag === "--artifact-digest" && !value ? digest : value],
  );
const smokeArgs = (overrides: Record<string, string | null> = {}) => [
  "--smoke",
  ...Object.entries({
    "--deploy-run": run,
    "--deploy-commit": commit,
    "--platform-origin": staging,
    ...overrides,
  }).flatMap(([flag, value]) => (value === null ? [] : [flag, value])),
];

function refusalCode(action: () => unknown): PairingDrillRefusalCode | "accepted" {
  try {
    action();
    return "accepted";
  } catch (error) {
    if (!(error instanceof PairingDrillRefusal)) throw error;
    return error.code;
  }
}

async function refused(run: Promise<unknown>) {
  const error = await run.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(PairingDrillRefusal);
  return error as PairingDrillRefusal;
}

type Handle = (request: IncomingMessage, reply: ServerResponse) => Promise<boolean>;
/** Serves one replacement authorize response for the matching query shape; everything else stays the fake's. */
const authorizeOverride =
  (shape: "mount" | "client" | "unregistered", status: number, headers: Record<string, string>, body = ""): Handle =>
  async (request, reply) => {
    const url = new URL(request.url!, staging);
    if (url.pathname !== authorizePath) return false;
    const client = url.searchParams.get("client_id");
    const actual = !client ? "mount" : client === stagingSynthetic.clientId ? "client" : "unregistered";
    if (actual !== shape) return false;
    reply.writeHead(status, headers).end(body);
    return true;
  };

async function command(
  argv: readonly string[],
  options: {
    binding?: DeployBindingResult;
    signIn?: boolean;
    handle?: Handle;
    resolver?: "fake" | "untrusted";
    browser?: BrowserContext;
  } = {},
) {
  const fake = await stagingFakePlatform({ handle: options.handle });
  const resolveDeployBinding = vi.fn(async () => options.binding ?? { binding: binding() });
  const launches: { profilePath: string; options: DrillLaunchOptions }[] = [];
  const launch = vi.fn(async (profilePath: string, launchOptions: DrillLaunchOptions): Promise<BrowserContext> => {
    launches.push({ profilePath, options: launchOptions });
    if (options.browser) return options.browser;
    throw new Error("launch-refused-by-test");
  });
  const resolver =
    options.resolver === "untrusted"
      ? { ...fake.resolver, certificatePem: drillTestCertificate().certificatePem }
      : fake.resolver;
  const outputDir = mkdtempSync(join(tmpdir(), "connector-drill-unit-out-"));
  const ports: StagingDrillPorts = {
    resolveDeployBinding,
    ...(options.signIn === false ? {} : { signIn: async () => undefined }),
    dist,
    outputDir,
    resolver,
    fakeDocuments: fake.documents,
    launch,
  };
  try {
    const outcome = await runStagingDrill(argv, ports).then(
      () => ({ error: undefined }),
      (error: unknown) => ({ error }),
    );
    return { ...outcome, resolveDeployBinding, launches, fake, rows: fake.rows() };
  } finally {
    await fake.close();
    rmSync(outputDir, { recursive: true, force: true });
  }
}
const codeOf = (error: unknown) => (error instanceof PairingDrillRefusal ? error.code : error);

describe("connector-pairing-drill-deployed arguments", () => {
  it("refuses fake response proof supplied to live mode", () => {
    const input = {
      mode: "deployed" as const,
      smoke: true,
      platformOrigin: staging,
      deployRun: run,
      deployCommit: commit,
      outputDir: "unused",
      preflight: { deploy: binding(), rows: [] },
      fakeDocuments: createFakeDocumentRecorder(),
    };
    expect(deployedInputRefusal(input)).toBe("connector-drill-page-status");
    expect(deployedInputRefusal({ ...input, fakeDocuments: undefined })).toBeNull();
  });
  it("accepts a complete pairing run and a deploy-and-origin-only smoke", () => {
    expect(parseStagingDrillArgs(pairingArgs())).toMatchObject({ smoke: false, deployRun: run, deployCommit: commit });
    expect(parseStagingDrillArgs(["--", ...smokeArgs()])).toEqual({
      smoke: true,
      deployRun: run,
      deployCommit: commit,
      platformOrigin: staging,
      clientId: undefined,
      artifactDigest: undefined,
      personaAlias: undefined,
    });
  });

  it("refuses each missing input, an extra smoke input, unknown or repeated flags and malformed deploy ids", () => {
    const cases: [string, readonly string[], PairingDrillRefusalCode][] = [
      ...[
        "--deploy-run",
        "--deploy-commit",
        "--platform-origin",
        "--client-id",
        "--artifact-digest",
        "--persona-alias",
      ].map((flag): [string, readonly string[], PairingDrillRefusalCode] => [
        `pairing without ${flag}`,
        pairingArgs({ [flag]: null }),
        "connector-drill-input-incomplete",
      ]),
      ...["--deploy-run", "--deploy-commit", "--platform-origin"].map(
        (flag): [string, readonly string[], PairingDrillRefusalCode] => [
          `smoke without ${flag}`,
          smokeArgs({ [flag]: null }),
          "connector-drill-input-incomplete",
        ],
      ),
      ["smoke with a persona", [...smokeArgs(), "--persona-alias", "x"], "connector-drill-input-incomplete"],
      ["unknown flag", [...smokeArgs(), "--trace", "on"], "connector-drill-input-incomplete"],
      ["repeated flag", [...smokeArgs(), "--deploy-run", run], "connector-drill-input-incomplete"],
      [
        "flag without value",
        [...smokeArgs({ "--deploy-run": null }), "--deploy-run"],
        "connector-drill-input-incomplete",
      ],
      ["short commit", smokeArgs({ "--deploy-commit": "abc123" }), "connector-drill-input-incomplete"],
      ["non-decimal run", smokeArgs({ "--deploy-run": "run-1" }), "connector-drill-input-incomplete"],
    ];
    for (const [name, argv, code] of cases)
      expect({ name, code: refusalCode(() => parseStagingDrillArgs(argv)) }).toEqual({ name, code });
  });

  it("refuses production, loopback-only and any other origin", () => {
    for (const argv of [
      pairingArgs({ "--platform-origin": production }),
      smokeArgs({ "--platform-origin": production }),
    ])
      expect(refusalCode(() => parseStagingDrillArgs(argv))).toBe("connector-drill-production-origin-refused");
    for (const origin of ["http://127.0.0.1:46174", `${staging}/`, "https://marketplace.chasesets.example"])
      expect(refusalCode(() => parseStagingDrillArgs(smokeArgs({ "--platform-origin": origin })))).toBe(
        "connector-drill-platform-origin-refused",
      );
  });
});

describe("connector-pairing-drill-deployed preflight rows", () => {
  it("records the mount, no-follow client and unregistered-client rows through the fake's resolver and certificate", async () => {
    const fake = await stagingFakePlatform();
    try {
      const rows = await stagingPreflightRows(staging, stagingSynthetic.clientId, fake.resolver);
      expect(rows).toEqual([
        {
          row: "mount",
          host: stagingHost,
          path: authorizePath,
          status: 400,
          contentType: "application/json",
          bodyCode: "invalid-request",
          locationHost: null,
          errorDescription: null,
        },
        {
          row: "client",
          host: stagingHost,
          path: authorizePath,
          status: 302,
          contentType: null,
          bodyCode: null,
          locationHost: new URL(TCGPLAYER_CONNECTOR_REDIRECT_URI).host,
          errorDescription: "authorization_refused",
        },
        {
          row: "unregistered-client",
          host: stagingHost,
          path: authorizePath,
          status: 400,
          contentType: "application/json",
          bodyCode: "invalid-client",
          locationHost: null,
          errorDescription: null,
        },
      ]);
      // Unauthenticated Node probes: no browser, no session, and the redirect is never followed.
      expect(fake.rows()).toEqual([
        { step: "authorize-mount", method: "GET", browser: false, session: false, status: 400 },
        { step: "authorize-refused", method: "GET", browser: false, session: false, status: 302 },
        { step: "authorize-unregistered", method: "GET", browser: false, session: false, status: 400 },
      ]);
    } finally {
      await fake.close();
    }
  });

  it("trusts only the per-run test certificate, which names only the staging host", async () => {
    const certificate = new X509Certificate(drillTestCertificate().certificatePem);
    expect(certificate.checkHost(new URL(staging).hostname)).toBe(new URL(staging).hostname);
    expect(certificate.checkHost("marketplace.chasesets.com")).toBeUndefined();
    const fake = await stagingFakePlatform();
    try {
      const rows = await stagingPreflightRows(staging, stagingSynthetic.clientId, {
        ...fake.resolver,
        certificatePem: drillTestCertificate().certificatePem,
      });
      expect(rows.map((row) => row.status)).toEqual([0, 0, 0]);
      expect(fake.rows()).toEqual([]);
    } finally {
      await fake.close();
    }
  });
});

describe("connector-pairing-drill-deployed fake staging host", () => {
  it("serves the owned lifecycle in order and refuses a claim once unpaired", async () => {
    const fake = await stagingFakePlatform();
    const { address, port, certificatePem } = fake.resolver;
    const send = (method: string, path: string, body?: string, headers: Record<string, string> = {}) =>
      new Promise<{ status: number; location: string | null; json: Record<string, unknown> | null }>(
        (resolve, reject) => {
          const request = httpsRequest(
            new URL(path, staging),
            {
              method,
              port,
              ca: certificatePem,
              lookup: ((_host, options, callback) =>
                options.all ? callback(null, [{ address, family: 4 }]) : callback(null, address, 4)) as LookupFunction,
              headers: {
                cookie: `${synthetic.cookieName}=${synthetic.cookieValue}`,
                "user-agent": "Chrome/0 drill",
                ...headers,
              },
            },
            (response) => {
              let text = "";
              response.on("data", (chunk) => (text += chunk));
              response.on("end", () => {
                let json: Record<string, unknown> | null = null;
                try {
                  json = JSON.parse(text);
                } catch {
                  json = null;
                }
                resolve({ status: response.statusCode ?? 0, location: response.headers.location ?? null, json });
              });
            },
          );
          request.on("error", reject);
          request.end(body);
        },
      );
    try {
      const { json: connected } = await send("POST", "/api/channels/connections", '{"providerKey":"tcgplayer"}');
      const id = connected!.connectionId as string;
      const api = `/api/channels/connections/${id}`;
      const activated = await send(
        "POST",
        `${api}/activate`,
        JSON.stringify({ storageLocationIds: [stagingSynthetic.storageLocationId] }),
      );
      expect(activated.json?.status).toBe("active");
      expect((await send("POST", `${api}/pause`)).json?.status).toBe("paused");
      const form = { "content-type": "application/x-www-form-urlencoded" };
      expect((await send("POST", `/account/channels/${id}`, "intent=connector-code", form)).status).toBe(303);
      const coded = (await send("GET", `${api}/connector-pairing`)).json!;
      expect(coded).toMatchObject({ state: "code", revision: 1 });
      const verifier = "v".repeat(43);
      const challenge = createHash("sha256").update(verifier).digest("base64url");
      const authorize = new URLSearchParams({
        response_type: "code",
        client_id: stagingSynthetic.clientId,
        redirect_uri: TCGPLAYER_CONNECTOR_REDIRECT_URI,
        code_challenge: challenge,
        code_challenge_method: "S256",
        state: "s".repeat(43),
      });
      const authorized = await send("GET", `/channel-connector/oauth/authorize?${authorize}`);
      expect(new URL(authorized.location!).searchParams.get("code")).toBe(synthetic.code);
      const token = await send(
        "POST",
        "/channel-connector/oauth/token",
        JSON.stringify({
          grant_type: "authorization_code",
          client_id: stagingSynthetic.clientId,
          redirect_uri: TCGPLAYER_CONNECTOR_REDIRECT_URI,
          code: synthetic.code,
          code_verifier: verifier,
        }),
      );
      expect(token.json).toMatchObject({ connection_id: id });
      const claim = () =>
        send("POST", `/channel-connector/oauth/connections/${id}/claim`, "{}", {
          authorization: `Bearer ${synthetic.access}`,
        });
      expect((await claim()).json).toEqual({ reservation: null, pollWindowSeconds: 30 });
      expect((await send("GET", `${api}/connector-pairing`)).json?.state).toBe("paired");
      const unpair = `intent=connector-unpair&pairingId=${coded.pairingId}&revision=1`;
      expect((await send("POST", `/account/channels/${id}`, unpair, form)).status).toBe(303);
      expect(await claim()).toMatchObject({ status: 401, json: { error: "invalid-credential" } });
      expect((await send("POST", `${api}/disconnect`)).json?.status).toBe("disconnected");
      expect(fake.rows().map((row) => `${row.step}:${row.status}`)).toEqual([
        "connect:200",
        "activate:200",
        "pause:200",
        "code:303",
        "pairing-read:200",
        "authorize:302",
        "token:200",
        "claim:200",
        "pairing-read:200",
        "unpair:303",
        "claim:401",
        "disconnect:200",
      ]);
      expect((await send("GET", "/api/channels/connections", undefined, { cookie: "" })).status).toBe(401);
    } finally {
      await fake.close();
    }
  });
});

describe("connector-pairing-drill-deployed composed command before Chromium", () => {
  it("refuses fake response injection without a resolver before any adapter read", async () => {
    const resolveDeployBinding = vi.fn(async () => ({ binding: binding() }));
    const error = await refused(
      runStagingDrill(smokeArgs(), {
        dist,
        outputDir: "unused",
        resolveDeployBinding,
        fakeDocuments: createFakeDocumentRecorder(),
      }),
    );
    expect(error.code).toBe("connector-drill-page-status");
    expect(resolveDeployBinding).not.toHaveBeenCalled();
  });
  it("refuses an unavailable sign-in and a provider environment before reading the deploy", async () => {
    const unavailable = await command(pairingArgs(), { signIn: false });
    expect(codeOf(unavailable.error)).toBe("connector-drill-sign-in-unavailable");
    expect(unavailable.resolveDeployBinding).not.toHaveBeenCalled();
    process.env.TCGPLAYER_DRILL_MUTANT = "1";
    try {
      const provider = await command(smokeArgs());
      expect(codeOf(provider.error)).toBe("connector-drill-provider-environment-refused");
      expect(provider.resolveDeployBinding).not.toHaveBeenCalled();
      expect(provider.launches).toEqual([]);
    } finally {
      delete process.env.TCGPLAYER_DRILL_MUTANT;
    }
  });

  it("asks the adapter for the exact required issues and floor, and refuses its stop", async () => {
    const pairing = await command(pairingArgs(), { binding: { stop: "deploy-in-progress" } });
    expect(pairing.resolveDeployBinding).toHaveBeenCalledWith({
      run,
      commit,
      requiredIssues: [10110, 9985, 10639, 10640],
      requireReceiptFloor: true,
    });
    expect(codeOf(pairing.error)).toBe("connector-drill-deploy-binding-refused");
    expect((pairing.error as PairingDrillRefusal).evidence.deployStop).toBe("deploy-in-progress");
    const smoke = await command(smokeArgs(), { binding: { stop: "deploy-run-not-newest" } });
    expect(smoke.resolveDeployBinding).toHaveBeenCalledWith({
      run,
      commit,
      requiredIssues: [10639],
      requireReceiptFloor: false,
    });
    expect(codeOf(smoke.error)).toBe("connector-drill-deploy-binding-refused");
    expect([...pairing.launches, ...smoke.launches]).toEqual([]);
  });

  it("refuses a stale, uncontained or floorless binding before launch", async () => {
    const uncontained = (issue: number) =>
      binding().requiredMerges.map((merge) => (merge.issue === issue ? { ...merge, contained: false } : merge));
    const cases: [string, PairingDrillDeployBinding][] = [
      ["another run", binding({ runId: "2" })],
      ["another deployed head", binding({ deployedHead: "f".repeat(40) })],
      ...[10110, 9985, 10639, 10640].map((issue): [string, PairingDrillDeployBinding] => [
        `#${issue} not contained`,
        binding({ requiredMerges: uncontained(issue) }),
      ]),
      ["#10640 absent", binding({ requiredMerges: binding().requiredMerges.filter((merge) => merge.issue !== 10640) })],
      ["no receipt floor", binding({ receiptFloorRunId: null })],
      ["floor newer than the run", binding({ receiptFloorRunId: "2" })],
    ];
    for (const [name, bound] of cases) {
      const outcome = await command(pairingArgs(), { binding: { binding: bound } });
      expect({ name, code: codeOf(outcome.error), launches: outcome.launches.length }).toEqual({
        name,
        code: "connector-drill-deploy-binding-refused",
        launches: 0,
      });
    }
  });

  it("refuses each failing mount and client row before launch", async () => {
    const json = { "Content-Type": "application/json" };
    const callback = (description: string, host = new URL(TCGPLAYER_CONNECTOR_REDIRECT_URI).host) => ({
      Location: `https://${host}/callback?error=access_denied&error_description=${description}`,
    });
    const cases: [string, Handle, PairingDrillRefusalCode][] = [
      [
        "mount 404",
        authorizeOverride("mount", 404, json, '{"error":"invalid-request"}'),
        "connector-drill-preflight-mount-refused",
      ],
      [
        "mount html",
        authorizeOverride("mount", 400, { "Content-Type": "text/html" }, '{"error":"invalid-request"}'),
        "connector-drill-preflight-mount-refused",
      ],
      [
        "mount other code",
        authorizeOverride("mount", 400, json, '{"error":"other"}'),
        "connector-drill-preflight-mount-refused",
      ],
      ["client 400", authorizeOverride("client", 400, json, "{}"), "connector-drill-preflight-client-refused"],
      [
        "client to another host",
        authorizeOverride("client", 302, callback("authorization_refused", "callback.example")),
        "connector-drill-preflight-client-refused",
      ],
      [
        "client other description",
        authorizeOverride("client", 302, callback("pairing_code_missing")),
        "connector-drill-preflight-client-refused",
      ],
      [
        "unregistered client redirected",
        authorizeOverride("unregistered", 302, callback("authorization_refused")),
        "connector-drill-preflight-client-refused",
      ],
    ];
    for (const [name, handle, code] of cases) {
      const outcome = await command(pairingArgs(), { handle });
      expect({ name, code: codeOf(outcome.error), launches: outcome.launches.length }).toEqual({
        name,
        code,
        launches: 0,
      });
    }
    const untrusted = await command(pairingArgs(), { resolver: "untrusted" });
    expect(codeOf(untrusted.error)).toBe("connector-drill-preflight-mount-refused");
  });

  it("launches only after every row passes, with the exact resolver, one trusted SPKI and a minimal environment", async () => {
    const outcome = await command(pairingArgs());
    expect(outcome.error).toEqual(new Error("launch-refused-by-test"));
    expect(outcome.launches).toHaveLength(1);
    const [{ profilePath, options }] = outcome.launches;
    expect(options.args).toEqual([
      `--disable-extensions-except=${dist}`,
      `--load-extension=${dist}`,
      "--enable-unsafe-extension-debugging",
      `--host-resolver-rules=MAP ${new URL(staging).hostname}:443 127.0.0.1:${outcome.fake.resolver.port}, MAP * ~NOTFOUND`,
      `--ignore-certificate-errors-spki-list=${outcome.fake.resolver.certificateSpki}`,
      "--remote-debugging-port=0",
    ]);
    expect(options.env).toEqual(drillBrowserEnvironment(process.env));
    // A failed launch still deletes the drill profile.
    expect(existsSync(profilePath)).toBe(false);
    const smoke = await command(smokeArgs());
    expect(smoke.launches[0].options.args).toEqual([
      `--host-resolver-rules=MAP ${new URL(staging).hostname}:443 127.0.0.1:${smoke.fake.resolver.port}, MAP * ~NOTFOUND`,
      `--ignore-certificate-errors-spki-list=${smoke.fake.resolver.certificateSpki}`,
      "--remote-debugging-port=0",
    ]);
    expect(smoke.rows).toEqual([]);
  });
});

describe("connector-pairing-drill-deployed safety and cleanup", () => {
  it.each([200, 503])(
    "removes installed response listeners on a real drill's smoke success/refusal (%s)",
    async (status) => {
      const page = Object.assign(new EventEmitter(), {
        url: () => `${staging}/account/channels`,
        goto: async () => {
          const response = {
            request: () => ({
              serviceWorker: () => null,
              resourceType: () => "document",
              method: () => "GET",
              url: () => `${staging}/account/channels`,
            }),
            status: () => status,
            headers: () => ({ "content-type": "text/html" }),
          } as unknown as BrowserResponse;
          context.emit("response", response);
          page.emit("response", response);
          return response;
        },
      });
      const context = Object.assign(new EventEmitter(), {
        pages: () => [page],
        route: async () => undefined,
        cookies: async () => [],
        tracing: { start: async () => undefined, stop: async () => undefined },
        close: vi.fn(async () => undefined),
      });
      const outcome = await command(smokeArgs(), { browser: context as unknown as BrowserContext });
      expect(codeOf(outcome.error)).toBe(status === 200 ? undefined : "connector-drill-smoke-refused");
      expect(context.close).toHaveBeenCalledOnce();
      expect(context.listenerCount("response")).toBe(0);
      expect(context.listenerCount("page")).toBe(0);
      expect(page.listenerCount("response")).toBe(0);
    },
  );
  it("passes Chromium only display, temp and process plumbing, never agent or provider values", () => {
    const environment = drillBrowserEnvironment({
      PATH: "/usr/bin",
      HOME: "/home/drill",
      DISPLAY: ":99",
      XAUTHORITY: "/tmp/xvfb-auth",
      GITHUB_TOKEN: "agent-tier-value",
      BWS_ACCESS_TOKEN: "agent-tier-value",
      TCGPLAYER_SESSION: "provider-value",
      CONNECTOR_CONFIG_ROOT: "/provider",
      OPENAI_API_KEY: "agent-tier-value",
    });
    expect(environment).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/drill",
      DISPLAY: ":99",
      XAUTHORITY: "/tmp/xvfb-auth",
    });
    expect(
      Object.keys(drillBrowserEnvironment(process.env)).filter((key) => providerEnvironmentPattern.test(key)),
    ).toEqual([]);
  });

  it("resolves only the exact staging host on a real run, and loads no extension for smoke", () => {
    expect(deployedBrowserArgs(staging)).toEqual([
      `--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE ${new URL(staging).hostname}`,
    ]);
    expect(deployedBrowserArgs(staging, undefined, "/dist")).toEqual([
      "--disable-extensions-except=/dist",
      "--load-extension=/dist",
      "--enable-unsafe-extension-debugging",
      `--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE ${new URL(staging).hostname}`,
    ]);
  });

  it("reports the profile deleted only when nothing remains", () => {
    const make = () => {
      const path = mkdtempSync(join(tmpdir(), "connector-drill-unit-profile-"));
      mkdirSync(join(path, "Default"));
      writeFileSync(join(path, "Default", "Cookies"), "profile");
      return path;
    };
    const deleted = make();
    expect(cleanDrillProfile(deleted)).toBe(true);
    expect(existsSync(deleted)).toBe(false);
    const failing = make();
    expect(
      cleanDrillProfile(failing, () => {
        throw new Error("EBUSY");
      }),
    ).toBe(false);
    const ignored = make();
    expect(cleanDrillProfile(ignored, () => undefined)).toBe(false);
    for (const path of [failing, ignored]) rmSync(path, { recursive: true, force: true });
  });

  it("retains a clean receipt alone and deletes one carrying a marker or held literal", () => {
    const directory = mkdtempSync(join(tmpdir(), "connector-drill-unit-retained-"));
    try {
      expect(
        retainDeployedReceipt(directory, { kind: "pairing", lifecycle: ["revoked"] }, [synthetic.cookieValue]),
      ).toBe(1);
      expect(JSON.parse(readFileSync(join(directory, "receipt.json"), "utf8"))).toEqual({
        kind: "pairing",
        lifecycle: ["revoked"],
      });
      expect(() => retainDeployedReceipt(directory, { leaked: `Bearer ${synthetic.access}` }, ["Bearer "])).toThrow(
        "connector-retained-artifact-secret",
      );
      expect(existsSync(join(directory, "receipt.json"))).toBe(false);
      expect(() =>
        retainDeployedReceipt(directory, { magic: "held-magic-link-value" }, ["held-magic-link-value"]),
      ).toThrow("connector-retained-artifact-secret");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("renders a receipt comment only for deployed staging, never for the fake seam", () => {
    const receipt = { origin: "fake", kind: "staging-smoke" } as DeployedPairingDrillReceipt;
    expect(() => stagingReceiptComment(receipt)).toThrow("connector-drill-fake-receipt-refused");
    expect(stagingReceiptComment({ ...receipt, origin: "staging" })).toContain("### staging-smoke receipt");
  });
});
