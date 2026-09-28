import { describe, expect, it } from "vitest";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import { managedFixture } from "../tests/managed-fixture";
import { managedWorkFixture } from "../tests/managed-work-fixture";
import { context } from "../../offer-policy/tests/fixtures";

type Fixture = Awaited<ReturnType<typeof managedFixture>>;
const held = (reason = "market-price-unavailable", evidence = {}) => ({ status: "held" as const, reason, evidence });
const stream = (f: Fixture) => f.store.readStream({ streamId: "marketplace.offer-off_one" });
async function preview(f: Fixture) {
  const policy = await f.policies.get("bop_one", "acc_buyer");
  const offers = await Promise.all(
    policy.authority!.offers.map(async (selection) => ({
      ...selection,
      offerVersion: (await f.store.readStream({ streamId: `marketplace.offer-${selection.offerId}` })).length,
    })),
  );
  return f.policies.execute(
    "bop_one",
    {
      type: "PreviewBuyerOfferPolicy",
      expectedVersion: policy.version,
      operationId: `preview_${policy.version}`,
      terms: { ...policy.authority!, offers },
    },
    context,
  );
}
async function authorize(f: Fixture, p: Awaited<ReturnType<typeof preview>>) {
  return f.policies.execute(
    "bop_one",
    {
      type: "AuthorizeBuyerOfferPolicy",
      expectedVersion: p.version,
      operationId: `authorize_${p.version}`,
      previewId: p.preview!.previewId,
      consent: true,
    },
    context,
  );
}
function recovery(f: Fixture) {
  const work = managedWorkFixture(
    f.store,
    [{ offer_id: "off_one", catalog_catalog_item_id: "cat_one", product_id: "cat_one::" }],
    f.offers.applyManagedOfferPage,
  );
  return {
    work,
    cycle: async () => {
      expect(await work.worker().recover(context)).toBe(1);
      expect(await work.worker().run(context)).toBe(1);
      expect(await work.worker().recover(context)).toBe(0);
    },
  };
}

