import { expect, it } from "vitest";
import {
  maxPartCount,
  PART_TEXT_MAX_BYTES,
  tcgplayerMarketObservationBatchAdmitted,
  tcgplayerMarketObservationPartRecorded,
} from "@chase-sets/tcgplayer-market-observations";
import { operatorExtensionContext } from "../api/set-name-observations";
import { describeDb, useOperatorSessionDatabase } from "./db-fixture";
import { composeMarketObservations } from "./market-observation-db-fixture";
import { current, partBody, completionBody, batchId, streamId, provenance, input } from "./market-observation-fixture";
import { MARKET_OBSERVATION_BODY_MAX_BYTES } from "../api/market-observations";
import { mutant } from "./market-observation-mutants";

describeDb("market observation parts against the real event store", () => {
  const db = useOperatorSessionDatabase("market_observation_parts");
  it("appends in order, distinguishes identical replay and conflict, then closes on admission", async () => {
    const h = await composeMarketObservations(db());
    expect((await h.part(partBody(), 1)).status).toBe(413); // current price-points request has a one-part cap
    expect((await h.part(partBody())).status).toBe(200);
    expect(await (await h.part(partBody())).json()).toEqual({ code: "part-already-recorded" });
    expect(await (await h.part(partBody("different"))).json()).toEqual({ code: "part-conflict" });
    expect(await h.events()).toHaveLength(1);
    expect((await h.complete(await completionBody())).status).toBe(200);
    expect(await (await h.part(partBody())).json()).toEqual({ code: "batch-closed" });
    expect((await h.events()).map((event) => event.event_type)).toEqual([
      tcgplayerMarketObservationPartRecorded,
      tcgplayerMarketObservationBatchAdmitted,
    ]);
  });
  it("competing identical first parts append exactly once", async () => {
    const h = await composeMarketObservations(db());
    const responses = await Promise.all([h.part(partBody()), h.part(partBody())]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(await h.events()).toHaveLength(1);
  });
  it("refuses invalid grants and lost creator authority before source and event work", async () => {
    const h = await composeMarketObservations(db());
    expect((await h.part(partBody(), 0, batchId, "X".repeat(43))).status).toBe(401);
    h.loseAuthority();
    expect(await (await h.part(partBody())).json()).toEqual({ code: "authority-lost" });
    expect(await h.events()).toEqual([]);
    expect(h.currentRequest).not.toHaveBeenCalled();
    const bypass = mutant(
      "const grant = await deps.authorizeObservationGrant(input);",
      `const grant = ${JSON.stringify(provenance)};`,
    )(h.deps);
    expect((await bypass.part(input(partBody()), batchId, "0")).status).toBe(200);
  });
  it("refuses out-of-order and cap indices independently on a multipart request", async () => {
    const request = {
      ...current,
      products: [{ productId: 1, skuIds: Array.from({ length: 250 }, (_, i) => i + 1), skuTargetCount: 250 }],
    };
    const h = await composeMarketObservations(db(), request);
    expect(maxPartCount(request)).toBeGreaterThan(1);
    expect(await (await h.part(partBody(), 1)).json()).toEqual({ code: "part-out-of-order" });
    expect(await (await h.part(partBody(), maxPartCount(request))).json()).toEqual({ code: "batch-too-large" });
    expect(await h.events()).toEqual([]);
  });
  it("refuses a changed request and rejects foreign, partial, or poisoned stream histories", async () => {
    const h = await composeMarketObservations(db());
    h.setRequest({ ...current, requestId: batchId });
    expect(await (await h.part(partBody())).json()).toEqual({ code: "request-not-current" });
    h.setRequest(current);
    const partial = { batchId, ...partBody(), partIndex: 0 };
    await h.store.appendToStream({
      streamId,
      expectedVersion: "no_stream",
      context: operatorExtensionContext(provenance),
      events: [{ eventType: "foreign.event", payload: partial }],
    });
    expect((await h.part(partBody())).status).toBe(409);
    expect(await h.events()).toHaveLength(1);
  });
  it.each([
    [batchId.toUpperCase(), "0"],
    [batchId + "a", "0"],
    ...["-1", "01", "1.5", "12345678901234567"].map((index) => [batchId, index]),
  ])("validates path %s/%s without a grant lookup", async (id, index) => {
    const h = await composeMarketObservations(db());
    expect((await h.part(partBody(), index, id)).status).toBe(400);
    expect(h.grantLookups()).toBe(0);
    expect(await h.events()).toEqual([]);
    expect(h.currentRequest).not.toHaveBeenCalled();
  });
  it.each([
    { ...partBody(), unknown: 1 },
    { requestId: current.requestId, phase: current.phase },
    partBody(""),
    partBody("a".repeat(PART_TEXT_MAX_BYTES + 1)),
  ])("rejects a closed-body violation with no append", async (body) => {
    const h = await composeMarketObservations(db());
    expect(await (await h.part(body)).json()).toEqual({ code: "invalid-body" });
    expect(await h.events()).toEqual([]);
    expect(h.currentRequest).not.toHaveBeenCalled();
  });
  it("bounds cap+1 and endless bodies without event-store work", async () => {
    const h = await composeMarketObservations(db());
    const request = (body: ReadableStream<Uint8Array>) =>
      input(body, "PUT", { authorization: `Bearer ${"S".repeat(43)}` });
    const over = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array(MARKET_OBSERVATION_BODY_MAX_BYTES + 1));
      },
      cancel() {
        return new Promise(() => {});
      },
    });
    expect((await h.services.marketObservations.part(request(over), batchId, "0")).status).toBe(413);
    const endless = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array([123]));
      },
      cancel() {
        return new Promise(() => {});
      },
    });
    expect((await h.services.marketObservations.part(request(endless), batchId, "0")).status).toBe(408);
    expect(await h.events()).toEqual([]);
  });
});
