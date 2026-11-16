import { expect, it } from "vitest";
import {
  assembleAdmittedTcgplayerMarketObservationBatch,
  maxBatchTextBytes,
  maxPartCount,
  splitTcgplayerMarketObservationBatchText,
  tcgplayerMarketObservationBatchAdmitted,
  tcgplayerMarketObservationPartRecorded,
} from "@chase-sets/tcgplayer-market-observations";
import { operatorExtensionContext } from "../api/set-name-observations";
import { describeDb, useOperatorSessionDatabase } from "./db-fixture";
import { composeMarketObservations } from "./market-observation-db-fixture";
import {
  current,
  partBody,
  completionBody,
  batchId,
  streamId,
  provenance,
  text,
  secondaryRequest,
  maximalLaunchBatch,
  smallSecondaryBatch,
  input,
} from "./market-observation-fixture";
import { mutant } from "./market-observation-mutants";

describeDb("market observation admission against the real event store", () => {
  const db = useOperatorSessionDatabase("market_observation_admission");
  it("concurrent identical completions append one admission and replay without a second event", async () => {
    const h = await composeMarketObservations(db());
    expect((await h.part(partBody())).status).toBe(200);
    const body = await completionBody();
    const responses = await Promise.all([h.complete(body), h.complete(body)]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect((await Promise.all(responses.map((response) => response.json()))).map((body) => body.code).sort()).toEqual([
      "admitted",
      "already-admitted",
    ]);
    expect(await (await h.complete(body)).json()).toEqual({ code: "already-admitted" });
    expect(
      (await h.events()).filter((event) => event.event_type === tcgplayerMarketObservationBatchAdmitted),
    ).toHaveLength(1);
    const assembled = await assembleAdmittedTcgplayerMarketObservationBatch(
      (await h.events()).map((event) => ({ streamVersion: event.stream_version, data: event.payload })),
      current,
    );
    expect(JSON.stringify(assembled)).toBe(text);
    expect((await h.complete({ ...body, digest: "0".repeat(64) })).status).toBe(409);
  });
  it("refuses invalid grants and authority loss without admission", async () => {
    const h = await composeMarketObservations(db());
    await h.part(partBody());
    expect((await h.complete(await completionBody(), batchId, "X".repeat(43))).status).toBe(401);
    h.loseAuthority();
    expect(await (await h.complete(await completionBody())).json()).toEqual({ code: "authority-lost" });
    expect(await h.events()).toHaveLength(1);
    h.currentRequest.mockClear();
    const body = await completionBody();
    expect((await h.complete(body)).status).toBe(401);
    expect(h.currentRequest).not.toHaveBeenCalled();
    const bypass = mutant(
      "const grant = await deps.authorizeObservationGrant(input);",
      `const grant = ${JSON.stringify(provenance)};`,
    )(h.deps);
    expect((await bypass.complete(input(body, "POST"), batchId)).status).toBe(200);
  });
  it.each([
    "digest",
    "bytes",
    "missing-part",
    "parse",
    "changed-request",
    "zero-count",
    "count-cap",
    "bytes-count",
    "nonhex",
    "unknown",
  ])("rejects %s without appending", async (failure) => {
    const h = await composeMarketObservations(db());
    const content = failure === "parse" ? "not JSON" : text;
    if (failure !== "missing-part") expect((await h.part(partBody(content))).status).toBe(200);
    const before = await h.events();
    const body = await completionBody(content);
    if (failure === "digest") body.digest = "0".repeat(64);
    if (failure === "bytes") body.textBytes++;
    if (failure === "changed-request") h.setRequest(null);
    if (failure === "zero-count") body.partCount = 0;
    if (failure === "count-cap") {
      body.partCount = maxPartCount(current) + 1;
      body.textBytes = (body.partCount - 1) * 30000 + 1;
    }
    if (failure === "bytes-count") body.textBytes = 30001;
    if (failure === "nonhex") body.digest = "g".repeat(64);
    const response = await h.complete(failure === "unknown" ? { ...body, extra: true } : body);
    expect([400, 409, 413]).toContain(response.status);
    expect(await h.events()).toEqual(before);
  });
  it.each([
    "foreign-type",
    "foreign-batch",
    "partial-payload",
    "duplicate-index",
    "short-part",
    "poisoned-admission",
    "trailing-event",
  ])("rejects %s history rather than accepting event-type idempotency", async (failure) => {
    const request = {
      ...current,
      products: [{ productId: 1, skuIds: Array.from({ length: 250 }, (_, i) => i + 1), skuTargetCount: 250 }],
    };
    const h = await composeMarketObservations(db(), request);
    const payload = { batchId: failure === "foreign-batch" ? current.requestId : batchId, ...partBody(), partIndex: 0 };
    const events = [
      {
        eventType: failure === "foreign-type" ? "foreign.event" : tcgplayerMarketObservationPartRecorded,
        payload: failure === "partial-payload" ? { batchId } : payload,
      },
    ];
    if (failure === "duplicate-index") events.push({ eventType: tcgplayerMarketObservationPartRecorded, payload });
    if (failure === "short-part")
      events.push({ eventType: tcgplayerMarketObservationPartRecorded, payload: { ...payload, partIndex: 1 } });
    if (failure === "poisoned-admission" || failure === "trailing-event")
      events.push({ eventType: tcgplayerMarketObservationBatchAdmitted, payload: { batchId } });
    if (failure === "trailing-event") events.push({ eventType: tcgplayerMarketObservationPartRecorded, payload });
    await h.store.appendToStream({
      streamId,
      expectedVersion: "no_stream",
      context: operatorExtensionContext(provenance),
      events,
    });
    const before = await h.events();
    expect((await h.complete(await completionBody())).status).not.toBe(200);
    expect(await h.events()).toEqual(before);
  });
  it("admits C0's maximal five-product launch batch and reassembles it from all stream pages", async () => {
    const issuedAt = (await db().query<{ now: Date }>("SELECT clock_timestamp() AS now")).rows[0]!.now.toISOString();
    const request = { ...secondaryRequest(), issuedAt };
    const h = await composeMarketObservations(db(), request);
    const batch = maximalLaunchBatch(request);
    const batchText = JSON.stringify(batch);
    expect(batchText.length).toBeLessThanOrEqual(maxBatchTextBytes(request));
    const parts = splitTcgplayerMarketObservationBatchText(batchText);
    expect(parts.length).toBeLessThanOrEqual(maxPartCount(request));
    expect(parts.length).toBeGreaterThan(500);
    await h.store.appendToStream({
      streamId,
      expectedVersion: "no_stream",
      context: operatorExtensionContext(provenance),
      events: parts.map((part, partIndex) => ({
        eventType: tcgplayerMarketObservationPartRecorded,
        payload: { batchId, partIndex, ...partBody(part, request) },
      })),
    });
    expect((await h.complete(await completionBody(batchText, request))).status).toBe(200);
    const events = await h.events();
    expect(events).toHaveLength(parts.length + 1);
    expect(events.at(-1)!.payload).toMatchObject({ ...provenance, partCount: parts.length });
    const assembled = await assembleAdmittedTcgplayerMarketObservationBatch(
      events.map((event) => ({ streamVersion: event.stream_version, data: event.payload })),
      request,
    );
    expect(assembled).toEqual(batch);
  });
  it.each(["observed-missing-response", "request-before-window", "request-after-window", "response-after-window"])(
    "refuses %s endpoint metadata without admission",
    async (failure) => {
      const issuedAt = (await db().query<{ now: Date }>("SELECT clock_timestamp() AS now")).rows[0]!.now.toISOString();
      const request = { ...secondaryRequest(), issuedAt };
      const h = await composeMarketObservations(db(), request);
      const batch = smallSecondaryBatch(request);
      const endpoint = batch.products[0]!.sales;
      if (failure === "observed-missing-response") Object.assign(endpoint, { responseObservedAt: null });
      if (failure === "request-before-window")
        endpoint.requestedAt = new Date(Date.parse(issuedAt) - 120001).toISOString();
      if (failure === "request-after-window") {
        endpoint.requestedAt = new Date(Date.parse(issuedAt) + 3600000).toISOString();
        endpoint.responseObservedAt = endpoint.requestedAt;
      }
      if (failure === "response-after-window")
        endpoint.responseObservedAt = new Date(Date.parse(issuedAt) + 3600000).toISOString();
      const batchText = JSON.stringify(batch);
      for (const [index, part] of splitTcgplayerMarketObservationBatchText(batchText).entries())
        expect((await h.part(partBody(part, request), index)).status).toBe(200);
      const before = await h.events();
      expect((await h.complete(await completionBody(batchText, request))).status).toBe(400);
      expect(await h.events()).toEqual(before);
    },
  );
});
