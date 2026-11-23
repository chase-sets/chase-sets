import { describe, expect, it } from "vitest";
import { toTransportEvent } from "@chase-sets/event-core/transport";
import { balance, card, context, fakeProjectionDb, fixture, identity, instrument, snapshot } from "../tests/fixtures";
import { buildInstrumentProjection } from "../integrations/payments/instrument-projection";
import { buildAuthorizationProjection } from "./projection";

describe("Offer Payment Authorization standing", () => {
  it("publishes one closed, payment-free standing fact per state change and rebuilds the private projection", async () => {
    const f = fixture();
    await f.activate();
    await buildInstrumentProjection(async () => {})["payments.checkout-affordances-published"]!(
      snapshot(1, [instrument()]),
      { db: f.db },
    );
    await f.runtime.markRequired(context);
    const buyerAccountId = context.audit.forAccountId;
    const streamId = `marketplace.offer-payment-authorization-${buyerAccountId}`;
    const version = async () => (await f.store.readStream({ streamId })).at(-1)?.streamVersion ?? 0;
    const preview = await f.runtime.execute({ ...identity(await version()), type: "preview", source: card }, context);
    await f.runtime.execute(
      { ...identity(preview.version), type: "authorize", previewId: preview.preview!.previewId, consent: true },
      context,
    );
    await f.runtime.markPaymentMethodUnavailable(1, card.instrumentId, context);
    await f.runtime.holdForFailedPayment("ord_held", 1, context);
    await f.runtime.execute({ ...identity(await version()), type: "resume", source: balance }, context);
    await f.runtime.execute({ ...identity(await version()), type: "revoke" }, context);
    const events = await f.store.readStream({ streamId });
    const states = ["none", "active", "payment-method-unavailable", "held", "active", "revoked"];
    const standing = events.filter((event) => event.eventType === "marketplace.offer-payment-authorization.changed");
    expect(standing.map((event) => event.payload)).toEqual(
      states.map((state, index) => ({
        buyerAccountId,
        state,
        available: state === "active",
        streamVersion: standing[index]?.streamVersion,
      })),
    );
    await f.project();
    const fresh = fakeProjectionDb();
    const handlers = buildAuthorizationProjection(fresh.db);
    for (const event of [...events, ...events]) await handlers[event.eventType]?.(toTransportEvent(event));
    expect(fresh.authorizations).toEqual(f.authorizations);
    expect(fresh.authorizations.get(buyerAccountId)).toMatchObject({
      state: "revoked",
      generation: 2,
      latest_held_order_id: "ord_held",
      stream_version: await version(),
    });
  });
});
