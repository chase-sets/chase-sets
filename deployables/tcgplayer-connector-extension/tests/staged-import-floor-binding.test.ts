import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import type { composeConnectorBackground } from "../src/compose";
import { chromeFixture, retained, platformOrigin } from "./chrome-test-support";
import { syntheticClaim } from "../__tests__/harness/claim";
import { settlement } from "../__tests__/harness/executors.harness";

type Executor = Parameters<typeof composeConnectorBackground>[0]["executors"][number];
const providerOrigin = "https://synthetic-floor.invalid";
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.doUnmock("../src/host-registry");
});

describe("synthetic staged-import production bootstrap binding, not provider qualification", () => {
  it.each([false, true])(
    "producer removed=%s: real transport/bootstrap/coordinator gates every provider send",
    async (removed) => {
      vi.resetModules();
      vi.doMock("../src/host-registry", () => ({
        connectorHostRegistry: [
          { origin: providerOrigin, capture: "https://github.com/chase-sets/chase-sets/issues/8049#synthetic" },
        ],
      }));
      let monotonic = 0;
      const base = Date.now();
      vi.spyOn(Date, "now").mockImplementation(() => base + monotonic);
      vi.spyOn(performance, "now").mockImplementation(() => monotonic);
      const set = globalThis.setTimeout;
      vi.spyOn(globalThis, "setTimeout").mockImplementation((handler, ms, ...args) => {
        if (ms === 60000 || ms === 59000) {
          monotonic += ms;
          return set(handler, 0, ...args);
        }
        return set(handler, ms, ...args);
      });
      const fixture = chromeFixture(retained("paired-idle"));
      vi.stubGlobal("chrome", fixture.chrome);
      vi.stubGlobal("indexedDB", new IDBFactory());
      vi.stubGlobal("IDBKeyRange", IDBKeyRange);
      vi.stubEnv("VITE_PLATFORM_API_URL", platformOrigin);
      vi.stubEnv("VITE_CONNECTOR_CLIENT_ID", "cc_client_synthetic");
      const claims: unknown[] = [];
      const starts: number[] = [];
      const nonces: string[] = [];
      const reports: unknown[] = [];
      vi.stubGlobal("fetch", async (request: Request) => {
        const url = new URL(request.url);
        if (url.origin === providerOrigin) {
          starts.push(monotonic);
          monotonic += 1000;
          return new Response("synthetic-only");
        }
        expect(url.origin).toBe(platformOrigin);
        if (url.pathname.endsWith("/claim"))
          return Response.json({ reservation: claims.shift() ?? null, pollWindowSeconds: 60 });
        if (url.pathname.endsWith("/report")) {
          reports.push(await request.json());
          return new Response("{}");
        }
        expect(url.pathname).toBe("/channel-connector/oauth/tcgplayer-staged-import-dispatch-policy");
        if (removed) return new Response(null, { status: 404 });
        nonces.push(url.searchParams.get("requestNonce")!);
        return Response.json({
          schemaVersion: 1,
          policyKey: "channels.tcgplayer-staged-import-dispatch",
          unit: "seconds",
          applicability: "founder-staged-import-all-provider-requests",
          connectionId: "connection_A",
          pairingId: "synthetic-pairing",
          reservationId: "synthetic-reservation",
          requestNonce: nonces.at(-1),
          policy: {
            source: "policy",
            documentId: "synthetic-policy",
            effectiveFrom: "2026-01-01T00:00:00Z",
            effectiveUntil: null,
            resolvedAt: new Date(Date.now()).toISOString(),
            value: { minimumRequestStartIntervalSeconds: 60 },
            revision: "a".repeat(64),
          },
        });
      });
      const executor: Executor = {
        key: "synthetic-floor",
        unit: "reservation",
        providerRequests: "tcgplayer-staged-import",
        accepts: [["publish", "draft"]],
        dispatchDeadlineMs: 600000,
        prepare: async (unit) => ({
          ready: true,
          stagedImport: {
            batchDigest: "b".repeat(64),
            composedRows: 1,
            plan: {
              schemaVersion: 1,
              source: "capture-derived",
              captureDigest: "c".repeat(64),
              complete: true,
              polling: false,
              connectionId: unit.reservation.connectionId,
              pairingId: "synthetic-pairing",
              reservationId: unit.reservation.reservationId,
              executorKey: "synthetic-floor",
              membershipDigest: createHash("sha256")
                .update(
                  JSON.stringify(
                    unit.members.map((m) => [m.operationId, m.attemptId, m.claimGeneration, m.payloadDigest]),
                  ),
                )
                .digest("hex"),
              batchDigest: "b".repeat(64),
              composedRows: 1,
              requests: [0, 1, 2].map((i) => ({ requestId: `synthetic-${i}`, maximumDurationMs: 1000 })),
              platformReadMs: 1000,
              parsingMs: 1000,
              reportMs: 1000,
            },
          },
        }),
        dispatchOnce: async (unit, _signal, _pull, send) => {
          if (!send) throw new Error("missing-production-send-port");
          for (const i of [0, 1, 2])
            await send.send(`synthetic-${i}`, new Request(`${providerOrigin}/request`, { redirect: "error" }));
          return {
            outcomes: unit.members.map((m) => {
              if (m.operationKind === "tcgplayer-order-pull") throw new Error("synthetic-listing-only");
              return {
                operationId: m.operationId,
                attemptId: m.attemptId,
                claimGeneration: m.claimGeneration,
                desiredStateSequence: m.desiredStateSequence,
                outcome: { kind: "applied", result: { kind: "succeeded", externalListingId: "synthetic" } },
              };
            }),
            runSettlement: settlement,
          };
        },
      };
      const product = (await import("../src/compose")).composeConnectorBackground({ executors: [executor] });
      await product.background.boot();
      const claim = syntheticClaim(base);
      claims.push({
        ...claim,
        connectionId: "connection_A",
        operations: claim.operations.map((m) => ({ ...m, connectionId: "connection_A" })),
      });
      await fixture.alarm("connector-work");
      expect(starts).toEqual(removed ? [] : [60000, 120000, 180000]);
      expect(reports).toHaveLength(removed ? 0 : 1);
      expect(new Set(nonces).size).toBe(removed ? 0 : 4);
    },
  );
});
