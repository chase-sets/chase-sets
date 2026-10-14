import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "@chase-sets/typescript-compiler-api";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { vi } from "vitest";
import { connectorPolicyDefaults } from "../../connector-feed/domain/policy";
import { deriveLiveExportId, deriveLiveExportOperationId } from "../../outbound-sync/api/live-export-payload";
import type { ClaimedLiveExportOperation, ClaimedOperationReservation } from "../../outbound-sync/domain/contracts";
import * as liveExportCodec from "../../outbound-sync/domain/live-export-codec";
import { liveExportBounds, liveExportHeaderSha256 } from "../../outbound-sync/domain/live-export-codec";
import * as csvContracts from "../../tcgplayer-csv/domain/contracts";
import * as csv from "../../tcgplayer-csv/domain/csv";
import * as derivedSnapshot from "../../tcgplayer-csv/domain/derived-snapshot";
import { tcgplayerLiveExportHeader } from "../../tcgplayer-csv/domain/profile";
import { createConnectorRetentionStore } from "../domain/connector-retention-store";
import * as authority from "../domain/live-export-authority";
import * as execution from "../domain/live-export-execution";
import * as handoff from "../domain/live-export-handoff";
import { createConnectorOperationCoordinator } from "../domain/operation-coordinator";
import * as protocol from "../domain/operation-protocol";
import { browserPayloadDigest, type ConnectorExecutor } from "../domain/operation-protocol";
import { createTcgplayerLiveExportExecutor } from "../domain/tcgplayer-live-export-executor";
import { createOperationJournal } from "../integrations/connector-indexeddb";
import { retainedRows } from "./raw-retention-test-support";

/** Labelled synthetic hosts only: a loopback provider stand-in and an invalid platform origin. */
export const providerOrigin = "http://127.0.0.1:46175";
export const platformOrigin = "https://synthetic.invalid";
export const sentinel = "SYNTHETIC_9288_PLAINTEXT_SENTINEL";
export const connectionId = "connection_synthetic_9288";
const exportPath = "/Admin/Pricing/DownloadMyExportCSV?type=Pricing";

export function liveExportCsv(
  rows: number,
  options: Readonly<{ header?: readonly string[]; title?: (index: number) => string }> = {},
): string {
  const header = options.header ?? tcgplayerLiveExportHeader;
  const lines = [header.join(",")];
  for (let index = 0; index < rows; index++) {
    const values: Record<string, string> = {
      "TCGplayer Id": String(1000 + index),
      "Product Line": "Synthetic Line",
      "Set Name": "Synthetic Set",
      "Product Name": index === 0 ? sentinel : `Synthetic Card ${index}`,
      Title: options.title?.(index) ?? "",
      Number: String(index),
      Rarity: "Common",
      Condition: "Near Mint",
      "TCG Market Price": "1.00",
      "TCG Direct Low": "",
      "TCG Low Price With Shipping": "1.50",
      "TCG Low Price": "0.90",
      "Total Quantity": "1",
      "Add to Quantity": "0",
      "TCG Marketplace Price": "1.25",
      "Photo URL": "",
    };
    lines.push(header.map((column) => values[column] ?? "").join(","));
  }
  return `${lines.join("\n")}\n`;
}

type ProviderReply = Readonly<{
  status?: number;
  body?: string | Uint8Array<ArrayBuffer> | null;
  contentType?: string | null;
  location?: string;
  reject?: boolean;
  url?: string;
}>;
type Options = Readonly<{
  limits?: Readonly<{ maxBytes: number; maxRecords: number }>;
  executor?: typeof createTcgplayerLiveExportExecutor;
  coordinator?: typeof createConnectorOperationCoordinator;
  executorOrigin?: string;
  advertise?: boolean;
  wrap?: (executor: ConnectorExecutor) => ConnectorExecutor;
}>;

