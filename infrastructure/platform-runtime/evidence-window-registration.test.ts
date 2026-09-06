import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createApiHost } from "./api";
import {
  createEvidenceWindowCorrelation,
  createEvidenceWindowRegistrationRoutes,
  createNullEvidenceWindowCorrelation,
  EVIDENCE_WINDOW_ADMISSION_HEADER,
  EVIDENCE_WINDOW_MAX_VERSION,
  EvidenceWindowRegistrationError,
  type EvidenceWindowRegistration,
} from "./evidence-window-registration";
import { createWorkerHost } from "./worker";

const WINDOW_ID = "0123456789abcdef0123456789abcdef";
const ADMISSION_SECRET = "synthetic-window-admission-secret";
type EvidenceManifest = Readonly<{
  contextName: string;
  hostPorts: readonly Readonly<{ portName: string }>[];
}>;
const paymentsManifest = readManifest("../../bounded-contexts/payments/context.json");
const settlementManifest = readManifest("../../bounded-contexts/settlement/context.json");
const orderingManifest = readManifest("../../bounded-contexts/ordering/context.json");

function createRegistration(overrides: Partial<EvidenceWindowRegistration> = {}): EvidenceWindowRegistration {
  return {
    open: vi.fn(async ({ windowId, retentionSeconds }) => ({
      windowId,
      state: "open",
      openedAt: "2026-09-05T20:00:00.000Z",
      expiresAt: new Date(Date.parse("2026-09-05T20:00:00.000Z") + retentionSeconds * 1_000).toISOString(),
      version: 1,
    })),
    current: vi.fn(async () => ({
      windowId: WINDOW_ID,
      expiresAt: "2026-09-05T21:00:00.000Z",
      version: 1,
    })),
    close: vi.fn(async ({ windowId }) => ({
      windowId,
      state: "closed",
      closedAt: "2026-09-05T20:30:00.000Z",
      version: 2,
    })),
    ...overrides,
  };
}

function createRoutes(
  options: Readonly<{
    mode?: "unconfigured" | "test" | "live";
    registration?: EvidenceWindowRegistration;
    authorityProbe?: Parameters<typeof createEvidenceWindowRegistrationRoutes>[0]["authorityProbe"];
  }> = {},
) {
  return createEvidenceWindowRegistrationRoutes({
    admissionSecret: ADMISSION_SECRET,
    authority: {
      effectiveMode: options.mode ?? "test",
      gatewayKinds: { paymentProcessor: "fake", moneyMovement: "fake" },
    },
    registration: options.registration ?? createRegistration(),
    authorityProbe: options.authorityProbe,
  });
}

function admittedHeaders() {
  return {
    "content-type": "application/json",
    [EVIDENCE_WINDOW_ADMISSION_HEADER]: ADMISSION_SECRET,
  };
}