describe("held managed Offer explanation boundaries", () => {
  it("R1/R2: preserves the first evidence across distinct recovery generations and multiple Preview-only events", async () => {
    const f = await managedFixture(createInMemoryEventStore().eventStore);
    f.setTarget(held(undefined, { estimateVersion: "first" }));
    const r = recovery(f);
    await r.cycle();
    const recorded = await stream(f);
    expect(recorded).toHaveLength(3);
    f.setTarget(held(undefined, { estimateVersion: "refreshed" }));
    for (let i = 0; i < 3; i++) await r.cycle();
    expect(r.work.cursor().generation).toBe("4");
    expect(await stream(f)).toEqual(recorded);
    expect(recorded.filter((event) => event.eventType === "marketplace.offer.price-updated")).toEqual([]);
    for (let i = 0; i < 3; i++) {
      const p = await preview(f);
      expect(p.revision).toBe(1);
      expect(p.version).toBe(4 + i);
      await r.cycle();
      expect(await stream(f)).toEqual(recorded);
      if (i === 2) expect((await authorize(f, p)).revision).toBe(2);
    }
    expect((await r.work.workRows()).every((row) => row.status === "completed")).toBe(true);
  });

  it("R2 control: Preview/Authorize succeeds without an intervening recovery", async () => {
    const f = await managedFixture(createInMemoryEventStore().eventStore);
    f.setTarget(held());
    await recovery(f).cycle();
    expect((await authorize(f, await preview(f))).revision).toBe(2);
  });

  it("R3: same-terms fresh consent and A -> B -> A each append once with the actual policy stream version", async () => {
    const f = await managedFixture(createInMemoryEventStore().eventStore);
    f.setTarget(held("A"));
    await f.offers.applyManagedOffer("off_one" as never, "initial", context);
    const p = await preview(f);
    const authorized = await authorize(f, p);
    expect(authorized.revision).toBe(2);
    for (const [index, reason] of ["A", "B", "A"].entries()) {
      f.setTarget(held(reason));
      expect(await f.offers.applyManagedOffer("off_one" as never, `change_${index}`, context)).toEqual({
        status: "held",
        version: 4 + index,
      });
      expect((await stream(f)).at(-1)!.payload).toMatchObject({ reason, policyVersion: authorized.version });
      const recorded = await stream(f);
      await f.offers.applyManagedOffer("off_one" as never, `repeat_${index}`, context);
      expect(await stream(f)).toEqual(recorded);
    }
  });

  it.each(["first hold", "changed reason", "price movement"])(
    "R4: %s after Preview still rejects stale selection; fresh consent succeeds",
    async (change) => {
      const f = await managedFixture(createInMemoryEventStore().eventStore);
      f.setTarget(held("A"));
      if (change !== "first hold") await f.offers.applyManagedOffer("off_one" as never, "initial", context);
      const p = await preview(f);
      f.setTarget(
        change === "price movement" ? { status: "target", unitItemAmount: "12.00", evidence: {} } : held("B"),
      );
      await f.offers.applyManagedOffer("off_one" as never, "change", context);
      await expect(authorize(f, p)).rejects.toThrow("Offer selection is stale.");
      expect((await authorize(f, await preview(f))).revision).toBe(2);
    },
  );

  it("R4: a later real Offer mutation invalidates the held explanation boundary", async () => {
    const f = await managedFixture(createInMemoryEventStore().eventStore);
    f.setTarget(held());
    await f.offers.applyManagedOffer("off_one" as never, "initial", context);
    await f.offers.updateOfferPrice(
      {
        offerId: "off_one" as never,
        buyerAccountId: "acc_buyer" as never,
        priceAmount: "11.00",
        priceCurrencyCode: "USD",
      },
      context,
    );
    const before = await stream(f);
    await f.offers.applyManagedOffer("off_one" as never, "after_edit", context);
    expect(await stream(f)).toHaveLength(before.length + 1);
    await f.offers.applyManagedOffer("off_one" as never, "repeat", context);
    expect(await stream(f)).toHaveLength(before.length + 1);
  });

  it.each(["first", "changed", "applied"])(
    "R5: %s required append conflicts on a Preview-only load/append race",
    async (change) => {
      const f = await managedFixture(createInMemoryEventStore().eventStore);
      f.setTarget(held("A"));
      if (change !== "first") await f.offers.applyManagedOffer("off_one" as never, "initial", context);
      const before = await stream(f);
      f.evaluateTargets.mockImplementationOnce(async () => {
        expect((await preview(f)).revision).toBe(1);
        return [change === "applied" ? { status: "target", unitItemAmount: "12.00", evidence: {} } : held("B")];
      });
      await expect(f.offers.applyManagedOffer("off_one" as never, "racing", context)).rejects.toMatchObject({
        code: "managed_offer_conflict",
      });
      expect(await stream(f)).toEqual(before);
    },
  );

  it("R5: suppression is not permission for acceptance or a later paused-policy mutation", async () => {
    const f = await managedFixture(createInMemoryEventStore().eventStore);
    f.setTarget(held());
    await f.offers.applyManagedOffer("off_one" as never, "initial", context);
    await f.offers.applyManagedOffer("off_one" as never, "repeat", context);
    await expect(f.offers.acceptOffer(await f.acceptance(), context)).rejects.toMatchObject({
      code: "managed_offer_held",
    });
    await f.policies.execute(
      "bop_one",
      { type: "PauseBuyerOfferPolicy", expectedVersion: 3, operationId: "pause" },
      context,
    );
    await expect(f.offers.applyManagedOffer("off_one" as never, "later", context)).rejects.toThrow("active");
    expect(await f.offers.applyManagedOffer("off_one" as never, "initial", context)).toEqual({
      status: "held",
      version: 3,
    });
    expect(await stream(f)).toHaveLength(3);
  });

  it("R5: another Offer's consumption does not change consent, but acceptance still reloads remaining allowance", async () => {
    const f = await managedFixture(createInMemoryEventStore().eventStore);
    f.setTarget(held());
    await f.offers.applyManagedOffer("off_one" as never, "initial", context);
    const recorded = await stream(f);
    f.setTarget({ status: "target", unitItemAmount: "10.00", evidence: {} });
    await f.offers.acceptOffer(await f.acceptance("two"), context);
    f.setTarget(held());
    await f.offers.applyManagedOffer("off_one" as never, "after_consumption", context);
    expect(await stream(f)).toEqual(recorded);
    f.setTarget({ status: "target", unitItemAmount: "10.00", evidence: {} });
    await expect(f.offers.acceptOffer(await f.acceptance(), context)).rejects.toMatchObject({
      code: "managed_offer_held",
    });
    expect((await f.policies.get("bop_one", "acc_buyer")).consumedItemAmount).toBe("20.00");
  });
});
