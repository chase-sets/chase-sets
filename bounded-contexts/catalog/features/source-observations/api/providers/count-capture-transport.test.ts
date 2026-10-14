import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { createCatalogServices } from "../../../../support/authoring-support/services";
import {
  CountCaptureStopped,
  runCountCaptureRequest,
  runCountCaptureUsage,
  type CountCaptureBinding,
  type CountCaptureSend,
} from "./count-capture-transport";
import { createProviderSendAdmission, runCatalogProviderWork, sendCatalogProviderRequest } from "./provider-send-admission";
import {
  acquireScrydexPageOneCount,
  createScrydexOnePieceProviderAdapter,
  scrydexCountQuery,
  SCRYDEX_ONE_PIECE_SET_REFERENCE_DATA_UNIT_KEY,
} from "./scrydex/adapter";

// Credential-free loopback: the guard classifies the real Scrydex target, and the
// test transport alone rewrites that origin to a local server it can observe.
const scrydex = "https://api.scrydex.com";
const credentials = { apiKey: "synthetic-capture-key", teamId: "synthetic-capture-team" };
const usageUrl = `${scrydex}/account/v1/usage`;
type Reply = "ok" | "redirect" | "error" | "hang";
let server: Server;
let origin: string;
let reply: Reply = "ok";
const hits: string[] = [];