describe("evidence window registration routes", () => {
  it("evaluates admission, immutable Stripe authority, validation, then storage", async () => {
    const sequence: string[] = [];
    const registration = createRegistration({
      open: vi.fn(async (input) => {
        sequence.push("storage");
        return {
          windowId: input.windowId,
          state: "open",
          openedAt: "2026-09-05T20:00:00.000Z",
          expiresAt: "2026-09-05T21:00:00.000Z",
          version: 1,
        };
      }),
    });
    const authorityProbe = vi.fn(() => sequence.push("authority"));
    const routes = createRoutes({ registration, authorityProbe });

    const wrongSecret = await routes.request("/open", {
      method: "POST",
      headers: { "content-type": "application/json", [EVIDENCE_WINDOW_ADMISSION_HEADER]: "wrong" },
      body: JSON.stringify({ windowId: WINDOW_ID, retentionSeconds: 3_600 }),
    });
    await expect(wrongSecret.json()).resolves.toEqual({ error: { code: "evidence-window-admission-rejected" } });
    expect(registration.open).not.toHaveBeenCalled();
    expect(authorityProbe).not.toHaveBeenCalled();

    const admitted = await routes.request("/open", {
      method: "POST",
      headers: admittedHeaders(),
      body: JSON.stringify({ windowId: WINDOW_ID, retentionSeconds: 3_600 }),
    });
    expect(admitted.status).toBe(200);
    await expect(admitted.json()).resolves.toEqual({
      windowId: WINDOW_ID,
      state: "open",
      openedAt: "2026-09-05T20:00:00.000Z",
      expiresAt: "2026-09-05T21:00:00.000Z",
      version: 1,
    });
    expect(sequence).toEqual(["authority", "storage"]);
    expect(authorityProbe).toHaveBeenCalledWith({
      operation: "open",
      effectiveMode: "test",
      gatewayKinds: { paymentProcessor: "fake", moneyMovement: "fake" },
    });
  });

  it("returns byte-identical admission refusals for absent, wrong-length, and equal-length wrong secrets", async () => {
    const routes = createRoutes();
    const request = (secret?: string) =>
      routes.request("/open", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(secret ? { [EVIDENCE_WINDOW_ADMISSION_HEADER]: secret } : {}),
        },
        body: JSON.stringify({ windowId: WINDOW_ID, retentionSeconds: 3_600 }),
      });
    const responses = await Promise.all([request(), request("short"), request("x".repeat(ADMISSION_SECRET.length))]);
    const bodies = await Promise.all(responses.map((response) => response.text()));
    expect(responses.map((response) => response.status)).toEqual([403, 403, 403]);
    expect(new Set(bodies)).toEqual(new Set([bodies[0]]));

    const wrongSecretLiveMode = await createRoutes({ mode: "live" }).request("/open", {
      method: "POST",
      headers: { "content-type": "application/json", [EVIDENCE_WINDOW_ADMISSION_HEADER]: "wrong" },
      body: JSON.stringify({ windowId: WINDOW_ID, retentionSeconds: 3_600 }),
    });
    expect(wrongSecretLiveMode.status).toBe(403);
    await expect(wrongSecretLiveMode.json()).resolves.toEqual({
      error: { code: "evidence-window-admission-rejected" },
    });
  });

  it.each(["live", "unconfigured"] as const)("refuses %s mode before validation or storage", async (mode) => {
    const registration = createRegistration();
    const routes = createRoutes({ mode, registration });
    const responses = await Promise.all([
      routes.request("/open", { method: "POST", headers: admittedHeaders(), body: "not-json" }),
      routes.request("/current?invalid=true", { headers: admittedHeaders() }),
      routes.request(`/${WINDOW_ID}/close`, { method: "POST", headers: admittedHeaders(), body: "not-json" }),
    ]);
    expect(responses.map((response) => response.status)).toEqual([409, 409, 409]);
    for (const response of responses) {
      await expect(response.json()).resolves.toEqual({ error: { code: "evidence-window-mode-not-test" } });
    }
    expect(registration.open).not.toHaveBeenCalled();
    expect(registration.current).not.toHaveBeenCalled();
    expect(registration.close).not.toHaveBeenCalled();
  });

  it("closes every request shape and bounds identities, retention, versions, GET body, and query", async () => {
    const registration = createRegistration();
    const routes = createRoutes({ registration });
    const invalidOpenBodies = [
      { windowId: WINDOW_ID, retentionSeconds: 3_599 },
      { windowId: WINDOW_ID, retentionSeconds: 82_801 },
      { windowId: WINDOW_ID.toUpperCase(), retentionSeconds: 3_600 },
      { windowId: WINDOW_ID, retentionSeconds: 3_600, orderId: "order_1" },
      { windowId: WINDOW_ID, retentionSeconds: 3_600, provider: { secret: "planted" } },
    ];
    for (const body of invalidOpenBodies) {
      const response = await routes.request("/open", {
        method: "POST",
        headers: admittedHeaders(),
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(400);
    }
    for (const path of ["/current?windowId=planted", `/not-an-id/close`]) {
      const response = await routes.request(path, {
        method: path.endsWith("close") ? "POST" : "GET",
        headers: admittedHeaders(),
        ...(path.endsWith("close") ? { body: JSON.stringify({ expectedVersion: 1 }) } : {}),
      });
      expect(response.status).toBe(400);
    }
    const invalidClose = await routes.request(`/${WINDOW_ID}/close`, {
      method: "POST",
      headers: admittedHeaders(),
      body: JSON.stringify({ expectedVersion: 0, releaseObligation: true }),
    });
    expect(invalidClose.status).toBe(400);
    const tooLargeVersion = await routes.request(`/${WINDOW_ID}/close`, {
      method: "POST",
      headers: admittedHeaders(),
      body: JSON.stringify({ expectedVersion: EVIDENCE_WINDOW_MAX_VERSION + 1 }),
    });
    expect(tooLargeVersion.status).toBe(400);
    expect(registration.open).not.toHaveBeenCalled();
    expect(registration.current).not.toHaveBeenCalled();
    expect(registration.close).not.toHaveBeenCalled();
  });

  it("returns exact current and close contracts and probes immutable authority immediately before storage", async () => {
    const sequence: string[] = [];
    const registration = createRegistration({
      current: vi.fn(async () => {
        sequence.push("current-storage");
        return { windowId: WINDOW_ID, expiresAt: "2026-09-05T21:00:00.000Z", version: 1 };
      }),
      close: vi.fn(async ({ windowId }) => {
        sequence.push("close-storage");
        return { windowId, state: "closed", closedAt: "2026-09-05T20:30:00.000Z", version: 2 };
      }),
    });
    const authorityProbe = vi.fn(({ operation }: { operation: string }) => sequence.push(`${operation}-authority`));
    const routes = createRoutes({ registration, authorityProbe });

    const current = await routes.request("/current", { headers: admittedHeaders() });
    expect(current.status).toBe(200);
    await expect(current.json()).resolves.toEqual({
      current: { windowId: WINDOW_ID, expiresAt: "2026-09-05T21:00:00.000Z", version: 1 },
    });
    const close = await routes.request(`/${WINDOW_ID}/close`, {
      method: "POST",
      headers: admittedHeaders(),
      body: JSON.stringify({ expectedVersion: 1 }),
    });
    expect(close.status).toBe(200);
    await expect(close.json()).resolves.toEqual({
      windowId: WINDOW_ID,
      state: "closed",
      closedAt: "2026-09-05T20:30:00.000Z",
      version: 2,
    });
    expect(sequence).toEqual(["current-authority", "current-storage", "close-authority", "close-storage"]);
    expect(authorityProbe).toHaveBeenNthCalledWith(1, {
      operation: "current",
      effectiveMode: "test",
      gatewayKinds: { paymentProcessor: "fake", moneyMovement: "fake" },
    });
  });

  it("accepts both retention boundaries and the largest database version", async () => {
    const registration = createRegistration();
    const routes = createRoutes({ registration });
    for (const retentionSeconds of [3_600, 82_800]) {
      const response = await routes.request("/open", {
        method: "POST",
        headers: admittedHeaders(),
        body: JSON.stringify({ windowId: WINDOW_ID, retentionSeconds }),
      });
      expect(response.status).toBe(200);
    }
    const close = await routes.request(`/${WINDOW_ID}/close`, {
      method: "POST",
      headers: admittedHeaders(),
      body: JSON.stringify({ expectedVersion: EVIDENCE_WINDOW_MAX_VERSION }),
    });
    expect(close.status).toBe(200);
    expect(registration.open).toHaveBeenCalledTimes(2);
    expect(registration.close).toHaveBeenCalledWith({
      windowId: WINDOW_ID,
      expectedVersion: EVIDENCE_WINDOW_MAX_VERSION,
    });
  });

  it("exposes allowlisted error identifiers without exception text", async () => {
    const marker = "synthetic-secret-database-marker";
    const expected = [
      [new EvidenceWindowRegistrationError("evidence-window-already-open"), 409, "evidence-window-already-open"],
      [new EvidenceWindowRegistrationError("evidence-window-unknown"), 404, "evidence-window-unknown"],
      [
        new EvidenceWindowRegistrationError("evidence-window-stale-write-rejected"),
        409,
        "evidence-window-stale-write-rejected",
      ],
      [new Error(marker), 500, "evidence-window-storage-failed"],
    ] as const;
    for (const [error, status, code] of expected) {
      const routes = createRoutes({
        registration: createRegistration({ open: vi.fn(async () => Promise.reject(error)) }),
      });
      const response = await routes.request("/open", {
        method: "POST",
        headers: admittedHeaders(),
        body: JSON.stringify({ windowId: WINDOW_ID, retentionSeconds: 3_600 }),
      });
      expect(response.status).toBe(status);
      const body = await response.text();
      expect(JSON.parse(body)).toEqual({ error: { code } });
      expect(body).not.toContain(marker);
      expect(body).not.toContain(ADMISSION_SECRET);
    }
  });
});