export async function liveExportFixture(options: Options = {}) {
  const indexedDB = new IDBFactory();
  let now = Date.parse("2026-10-13T00:00:00.000Z");
  let authorityState: "paired-idle" | "report-only" | "absent" = "paired-idle";
  const session: Record<string, unknown> = {};
  const sessionPort = {
    setAccessLevel: vi.fn(async () => {}),
    get: vi.fn(async (keys: readonly string[]) =>
      Object.fromEntries(keys.filter((key) => key in session).map((key) => [key, session[key]])),
    ),
    set: vi.fn(async (values: Readonly<Record<string, unknown>>) => {
      Object.assign(session, structuredClone(values));
    }),
    remove: vi.fn(async (keys: readonly string[]) => {
      for (const key of keys) delete session[key];
    }),
  };
  const clock = { now: () => now };
  const scheduleDeadline = vi.fn(async (_when: number) => {});
  const retentionStore = createConnectorRetentionStore({
    indexedDB,
    keyRange: IDBKeyRange,
    session: sessionPort,
    clock,
    scheduleDeadline,
  });
  const store = {
    write: vi.fn(retentionStore.write),
    read: vi.fn(retentionStore.read),
    accept: vi.fn(retentionStore.accept),
  };
  const provider = {
    reply: (_request: Request): ProviderReply => ({ body: liveExportCsv(3) }),
    calls: [] as Request[],
    redirectTargetCalls: 0,
  };
  const platform = {
    claims: [] as unknown[],
    claimBodies: [] as unknown[],
    withheld: 0,
    reports: [] as unknown[],
    posts: [] as string[],
    ingest: async (_body: string): Promise<Response> => new Response("{}", { status: 202 }),
  };
  const request = vi.fn(async (input: Request): Promise<Response> => {
    const url = new URL(input.url);
    if (url.origin === providerOrigin && url.pathname === "/signin") {
      provider.redirectTargetCalls++;
      return new Response("<html>sign in</html>", { headers: { "Content-Type": "text/html" } });
    }
    if (url.origin === providerOrigin && `${url.pathname}${url.search}` === exportPath) {
      provider.calls.push(input);
      const reply = provider.reply(input);
      if (reply.reject) throw new TypeError("synthetic-network-rejection");
      const headers = new Headers();
      if (reply.contentType !== null) headers.set("Content-Type", reply.contentType ?? "text/csv; charset=utf-8");
      if (reply.location) headers.set("Location", reply.location);
      const response = new Response(reply.body === undefined ? null : reply.body, {
        status: reply.status ?? 200,
        headers,
      });
      Object.defineProperty(response, "url", { value: reply.url ?? input.url });
      return response;
    }
    if (url.origin !== platformOrigin) throw new TypeError("synthetic-origin-refused");
    const body = await input.text();
    if (url.pathname.endsWith("/claim")) {
      const parsed = JSON.parse(body) as { capabilities?: string[] };
      platform.claimBodies.push(parsed);
      // Mirrors #9285: a connector that does not advertise the capability receives no export member.
      const capable = parsed.capabilities?.includes("tcgplayer-live-export") === true;
      const reservation = capable ? (platform.claims.shift() ?? null) : null;
      if (!capable && platform.claims.length) platform.withheld++;
      return Response.json({ reservation, pollWindowSeconds: 60 });
    }
    if (url.pathname.endsWith("/report")) {
      platform.reports.push(JSON.parse(body));
      return new Response("{}", { status: 200 });
    }
    if (url.pathname.endsWith("/ingest")) {
      platform.posts.push(body);
      return platform.ingest(body);
    }
    throw new TypeError("synthetic-route-refused");
  });
  const limits = options.limits ?? {
    maxBytes: connectorPolicyDefaults.maxIngestBytes,
    maxRecords: connectorPolicyDefaults.maxIngestRecords,
  };
  async function claim(
    input: Readonly<{
      scheduleGeneration?: number;
      attemptId?: string;
      claimGeneration?: number;
      reservationId?: string;
    }> = {},
  ): Promise<ClaimedOperationReservation<ClaimedLiveExportOperation>> {
    const scheduleGeneration = input.scheduleGeneration ?? 1;
    const exportId = deriveLiveExportId(connectionId, scheduleGeneration);
    const payload: ClaimedLiveExportOperation["payload"] = {
      kind: "live-export",
      version: 1,
      connectionId,
      exportId,
      scheduleGeneration,
      parserProfile: { id: "tcgplayer-live-export/v1", headerSha256: liveExportHeaderSha256 },
      limits,
      bounds: liveExportBounds,
    };
    const at = new Date(now).toISOString();
    return {
      reservationId: input.reservationId ?? "reservation-1",
      connectionId,
      providerIdentity: { providerKey: "tcgplayer", environment: "sandbox" },
      claimant: { claimantKind: "connector", claimantId: "pairing-1" },
      reservedAt: at,
      leaseExpiresAt: new Date(now + connectorPolicyDefaults.leaseMs).toISOString(),
      operations: [
        {
          operationId: deriveLiveExportOperationId(connectionId, scheduleGeneration),
          attemptId: input.attemptId ?? "attempt-1",
          claimGeneration: input.claimGeneration ?? 1,
          connectionId,
          providerIdentity: { providerKey: "tcgplayer", environment: "sandbox" },
          subject: { kind: "connection", connectionId },
          operationKind: "tcgplayer-live-export",
          exportId,
          scheduleGeneration,
          payload,
          payloadDigest: await browserPayloadDigest(payload),
          enqueuedAt: at,
        },
      ],
    };
  }
  const executor = (options.executor ?? createTcgplayerLiveExportExecutor)({
    retentionStore: store,
    request,
    clock,
    providerOrigin: options.executorOrigin ?? providerOrigin,
  });
  const registered = options.wrap ? options.wrap(executor) : executor;
  const executors: ConnectorExecutor[] =
    options.advertise === false ? [{ ...registered, accepts: [["publish", "draft"]] }] : [registered];
  const coordinator = (create = options.coordinator ?? createConnectorOperationCoordinator) =>
    create({ indexedDB, keyRange: IDBKeyRange, executors, platformOrigin, request, clock });
  return {
    indexedDB,
    session,
    store,
    retentionStore,
    scheduleDeadline,
    provider,
    platform,
    request,
    executor,
    claim,
    limits,
    coordinator,
    journal: createOperationJournal(indexedDB, IDBKeyRange),
    input: { connectionId, accessToken: "SYNTHETIC_TOKEN", authority: async () => authorityState },
    rawRows: () => retainedRows(indexedDB),
    now: () => now,
    setNow: (value: number) => {
      now = value;
    },
    setAuthority: (value: typeof authorityState) => {
      authorityState = value;
    },
    /** A browser relaunch loses every session-only key. */
    relaunch: () => {
      for (const key of Object.keys(session)) delete session[key];
    },
    lastOutcome: () => {
      const report = platform.reports.at(-1) as { outcomes: { outcome: Record<string, unknown> }[] } | undefined;
      return report?.outcomes[0]?.outcome;
    },
  };
}