beforeAll(async () => {
  server = createServer((request, response) => {
    hits.push(request.url ?? "");
    if (request.url === "/followed") return void response.writeHead(200).end("{}");
    if (reply === "hang") return;
    if (reply === "redirect") return void response.writeHead(302, { Location: `${origin}/followed` }).end();
    response.writeHead(reply === "error" ? 500 : 200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: [], total_count: 0, page_size: 100, page: 1 }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function fixture(phase: CountCaptureBinding["phase"] = "preview", next: Reply = "ok") {
  reply = next;
  hits.length = 0;
  const order: string[] = [];
  const debits: CountCaptureSend[] = [];
  const ledger = {
    debit: vi.fn(async (_binding: CountCaptureBinding, send: CountCaptureSend) => {
      order.push("debit");
      debits.push(send);
      return debits.length;
    }),
    result: vi.fn(async (_binding: CountCaptureBinding, _sequence: number, _status: number) => {
      order.push("result");
    }),
    stop: vi.fn(async (_binding: CountCaptureBinding) => {
      order.push("stop");
    }),
  };
  const transport = vi.fn<typeof fetch>(async (input, init) => {
    order.push("transport");
    const target = input instanceof Request ? input.url : String(input);
    return fetch(target.replace(scrydex, origin), init);
  });
  const binding: CountCaptureBinding = {
    runId: "00000000-0000-4000-8000-000000000001",
    requestId: "00000000-0000-4000-8000-000000000002",
    phase,
  };
  const run = <T>(work: () => Promise<T>) => runCountCaptureRequest({ binding, ledger }, work);
  const send = (url = usageUrl, category: Parameters<typeof sendCatalogProviderRequest>[4] = "usage", init?: RequestInit) =>
    sendCatalogProviderRequest("scrydex", transport, url, init, category);
  return { ledger, transport, debits, order, run, send };
}

const countQuery = (kind: "cards" | "sealed") =>
  scrydexCountQuery({
    environment: "staging",
    accountRevision: "runtime",
    productDomain: "one-piece",
    profileKey: `synthetic-${kind}`,
    profileVersion: "1",
    unitKey: `scrydex:one-piece:${kind === "cards" ? "single-card" : "sealed-product"}:source-observation-import`,
    kind,
    languageCode: "en",
    parentValue: "OP01",
  });

describe("refuses unsafe sends", () => {
  it.each(["cards", "sealed"] as const)("debits a %s count before its one manual-redirect send", async (kind) => {
    const f = fixture("acquisition");
    const query = countQuery(kind);
    await f.run(() => acquireScrydexPageOneCount(query, { fetch: f.transport, credentials }));
    expect(f.debits).toEqual([{ category: kind, requestFingerprint: query.requestFingerprint }]);
    expect(f.order).toEqual(["debit", "transport", "result"]);
    expect(f.transport.mock.calls[0]?.[1]?.redirect).toBe("manual");
    expect(f.ledger.result).toHaveBeenCalledWith(expect.anything(), 1, 200);
    expect(hits).toHaveLength(1);
  });

  it("tags usage reads with their purpose and unit", async () => {
    const f = fixture("bootstrap");
    await f.run(() => createScrydexOnePieceProviderAdapter({ fetch: f.transport, credentials }).getUsageSnapshot());
    const preview = fixture("preview");
    await preview.run(() =>
      createScrydexOnePieceProviderAdapter({ fetch: preview.transport, credentials }).planImport({
        unitKey: SCRYDEX_ONE_PIECE_SET_REFERENCE_DATA_UNIT_KEY,
        scopeKey: "set-reference",
        values: { expansionId: "OP01" },
      }),
    );
    expect([...f.debits, ...preview.debits].map((send) => send.usage)).toEqual([
      { purpose: "bootstrap" },
      { purpose: "planImport", unitKey: SCRYDEX_ONE_PIECE_SET_REFERENCE_DATA_UNIT_KEY },
    ]);
  });

  it.each([
    ["another provider", "tcgdex", usageUrl, "usage", undefined],
    ["another origin", "scrydex", "https://attacker.invalid/account/v1/usage", "usage", undefined],
    ["another port", "scrydex", "https://api.scrydex.com:8443/account/v1/usage", "usage", undefined],
    ["plain http", "scrydex", "http://api.scrydex.com/account/v1/usage", "usage", undefined],
    ["embedded credentials", "scrydex", "https://user:pass@api.scrydex.com/account/v1/usage", "usage", undefined],
    ["a fragment", "scrydex", `${usageUrl}#x`, "usage", undefined],
    ["a non-GET method", "scrydex", usageUrl, "usage", { method: "POST" }],
    ["an unclassified category", "scrydex", usageUrl, undefined, undefined],
    ["an unknown category", "scrydex", `${scrydex}/onepiece/v1/expansions`, "discovery", undefined],
    ["a usage query", "scrydex", `${usageUrl}?extra=1`, "usage", undefined],
    ["usage spoofed as a count", "scrydex", usageUrl, "card-force", undefined],
    ["a count spoofed as usage", "scrydex", `${scrydex}/onepiece/v1/cards?page=1&page_size=250&q=printings:OP01&select=id`, "usage", undefined],
    ["a second count page", "scrydex", `${scrydex}/onepiece/v1/cards?page=2&page_size=250&q=printings:OP01&select=id`, "card-force", undefined],
    ["an extra count key", "scrydex", `${scrydex}/onepiece/v1/cards?page=1&page_size=250&q=printings:OP01&select=id&x=1`, "card-force", undefined],
    ["a card search that is not a set count", "scrydex", `${scrydex}/onepiece/v1/cards?page=1&page_size=250&q=name:x&select=id`, "card-force", undefined],
    ["another product domain", "scrydex", `${scrydex}/lorcana/v1/cards?page=1&page_size=250&q=printings:OP01&select=id`, "card-force", undefined],
  ] as const)("refuses %s before any debit or transport", async (_label, provider, url, category, init) => {
    const f = fixture();
    await expect(
      f.run(() => sendCatalogProviderRequest(provider, f.transport, url, init, category)),
    ).rejects.toBeInstanceOf(CountCaptureStopped);
    expect(f.ledger.debit).not.toHaveBeenCalled();
    expect(f.transport).not.toHaveBeenCalled();
    expect(f.ledger.stop).toHaveBeenCalled();
  });

  it.each([
    ["a redirect", "redirect"],
    ["a non-2xx status", "error"],
    ["a timeout", "hang"],
  ] as const)("stops on %s, retains the debit and follows nothing", async (_label, next) => {
    const f = fixture("preview", next);
    const sent = f.run(() => runCountCaptureUsage({ purpose: "readiness" }, () => f.send(usageUrl, "usage", { signal: AbortSignal.timeout(200) })));
    await expect(sent).rejects.toBeInstanceOf(CountCaptureStopped);
    expect(f.order).toEqual(["debit", "transport", "stop"]);
    expect(f.debits).toHaveLength(1);
    expect(hits).toEqual(["/account/v1/usage"]);
  });

  it("stops on an abort or a transport exception", async () => {
    const aborted = fixture("preview", "hang");
    const controller = new AbortController();
    const sent = aborted.run(() => aborted.send(usageUrl, "usage", { signal: controller.signal }));
    await vi.waitFor(() => expect(hits).toHaveLength(1));
    controller.abort();
    await expect(sent).rejects.toBeInstanceOf(CountCaptureStopped);
    const thrown = fixture();
    thrown.transport.mockImplementationOnce(async () => {
      thrown.order.push("transport");
      throw new TypeError("synthetic connection reset");
    });
    await expect(thrown.run(() => thrown.send())).rejects.toBeInstanceOf(CountCaptureStopped);
    for (const f of [aborted, thrown]) {
      expect(f.order).toEqual(["debit", "transport", "stop"]);
      expect(f.ledger.result).not.toHaveBeenCalled();
    }
  });

  it("makes zero transport calls when the pre-send debit fails", async () => {
    const f = fixture();
    f.ledger.debit.mockRejectedValueOnce(new Error("synthetic debit commit failure"));
    await expect(f.run(() => f.send())).rejects.toBeInstanceOf(CountCaptureStopped);
    expect(f.transport).not.toHaveBeenCalled();
    expect(hits).toHaveLength(0);
    expect(f.ledger.stop).toHaveBeenCalledTimes(1);
  });

  it("keeps one possible-send debit and sends nothing later when the result commit fails", async () => {
    const f = fixture();
    f.ledger.result.mockRejectedValueOnce(new Error("synthetic result commit failure"));
    f.ledger.stop.mockRejectedValue(new Error("synthetic stop commit failure"));
    const swallowed: unknown[] = [];
    const outcome = f.run(async () => {
      for (const attempt of [1, 2]) await f.send().catch((error: unknown) => swallowed.push([attempt, error]));
      return "adapter swallowed every failure";
    });
    await expect(outcome).rejects.toBeInstanceOf(CountCaptureStopped);
    expect(f.debits).toHaveLength(1);
    expect(f.transport).toHaveBeenCalledTimes(1);
    expect(hits).toHaveLength(1);
    expect(swallowed).toHaveLength(2);
    expect(f.order.filter((step) => step === "debit")).toHaveLength(1);
  });

  it("refuses a nested capture request", async () => {
    const f = fixture();
    await expect(f.run(() => f.run(() => f.send()))).rejects.toBeInstanceOf(CountCaptureStopped);
    expect(f.transport).not.toHaveBeenCalled();
  });

  it("guards sends inside an unrelated provider-send context", async () => {
    const f = fixture("preview", "redirect");
    const admission = createProviderSendAdmission({ enabled: false, ledger: {} as never });
    await expect(
      f.run(() => runCatalogProviderWork(admission, () => f.send(usageUrl, "usage"), null)),
    ).rejects.toBeInstanceOf(CountCaptureStopped);
    expect(f.order).toEqual(["debit", "transport", "stop"]);
    expect(hits).toEqual(["/account/v1/usage"]);
  });
});

describe("capture guard is inert when unbound", () => {
  it("passes ordinary sends through with the caller's exact arguments", async () => {
    const f = fixture("preview", "redirect");
    const init = { headers: { Accept: "application/json" } };
    const response = await runCountCaptureUsage({ purpose: "readiness" }, () =>
      sendCatalogProviderRequest("scrydex", f.transport, usageUrl, init, "usage"),
    );
    expect(f.transport).toHaveBeenCalledWith(usageUrl, init);
    expect(response.status).toBe(200);
    expect(hits).toEqual(["/account/v1/usage", "/followed"]);
    expect(f.ledger.debit).not.toHaveBeenCalled();
  });

  it("composes a capture store only for staging", async () => {
    const pool = { query: vi.fn(), connect: vi.fn() } as unknown as PgTransactionalPool;
    const previous = process.env.DEPLOYMENT_ENVIRONMENT;
    try {
      for (const [environment, present] of [
        ["production", false],
        ["test", false],
        ["staging", true],
      ] as const) {
        process.env.DEPLOYMENT_ENVIRONMENT = environment;
        expect(Boolean(createCatalogServices(pool).countCapture)).toBe(present);
      }
    } finally {
      if (previous === undefined) delete process.env.DEPLOYMENT_ENVIRONMENT;
      else process.env.DEPLOYMENT_ENVIRONMENT = previous;
    }
    expect(pool.query).not.toHaveBeenCalled();
  });
});