describe("evidence window correlation port", () => {
  it("has exactly one read member, omits version, and has a query-free null implementation", async () => {
    const current = vi.fn(async () => ({
      windowId: WINDOW_ID,
      expiresAt: "2026-09-05T21:00:00.000Z",
      version: 7,
    }));
    const configured = createEvidenceWindowCorrelation({ current });
    const absent = createNullEvidenceWindowCorrelation();
    expect(Object.keys(configured)).toEqual(["currentOpenWindow"]);
    expect(Object.keys(absent)).toEqual(["currentOpenWindow"]);
    await expect(configured.currentOpenWindow()).resolves.toEqual({
      windowId: WINDOW_ID,
      expiresAt: "2026-09-05T21:00:00.000Z",
    });
    await expect(absent.currentOpenWindow()).resolves.toBeNull();
    expect(current).toHaveBeenCalledTimes(1);
  });

  it("filters the supplied port through Payments and Settlement manifests in both public hosts, never Ordering", () => {
    const port = createNullEvidenceWindowCorrelation();
    for (const createHost of [createApiEvidenceHost, createWorkerEvidenceHost]) {
      const services = createHost(port);
      expect(services.payments).toEqual({ evidenceWindowCorrelation: port });
      expect(services.settlement).toEqual({ evidenceWindowCorrelation: port });
      expect(services.ordering).toEqual({});
    }
  });

  it("withholds the port from a context whose manifest declaration is removed", () => {
    const port = createNullEvidenceWindowCorrelation();
    for (const host of ["api", "worker"] as const) {
      for (const omittedContext of ["payments", "settlement"] as const) {
        const registry = createEvidenceRegistry(host, omittedContext);
        const services =
          host === "api"
            ? createApiHost(registry, "platform-api", {
                pools: createPools(),
                hostPorts: { evidenceWindowCorrelation: port },
              }).services
            : createWorkerHost(registry, "platform-worker", {
                pools: createPools(),
                hostPorts: { evidenceWindowCorrelation: port },
              }).services;
        expect(services[omittedContext]).toEqual({});
      }
    }
  });
});

