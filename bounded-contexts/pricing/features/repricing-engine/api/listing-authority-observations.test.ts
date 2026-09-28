import { expect, it } from "vitest";
import { toTransportEvent } from "@chase-sets/event-core/transport";
import { fixture } from "../tests/listing-authority-fixture";
import { pricingListingObservation, readPricingObservations } from "./listing-authority-observations";

it("replays JSON-roundtripped observations idempotently and rejects altered evidence at the same revision", async () => {
  const f = await fixture();
  const history = await f.external.readStream({ streamId: `marketplace.listing-${f.request.listingId}` });
  const event = toTransportEvent(history[0]!);
  await f.authority.observations.observe(JSON.parse(JSON.stringify(event)));
  await expect(
    f.authority.observations.observe({ ...event, data: { ...event.data, priceAmount: "999.00" } }),
  ).rejects.toThrow("reused");
  expect((await readPricingObservations(f.sourceStore, event.streamId)).events).toHaveLength(2);
});

it("does not turn channel accepted leaves or hidden native references into asks", async () => {
  const f = await fixture();
  const history = (await f.external.readStream({ streamId: `marketplace.listing-${f.request.listingId}` })).map(
    toTransportEvent,
  );
  const created = history[0]!;
  const fold = (...events: typeof history) =>
    pricingListingObservation(events.map((event, i) => ({ ...event, streamVersion: i + 1 })));
  const leaf = {
    ...created,
    type: "marketplace.listing.target-price-accepted",
    data: { priceAmount: "999.00", priceCurrencyCode: "USD" },
  };
  expect(fold({ ...created, data: { ...created.data, publicationScope: "channel-only" } }, leaf)).toMatchObject({
    priceAmount: "10.00",
    nativeAsk: false,
    nativePriceRevision: 1,
    status: "draft",
  });
  expect(fold(...history, leaf)).toMatchObject({ priceAmount: "10.00", nativeAsk: true, nativePriceRevision: 1 });
  expect(
    fold(
      ...history,
      { ...created, type: "marketplace.listing.native-visibility-changed", data: { nativeVisibility: "disabled" } },
      leaf,
    ),
  ).toMatchObject({ priceAmount: "10.00", nativeAsk: false });
  expect(
    fold({ ...created, data: { ...created.data, nativeVisibility: "disabled" } }, history[1]!, leaf),
  ).toMatchObject({ nativeAsk: false });
  expect(fold(...history, { ...created, type: "marketplace.listing.inbound-clamp-engaged", data: {} })).toMatchObject({
    status: "paused",
    pauseReason: "channel-inbound-dark",
    nativeAsk: false,
  });
  expect(() => pricingListingObservation([created, { ...leaf, streamVersion: 3 }])).toThrow("incomplete");
});

it("rejects a fabricated native base revision without reserving another budget", async () => {
  const f = await fixture();
  const before = [...f.budgetRows];
  await expect(
    f.authority.evaluate({ ...f.request, evaluationId: "synthetic-wrong-base", basePriceRevision: 9 }, f.context),
  ).rejects.toThrow("base revision");
  expect([...f.budgetRows]).toEqual(before);
});

it("a previously absent competing Listing closes the Product predicate before it can become an ask", async () => {
  const f = await fixture();
  const operation = await f.fence.open(f.input, f.context);
  const grant = await f.source.prepare(operation, f.context);
  const terminal = await f.fence.prepareCommit(operation, [grant], {});
  const [created] = await f.external.appendToStream({
    streamId: "marketplace.listing-lst_synthetic_new",
    expectedVersion: 0,
    context: f.context,
    events: [
      {
        eventType: "marketplace.listing.created",
        payload: {
          listingId: "lst_synthetic_new",
          accountId: "acc_synthetic_other",
          catalogItemId: f.request.catalogItemId,
          productId: f.request.productId,
          inventoryItemId: "inv_synthetic_new",
          priceAmount: "8.00",
          priceCurrencyCode: "USD",
          quantityCap: 1,
        },
      },
    ],
  });
  await f.authority.observations.observe(toTransportEvent(created!));
  expect((await f.fence.inspect(operation)).status).toBe("aborted");
  await expect(f.consumerStore.appendToStreams!(terminal)).rejects.toThrow();
});

it("rejects altered subjects before claiming the single consumer identity", async () => {
  const f = await fixture();
  const malformed = await f.fence.open(
    { ...f.input, requestId: "synthetic-wrong-subject", subject: { ...f.input.subject, quantity: 2 } },
    f.context,
  );
  await expect(f.source.prepare(malformed, f.context)).rejects.toThrow("does not bind");
  const correct = await f.fence.open(f.input, f.context);
  expect((await f.source.prepare(correct, f.context)).operation).toEqual(correct);
});

it("preserves atomic-only append guard restrictions", async () => {
  const f = await fixture();
  for (const guard of [
    { expectedFirstEventId: "evt_synthetic" as const },
    { authorizationDeadline: new Date().toISOString() },
  ]) {
    await expect(
      f.authority.eventStore.appendToStream({
        streamId: "pricing.synthetic",
        expectedVersion: 1,
        events: [],
        context: f.context,
        ...guard,
      }),
    ).rejects.toThrow("atomic appendToStreams");
    await expect(
      f.authority.eventStore.appendToStreamsIndependently!([
        { streamId: "pricing.synthetic", expectedVersion: 1, events: [], context: f.context, ...guard },
      ]),
    ).rejects.toThrow("atomic appendToStreams");
  }
});