/** One in-memory control rewritten in the executor; every import is the real owner and globals share this realm. */
export function liveExportExecutorMutant(
  rewrites: readonly (readonly [anchor: string, replacement: string])[],
  bindings: Readonly<Record<string, unknown>> = {},
): typeof createTcgplayerLiveExportExecutor {
  let source = readFileSync(new URL("../domain/tcgplayer-live-export-executor.ts", import.meta.url), "utf8");
  for (const [anchor, replacement] of rewrites) {
    if (source.split(anchor).length !== 2) throw new Error(`live-export-mutant-anchor-moved: ${anchor}`);
    source = source.replace(anchor, replacement);
  }
  const modules: Record<string, unknown> = {
    "../../outbound-sync/domain/live-export-codec": liveExportCodec,
    "../../tcgplayer-csv/domain/contracts": csvContracts,
    "../../tcgplayer-csv/domain/csv": csv,
    "../../tcgplayer-csv/domain/derived-snapshot": derivedSnapshot,
    "./live-export-authority": authority,
    "./live-export-handoff": handoff,
    "./live-export-execution": execution,
    "./operation-protocol": protocol,
    ...bindings,
  };
  const exports: Record<string, unknown> = {};
  runInNewContext(
    ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } })
      .outputText,
    {
      exports,
      require: (specifier: string) => {
        if (!Object.hasOwn(modules, specifier)) throw new Error(`live-export-mutant-import-unbound: ${specifier}`);
        return modules[specifier];
      },
      ...Object.fromEntries(
        [
          "AbortSignal",
          "ArrayBuffer",
          "Headers",
          "Request",
          "Response",
          "TextDecoder",
          "TextEncoder",
          "URL",
          "Uint8Array",
          "crypto",
          "structuredClone",
          "setTimeout",
          "clearTimeout",
        ].map((name) => [name, Reflect.get(globalThis, name)]),
      ),
      ...Object.fromEntries(Object.entries(bindings).filter(([name]) => !name.startsWith("."))),
    },
  );
  if (typeof exports.createTcgplayerLiveExportExecutor !== "function") throw new Error("live-export-mutant-missing");
  return exports.createTcgplayerLiveExportExecutor as typeof createTcgplayerLiveExportExecutor;
}
