import { describe, expect, it, vi } from "vitest";
import { seedApiModuleIfEmpty } from "./seeding";

function createPool() {
  return {
    query: vi.fn(async () => ({ rows: [{ count: "0" }] })),
  };
}

describe("seedApiModuleIfEmpty", () => {
  it("does not run a representative-catalog-only module when options are omitted", async () => {
    const seed = vi.fn(async () => undefined);
    const pool = createPool();

    await seedApiModuleIfEmpty(
      {
        contextName: "catalog",
        streamPrefix: "catalog.",
        seedProfiles: ["representative-catalog"],
        seed,
      },
      pool,
    );

    expect(seed).not.toHaveBeenCalled();
    expect(pool.query).not.toHaveBeenCalled();
  });

  it("runs a representative-catalog-only module when explicitly requested", async () => {
    const seed = vi.fn(async () => undefined);
    const pool = createPool();
    const options = {
      enabledDataProfiles: ["representative-catalog"] as const,
      environmentName: "preview" as const,
    };

    await seedApiModuleIfEmpty(
      {
        contextName: "catalog",
        streamPrefix: "catalog.",
        seedProfiles: ["representative-catalog"],
        seed,
      },
      pool,
      undefined,
      options,
    );

    expect(seed).toHaveBeenCalledOnce();
    expect(seed).toHaveBeenCalledWith(pool, undefined, options);
  });
});
