import { describe, expect, it } from "vitest";
import { listingAuthorityHistoryConformance } from "./listing-authority-history-conformance";
import { historyFixture } from "./listing-authority-history-test-support";

describe("B-HISTORY-01: synthetic owner with complete setup journals and a shared source-effect stream", () => {
  listingAuthorityHistoryConformance(it, () => historyFixture({ setup: true }));
  it("retains setup journals and distinguishes creation from one effective invalidation", async () => {
    const f = await historyFixture({ setup: true });
    const setup = structuredClone([...f.sourceHistories].filter(([id]) => /-mutation-|-write-/.test(id)));
    expect(setup.length).toBeGreaterThanOrEqual(4);
    const operation = await f.fence.open(f.input, f.context);
    await f.source.prepare(operation, f.context);
    await f.invalidate();
    await f.restart().invalidate();
    for (const [id, events] of setup) expect(f.sourceHistories.get(id)).toEqual(events);
    expect((await f.sourceStore.readStream({ streamId: f.sourceEffectStream })).map((e) => e.eventType)).toEqual([
      "catalog.synthetic-product-created",
      "catalog.synthetic-product-revoked",
    ]);
    expect((await f.fence.inspect(operation)).status).toBe("aborted");
  });
});
