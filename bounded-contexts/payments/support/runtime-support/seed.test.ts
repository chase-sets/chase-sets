import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { seedPaymentsDatabase } from "./seed";

describe("payments seed", () => {
  it("waits for ordering order projections instead of failing bootstrap", async () => {
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((message?: unknown) => {
      logs.push(String(message ?? ""));
    });
    const pool = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("payments_payment_pages")) {
          return { rows: [{ count: "0" }] };
        }
        if (sql.includes("payments_order_inputs")) {
          return { rows: [] };
        }
        return { rows: [] };
      }),
    };

    try {
      await seedPaymentsDatabase(pool as never);
    } finally {
      logSpy.mockRestore();
    }

    expect(logs.join("\n")).toContain("Payments seed is waiting for order ord_seed_checkout_pending to be projected.");
  });

  it("keeps the optional provider observation seed caller source-compatible and byte-identical", async () => {
    const seedSource = readFileSync(new URL("./seed.ts", import.meta.url), "utf8");
    const directCaller = /const services = createPaymentsServices\(pool, \{([\s\S]*?)\n  \}\);/u.exec(seedSource);
    expect(directCaller?.[1]?.trim()).toBe("processorGateway,");

    async function runSeed(): Promise<string> {
      const logs: string[] = [];
      const queries: string[] = [];
      const logSpy = vi.spyOn(console, "log").mockImplementation((message?: unknown) => {
        logs.push(String(message ?? ""));
      });
      const pool = {
        query: vi.fn(async (sql: string) => {
          queries.push(sql);
          if (sql.includes("payments_payment_pages")) {
            return { rows: [{ count: "0" }] };
          }
          return { rows: [] };
        }),
      };

      try {
        await seedPaymentsDatabase(pool as never);
        return JSON.stringify({ logs, queries });
      } finally {
        logSpy.mockRestore();
      }
    }

    expect(await runSeed()).toBe(await runSeed());
  });
});
