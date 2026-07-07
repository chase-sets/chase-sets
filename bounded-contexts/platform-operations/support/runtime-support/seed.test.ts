import { describe, expect, it, vi } from "vitest";
import { seedSupportDatabase } from "./seed";

describe("support seed", () => {
  it("waits for support order source projections instead of failing bootstrap", async () => {
    const commandHandler = vi.fn();
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((message?: unknown) => {
      logs.push(String(message ?? ""));
    });
    const services = {
      db: {
        query: vi.fn(async (sql: string) => {
          if (sql.includes("support_request_pages")) {
            return { rows: [{ count: "0" }] };
          }
          if (sql.includes("support_order_sources")) {
            return { rows: [] };
          }
          throw new Error(`Unexpected seed query: ${sql}`);
        }),
      },
      supportRequests: { commandHandler },
    };

    try {
      await seedSupportDatabase({} as never, services as never);
    } finally {
      logSpy.mockRestore();
    }

    expect(commandHandler).not.toHaveBeenCalled();
    expect(logs.join("\n")).toContain(
      "Support seed is waiting for order source ord_seed_offer_ready. Skipping support requests for this pass.",
    );
  });
});
