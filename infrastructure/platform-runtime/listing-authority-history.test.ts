import { describe, expect, it } from "vitest";
import { listingAuthorityHistoryConformance } from "./listing-authority-history-conformance";
import { historyFixture } from "./listing-authority-history-test-support";

describe("owner-neutral retained history class sweep", () => listingAuthorityHistoryConformance(it, historyFixture));

describe("synthetic history reader contracts", () => {
  it("infrastructure/platform-runtime/listing-authority-history-test-support.ts#readStream#1", async () => {
    const f = await historyFixture();
    const operation = await f.fence.open(f.input, f.context);
    await expect(f.source.prepare(operation, f.context)).resolves.toMatchObject({ status: "reserved" });
    await f.invalidate();
    const later = await f.fence.open({ ...f.input, requestId: "synthetic-after-effect" }, f.context);
    await expect(f.source.prepare(later, f.context)).rejects.toThrow("Synthetic source revoked.");
  });
  it("infrastructure/platform-runtime/listing-authority-history-conformance.ts#readStream#1", async () => {
    const f = await historyFixture();
    const operation = await f.fence.open(f.input, f.context);
    const grant = await f.source.prepare(operation, f.context);
    const terminal = await f.fence.prepareCommit(operation, [grant], { accepted: true });
    await f.invalidate();
    const effect = {
      streamId: "marketplace.synthetic-effect",
      expectedVersion: 0,
      context: f.context,
      events: [{ eventType: "marketplace.synthetic-effect", payload: {} }],
    };
    await expect(f.consumerStore.appendToStreams!([...terminal, effect])).rejects.toThrow();
    expect(await f.consumerStore.readStream({ streamId: effect.streamId })).toHaveLength(0);
    await f.consumerStore.appendToStream(effect);
    expect(await f.consumerStore.readStream({ streamId: effect.streamId })).toHaveLength(1);
  });
});