describe("Option A structural boundary", () => {
  it("keeps registration free of recovery, provider payload, and withdrawn background capability", () => {
    const source = readFileSync(new URL("./evidence-window-registration.ts", import.meta.url), "utf8");
    const schema = source.slice(source.indexOf("INSERT INTO evidence_window"), source.indexOf("FROM authority"));
    for (const forbidden of [
      "phase_checkpoint",
      "release_obligation",
      "recordCreatedOrder",
      "order_id",
      "source_identity",
      "provider_object",
      "request_body",
      "owner_id",
      "heartbeat",
      "renewal",
      "setInterval",
      "setTimeout",
      "cron",
      "scheduler",
      "reaper",
    ]) {
      expect(source).not.toContain(forbidden);
      expect(schema).not.toContain(forbidden);
    }
    expect(orderingManifest.hostPorts.map((entry) => entry.portName)).not.toContain("evidenceWindowCorrelation");
    expect(source).toContain('import { verifyPlatformInternalAuthSecret } from "./internal-auth"');
    expect(source).toContain("verifyPlatformInternalAuthSecret(actual, expected)");
    for (const relativePath of [
      "../../deployables/platform-api/src/main.ts",
      "../../deployables/platform-worker/src/main.ts",
    ]) {
      const composition = readFileSync(new URL(relativePath, import.meta.url), "utf8");
      expect(composition).toContain("const evidenceWindowCorrelation =");
      expect(composition).toContain("evidenceWindowCorrelation,");
      expect(composition).toContain("createNullEvidenceWindowCorrelation()");
    }
  });
});

function createApiEvidenceHost(port: unknown) {
  return createApiHost(createEvidenceRegistry("api"), "platform-api", {
    pools: createPools(),
    hostPorts: { evidenceWindowCorrelation: port },
  }).services as Record<string, unknown>;
}

function createWorkerEvidenceHost(port: unknown) {
  return createWorkerHost(createEvidenceRegistry("worker"), "platform-worker", {
    pools: createPools(),
    hostPorts: { evidenceWindowCorrelation: port },
  }).services as Record<string, unknown>;
}

function createEvidenceRegistry(host: "api" | "worker", omittedContext?: "payments" | "settlement") {
  return [paymentsManifest, settlementManifest, orderingManifest].map((manifest) => ({
    contextName: manifest.contextName,
    packageName: `@test/${manifest.contextName}`,
    manifest: {
      contextName: manifest.contextName,
      hostPorts:
        manifest.contextName === omittedContext
          ? manifest.hostPorts.filter((port) => port.portName !== "evidenceWindowCorrelation")
          : manifest.hostPorts,
      ...(host === "api" ? { apiDeployables: ["platform-api"] } : { runtimeDeployables: ["platform-worker"] }),
    },
    module: {
      contextName: manifest.contextName,
      createServices: (_pool: unknown, ports: unknown) => ports ?? {},
    },
  })) as never;
}

function createPools() {
  const query = async () => ({ rows: [], rowCount: 0 });
  const pool = {
    query,
    connect: async () => ({ query, release: () => undefined }),
  };
  return { payments: pool, settlement: pool, ordering: pool };
}

function readManifest(relativePath: string): EvidenceManifest {
  return JSON.parse(readFileSync(new URL(relativePath, import.meta.url), "utf8")) as EvidenceManifest;
}
