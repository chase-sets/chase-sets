import { describe, expect, it } from "vitest";
import { authorizationResultSchema } from "../../domain/contracts";
import { balance, card, context, fixture, identity, instrument, snapshot } from "../../tests/fixtures";
import { buildInstrumentProjection } from "./instrument-projection";

describe("Buyer payment instrument mirror", () => {
  it.each([[[]], [[instrument(card.instrumentId, "card", "setup-required")]]])(
    "hands removal or setup-required to reconciliation after version fencing (case %#)",
    async (replacement) => {
      const f = fixture();
      await f.activate();
      const signals: string[] = [];
      const handler = buildInstrumentProjection(async (_db, event) => {
        signals.push(String(event.data.accountId));
      })["payments.checkout-affordances-published"]!;
      const apply = (version: number, instruments: readonly ReturnType<typeof instrument>[]) =>
        handler(snapshot(version, instruments), { db: f.db });
      await apply(1, [instrument()]);
      const preview = authorizationResultSchema.parse(
        await f.runtime.execute({ ...identity(0), type: "preview", source: card }, context),
      );
      const authorized = await f.runtime.execute(
        { ...identity(preview.version), type: "authorize", previewId: preview.preview!.previewId, consent: true },
        context,
      );
      await f.runtime.reconcile(context);
      expect(authorized.state).toBe("active");
      await apply(3, replacement);
      await apply(2, [instrument()]);
      await apply(3, replacement);
      expect(signals).toEqual([context.audit.forAccountId, context.audit.forAccountId]);
      expect(f.versions.get(context.audit.forAccountId)).toBe(3);
      await f.runtime.reconcile(context);
      await f.runtime.reconcile(context);
      const events = await f.store.readStream({ streamId: authorized.authorizationId });
      expect(events.filter((event) => event.eventType.endsWith(".payment-method-unavailable"))).toHaveLength(1);
      await f.project();
      expect(await f.runtime.read(context.audit.forAccountId)).toMatchObject({
        state: "payment-method-unavailable",
        eligibleInstruments: [],
      });
      const resumed = await f.runtime.execute(
        { ...identity(events.at(-1)!.streamVersion), type: "resume", source: balance },
        context,
      );
      await apply(4, []);
      await f.runtime.reconcile(context);
      await f.runtime.markPaymentMethodUnavailable(1, card.instrumentId, context);
      await f.project();
      expect(resumed.generation).toBe(2);
      expect(await f.runtime.read(context.audit.forAccountId)).toMatchObject({
        state: "active",
        generation: 2,
        source: balance,
      });
    },
  );
});
