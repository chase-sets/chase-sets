import { describe, expect, it, vi } from "vitest";
import type { PgPoolClient, PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { createTcgplayerMarketCapture } from "../api/market-capture";
import { PROVIDER_OBSERVATION_LAUNCH_POLICY_VALUE } from "../domain/provider-observation-policy";
import type { TcgplayerMarketTransport } from "../integrations/tcgplayer/transport-port";

describe("ruled provider market-capture policy order", () => {
  it("commits every signal before capture policy and keeps invalid capture policy off the signal path", async () => {
    const events: string[] = [];
    const pool = new CapturePool(1);
    const transport = fakeTransport(events);
    const run = createTcgplayerMarketCapture({
      pool,
      transport,
      receiptSink: { kind: "not-mounted" },
      now: clock(),
      resolveSignalPolicy: async () => {
        events.push("signal-policy");
        return { revisionId: "signal-r1", value: { productsPerPass: 1 } };
      },
      resolveObservationPolicy: async () => {
        events.push("capture-policy");
        return null;
      },
      resolveStatHygienePolicy: async () => {
        throw new Error("must not resolve after observation policy is invalid");
      },
      recordTcgplayerPriceSignal: async (input) => {
        events.push(`signal:${input.skuId}`);
        return {
          status: "recorded",
          signal: {
            signalId: "sig",
            externalKey: `sku:${input.skuId}`,
            catalogItemId: "cat_synthetic",
            catalogProductKey: "cat_synthetic::",
            status: "current",
            marketPriceAmount: "10.00",
            lowestPriceAmount: "9.00",
            highestPriceAmount: "11.00",
            priceCount: 3,
            calculatedAt: "2026-09-01T15:00:00.000Z",
            observedAt: input.observedAt,
            staleAfter: "2026-09-02T15:00:00.000Z",
          },
        };
      },
    });

    const result = await run();
    expect(result).toMatchObject({ status: "configuration-invalid", signalsRecorded: 1, capturesCommitted: 1 });
    expect(events.indexOf("price-points")).toBeLessThan(events.indexOf("signal:9001"));
    expect(events.indexOf("signal:9001")).toBeLessThan(events.indexOf("capture-policy"));
    expect(events).not.toContain("sales");
    expect(events).not.toContain("listings");
    expect(events).not.toContain("history");
    expect(pool.captureOutcomes).toEqual(["configuration-invalid"]);
    expect(pool.cursor).toEqual({ afterExternalKey: "", generation: 1 });
  });

  it("makes no selection, provider call, capture timestamp, header, or cursor mutation for invalid signal policy", async () => {
    const pool = new CapturePool(1);
    const events: string[] = [];
    const now = vi.fn(clock());
    const run = createTcgplayerMarketCapture({
      pool,
      transport: fakeTransport(events),
      receiptSink: { kind: "not-mounted" },
      now,
      resolveSignalPolicy: async () => null,
      recordTcgplayerPriceSignal: vi.fn(),
    });
    await expect(run()).resolves.toMatchObject({ status: "configuration-invalid", reason: "signal-policy-invalid" });
    expect(pool.selectionCount).toBe(0);
    expect(pool.captureOutcomes).toEqual([]);
    expect(events).toEqual([]);
    expect(now).toHaveBeenCalledTimes(1);
  });

  it("takes one post-signal instant and then bounds only the secondary prefix", async () => {
    const events: string[] = [];
    const pool = new CapturePool(2);
    const run = createTcgplayerMarketCapture({
      pool,
      transport: fakeTransport(events),
      receiptSink: { kind: "not-mounted" },
      now: clock(),
      resolveSignalPolicy: async () => ({ revisionId: "signal-r1", value: { productsPerPass: 2 } }),
      resolveObservationPolicy: async () => {
        events.push("capture-policy");
        return { revisionId: "capture-r1", value: { ...PROVIDER_OBSERVATION_LAUNCH_POLICY_VALUE, capturesPerPass: 1 } };
      },
      resolveStatHygienePolicy: async () => ({ revisionId: "stat-r1" }),
      recordTcgplayerPriceSignal: async (input) => {
        events.push(`signal:${input.skuId}`);
        return { status: "unresolved", reason: "sku-reference-not-mapped", externalKey: `sku:${input.skuId}` };
      },
    });
    const result = await run();
    expect(result.signalWorkCount).toBe(2);
    expect(result.capturesCommitted).toBe(1);
    expect(events.indexOf("signal:9002")).toBeLessThan(events.indexOf("capture-policy"));
    expect(events.filter((event) => event === "sales")).toHaveLength(1);
    expect(pool.cursor.generation).toBe(1);
    expect(pool.cursor.afterExternalKey).toBe("product:7001");
  });
});

class CapturePool implements PgTransactionalPool {
  public cursor = { afterExternalKey: "", generation: 0 };
  public selectionCount = 0;
  public readonly captureOutcomes: string[] = [];
  private readonly products: number;

  constructor(products: number) {
    this.products = products;
  }

  async connect(): Promise<PgPoolClient> {
    return { query: this.query.bind(this), release: () => undefined };
  }

  async query<Row = Record<string, unknown>>(sql: string, params: readonly unknown[] = []) {
    if (sql.includes("FROM pricing_external_catalog_item_reference_inputs")) {
      this.selectionCount += 1;
      return {
        rows: Array.from({ length: this.products }, (_, index) => ({
          external_key: `product:${7001 + index}`,
          catalog_item_id: `cat_synthetic_${index + 1}`,
          sku_external_key: `sku:${9001 + index}`,
          catalog_product_key: `cat_synthetic_${index + 1}::`,
        })) as Row[],
      };
    }
    if (sql.includes("FROM pricing_external_market_capture_cursors")) {
      return {
        rows:
          this.cursor.generation === 0
            ? []
            : [{ after_external_key: this.cursor.afterExternalKey, generation: this.cursor.generation } as Row],
      };
    }
    if (sql.includes("INSERT INTO pricing_external_market_captures")) {
      this.captureOutcomes.push(String(params[16]));
      return { rows: [{ capture_id: String(params[0]) } as Row] };
    }
    if (sql.includes("INSERT INTO pricing_external_market_capture_cursors")) {
      this.cursor = { afterExternalKey: String(params[1]), generation: Number(params[2]) };
    }
    return { rows: [] as Row[] };
  }
}

function fakeTransport(events: string[]): TcgplayerMarketTransport {
  return {
    mpGateway: {
      post: async <TResponse>() => {
        events.push("price-points");
        return [
          {
            skuId: 9001,
            marketPrice: 10,
            lowestPrice: 9,
            highestPrice: 11,
            priceCount: 3,
            calculatedAt: "2026-09-01T15:00:00.000Z",
          },
          {
            skuId: 9002,
            marketPrice: 20,
            lowestPrice: 19,
            highestPrice: 21,
            priceCount: 4,
            calculatedAt: "2026-09-01T15:00:00.000Z",
          },
        ] as TResponse;
      },
    },
    mpApi: {
      post: async <TResponse>() => {
        events.push("sales");
        throw Object.assign(new Error("secret"), { status: 503 }) as TResponse;
      },
    },
    mpSearchApi: {
      post: async <TResponse>() => {
        events.push("listings");
        throw new Error("secret") as TResponse;
      },
    },
    infiniteApi: {
      get: async <TResponse>() => {
        events.push("history");
        throw new Error("secret") as TResponse;
      },
    },
  };
}

function clock() {
  let tick = Date.parse("2026-09-01T14:59:59.000Z");
  return () => new Date((tick += 1_000)).toISOString();
}
