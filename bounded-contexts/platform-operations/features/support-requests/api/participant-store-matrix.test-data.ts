import { expect, it, vi } from "vitest";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import { readCompleteStream } from "@chase-sets/event-core/complete-stream";
import type { EventStore } from "@chase-sets/event-core/event-store";
import {
  decideSupportRequest,
  evolveSupportRequest,
  initialSupportRequestState,
  type SupportRequestCommand,
  type SupportRequestEvent,
} from "../domain/domain";
import { participantActions, type ParticipantAction } from "../domain/participant-attempt";
import { evidenceActor } from "../domain/evidence-access-policy.test-support";
import { actorContext, buyer, participantFixture, openBody, attemptId } from "./participant-attempt.test-support";
import { validateParticipantHistory } from "./participant-runtime";

const seller = evidenceActor("viewer", ["support.view", "support.manage"], false, "acc_seller");
const codec = createPassthroughDomainEventCodec<SupportRequestEvent>();
async function appendCommand(store: EventStore, id: string, command: SupportRequestCommand) {
  const events = await readCompleteStream(store, { streamId: `support.support-request-${id}` });
  const state = events.reduce((s, event) => evolveSupportRequest(s, codec.decode(event)), initialSupportRequestState);
  const facts = await decideSupportRequest(state, command);
  await store.appendToStream({
    streamId: `support.support-request-${id}`,
    expectedVersion: events.length,
    context: actorContext(buyer),
    events: facts.map(codec.encode),
  });
}
async function seedCase(store: EventStore, id: string) {
  await appendCommand(store, id, {
    type: "OpenSupportRequest",
    supportRequestId: id as never,
    orderId: "ord_case" as never,
    orderTotalAmount: "24.00",
    buyerAccountId: buyer.accountId as never,
    sellerAccountId: seller.accountId as never,
    flowType: "product-not-as-described",
    openedByAccountId: buyer.accountId as never,
    openedByRole: "buyer",
    openedAt: "2026-10-12T12:00:00.000Z",
  });
}
async function seedOffer(store: EventStore, id: string, returning = false) {
  await appendCommand(store, id, {
    type: "RecordSupportResponse",
    responseId: "srp_offer",
    offerId: "sof_offer",
    submittedByAccountId: seller.accountId as never,
    submittedByRole: "seller",
    responseType: returning ? "accept-return" : "offer-partial-refund",
    offerResolutionType: returning ? "return-for-refund" : "partial-refund",
    refundAmount: returning ? null : "6.00",
    summary: "Offer",
    submittedAt: "2026-10-12T12:00:01.000Z",
  });
}
async function seedAcceptance(store: EventStore, id: string) {
  await appendCommand(store, id, {
    type: "AcceptSupportOffer",
    offerId: "sof_offer",
    acceptedByAccountId: buyer.accountId as never,
    acceptedByRole: "buyer",
    acceptedAt: "2026-10-12T12:00:02.000Z",
  });
}
export function participantStoreMatrix(makeStore: () => EventStore) {
  it("legacy seed audit tenants preserve authorized seller response and buyer acceptance recovery", async () => {
    const store = makeStore();
    const f = participantFixture(store);
    const seedActor = { ...buyer, tenantId: "tnt_seed_development" };
    const opened = await f.runtime.openSupportRequest(
      { accountId: buyer.accountId, orderId: openBody.orderId, flowType: "product-not-as-described" },
      actorContext(seedActor),
    );
    const body = {
      responseType: "offer-partial-refund",
      summary: "Keep the item and receive a partial refund.",
      offerResolutionType: "partial-refund",
      refundAmount: "5.00",
    };
    const response = await f.executeParticipant("record-response", body, opened.supportRequestId, attemptId, seller);
    const count = (await readCompleteStream(store, { streamId: `support.support-request-${response.id}` })).length;
    expect(await f.executeParticipant("record-response", body, response.id, attemptId, seller)).toEqual(response);
    expect(await f.lookup("record-response", body, response.id, attemptId, buyer)).toEqual({ outcome: "not-recorded" });
    expect((await readCompleteStream(store, { streamId: `support.support-request-${response.id}` })).length).toBe(
      count,
    );
    const acceptance = await f.executeParticipant("accept-offer", { offerId: response.offerId }, response.id);
    expect(await f.executeParticipant("accept-offer", { offerId: response.offerId }, response.id)).toEqual(acceptance);
    expect(await f.lookup("accept-offer", { offerId: response.offerId }, response.id)).toMatchObject({
      outcome: "confirming",
      result: acceptance,
    });
    const history = await readCompleteStream(store, { streamId: `support.support-request-${response.id}` });
    expect(history[0].tenantId).toBe("tnt_seed_development");
    expect(validateParticipantHistory(history, response.id).receipts).toHaveLength(2);
    expect(history.filter((event) => event.eventType.endsWith(".response-recorded"))).toHaveLength(1);
    expect(history.filter((event) => event.eventType.endsWith(".offer-accepted"))).toHaveLength(1);
  });
  it("authorized tenant owners on one case independently reuse an id without disclosing or invalidating receipts", async () => {
    const store = makeStore();
    const f = participantFixture(store);
    const opened = await f.executeParticipant("open-support-request", openBody);
    const other = { ...buyer, tenantId: "tnt_other" };
    const key = `${attemptId}_note`;
    const body = { evidenceType: "support-note", summary: "Independent owner note" };
    const first = await f.executeParticipant("submit-evidence", body, opened.id, key);
    expect(await f.lookup("submit-evidence", body, opened.id, key, other)).toEqual({ outcome: "not-recorded" });
    const second = await f.executeParticipant("submit-evidence", body, opened.id, key, other);
    expect(second.evidenceId).not.toBe(first.evidenceId);
    const count = (await readCompleteStream(store, { streamId: `support.support-request-${opened.id}` })).length;
    expect(await f.executeParticipant("submit-evidence", body, opened.id, key)).toEqual(first);
    expect(await f.executeParticipant("submit-evidence", body, opened.id, key, other)).toEqual(second);
    expect((await readCompleteStream(store, { streamId: `support.support-request-${opened.id}` })).length).toBe(count);
    const history = await readCompleteStream(store, { streamId: `support.support-request-${opened.id}` });
    expect(validateParticipantHistory(history, opened.id).receipts.map(({ receipt }) => receipt.tenantId)).toEqual([
      buyer.tenantId,
      buyer.tenantId,
      other.tenantId,
    ]);
    const receipt = history.at(-1)!;
    expect(() =>
      validateParticipantHistory([...history.slice(0, -1), { ...receipt, tenantId: history[0].tenantId }], opened.id),
    ).toThrow();
    const fact = history.at(-2)!;
    expect(() =>
      validateParticipantHistory(
        [...history.slice(0, -2), { ...fact, tenantId: history[0].tenantId }, receipt],
        opened.id,
      ),
    ).toThrow();
  });
  for (const kind of [
    "receipt-only",
    "business-only",
    "changed-duplicate",
    "unexpected",
    "wrong-target",
    "post-terminal",
  ] as const) {
    it(`real-store poisoned history: ${kind} cannot qualify`, async () => {
      const store = makeStore();
      const f = participantFixture(store);
      const first = await f.executeParticipant("open-support-request", openBody);
      const history = await readCompleteStream(store, { streamId: `support.support-request-${first.id}` });
      const id = first.id;
      let poison = codec.encode({
        type: "support.support-request.participant-attempt-recorded",
        data: history.at(-1)!.payload as never,
      });
      if (kind === "business-only")
        poison = {
          ...codec.encode({
            type: "support.support-request.evidence-submitted",
            data: { supportRequestId: id } as never,
          }),
          metadata: {
            participantAttempt: { attemptId, requestHash: "a".repeat(64), actionKind: "submit-evidence", targetId: id },
          },
        };
      if (kind === "changed-duplicate")
        poison = { ...poison, payload: { ...poison.payload, requestHash: "b".repeat(64) } };
      if (kind === "unexpected")
        poison = { eventType: "support.support-request.unexpected", payload: { supportRequestId: id } };
      if (kind === "wrong-target") poison = { ...poison, payload: { ...poison.payload, targetId: "sup_other" } };
      if (kind === "post-terminal") {
        await f.executeParticipant("cancel", { reason: "Closed by requester" }, id, `${attemptId}_cancel`);
        poison = {
          eventType: "support.support-request.evidence-submitted",
          payload: { supportRequestId: id },
          metadata: {
            participantAttempt: {
              attemptId: `${attemptId}_late`,
              requestHash: "a".repeat(64),
              actionKind: "submit-evidence",
              targetId: id,
            },
          },
        };
      }
      const current = await readCompleteStream(store, { streamId: `support.support-request-${id}` });
      await store.appendToStream({
        streamId: `support.support-request-${id}`,
        expectedVersion: current.length,
        context: actorContext(buyer),
        events: [poison],
      });
      expect(await f.lookup("open-support-request", openBody)).toEqual({
        outcome: "unknown",
        reason: "history-invalid",
      });
      const before = await readCompleteStream(store, { streamId: `support.support-request-${id}` });
      await expect(f.executeParticipant("open-support-request", openBody)).rejects.toMatchObject({
        code: "history-invalid",
      });
      expect(await readCompleteStream(store, { streamId: `support.support-request-${id}` })).toEqual(before);
    });
  }
  for (const actionKind of Object.keys(participantActions) as ParticipantAction[]) {
    it(`runtime/version matrix: ${actionKind} commit-loss retry returns first result, zero second facts`, async () => {
      const store = makeStore();
      const f = participantFixture(store);
      const id = `sup_${actionKind}`;
      let body: unknown = {};
      let actor = buyer;
      if (actionKind !== "open-support-request") await seedCase(store, id);
      switch (actionKind) {
        case "open-support-request":
          body = openBody;
          break;
        case "submit-evidence":
          body = { submittedByRole: "buyer", evidenceType: "buyer-attestation", summary: "Case evidence" };
          break;
        case "record-response":
          actor = seller;
          body = {
            submittedByRole: "seller",
            responseType: "offer-partial-refund",
            summary: "Offer",
            offerResolutionType: "partial-refund",
            refundAmount: "6.00",
          };
          break;
        case "accept-offer":
        case "decline-offer":
          await seedOffer(store, id);
          body = { offerId: "sof_offer", ...(actionKind === "decline-offer" ? { summary: "Review needed" } : {}) };
          break;
        case "close":
          await seedOffer(store, id);
          await seedAcceptance(store, id);
          break;
        case "return-condition-dispute":
          await seedOffer(store, id, true);
          await seedAcceptance(store, id);
          await appendCommand(store, id, {
            type: "RecordReturnDelivery",
            deliveredAt: "2026-10-12T12:00:03.000Z",
            recordedByRole: "support",
          });
          actor = seller;
          body = { reason: "Condition differs" };
          break;
        default:
          body = { reason: "Review needed" };
      }
      const first = await f.executeParticipant(
        actionKind,
        body,
        actionKind === "open-support-request" ? undefined : id,
        attemptId,
        actor,
      );
      const before = await readCompleteStream(store, { streamId: `support.support-request-${first.id}` });
      const replay = await participantFixture(store).executeParticipant(
        actionKind,
        body,
        actionKind === "open-support-request" ? undefined : id,
        attemptId,
        actor,
      );
      expect(replay).toEqual(first);
      expect(await readCompleteStream(store, { streamId: `support.support-request-${first.id}` })).toEqual(before);
      expect(validateParticipantHistory(before, first.id).receipts).toHaveLength(1);
      expect(before.filter((event) => event.eventType === participantActions[actionKind].fact)).toHaveLength(1);
    });
  }
  it("barrier race: same owner/hash converges; different valid hashes winner/conflict without mixed history", async () => {
    const store = makeStore();
    function barrierFixture() {
      let arrivals = 0;
      let release: () => void = () => {};
      const barrier = new Promise<void>((resolve) => {
        release = resolve;
      });
      const readStream = vi.fn(async (input: Parameters<EventStore["readStream"]>[0]) => {
        const page = await store.readStream(input);
        if (arrivals < 2) {
          arrivals++;
          if (arrivals === 2) release();
          await barrier;
        }
        return page;
      });
      const appendToStream = vi.fn(store.appendToStream);
      return { fixture: participantFixture({ ...store, readStream, appendToStream }), readStream, appendToStream };
    }
    const sameBarrier = barrierFixture();
    const f = sameBarrier.fixture;
    const same = await Promise.all([
      f.executeParticipant("open-support-request", openBody),
      f.executeParticipant("open-support-request", openBody),
    ]);
    expect(same[0]).toEqual(same[1]);
    expect(sameBarrier.readStream).toHaveBeenCalledTimes(3);
    expect(sameBarrier.appendToStream).toHaveBeenCalledTimes(2);
    const changedKey = `${attemptId}_race`;
    const differentBarrier = barrierFixture();
    const raced = await Promise.allSettled([
      differentBarrier.fixture.executeParticipant("open-support-request", openBody, undefined, changedKey),
      differentBarrier.fixture.executeParticipant(
        "open-support-request",
        { ...openBody, affectedLineIds: ["line_a"] },
        undefined,
        changedKey,
      ),
    ]);
    expect(raced.filter((entry) => entry.status === "fulfilled")).toHaveLength(1);
    const failure = raced.find((entry) => entry.status === "rejected");
    expect(failure && failure.status === "rejected" && failure.reason).toMatchObject({ status: 409 });
    expect(differentBarrier.readStream).toHaveBeenCalledTimes(3);
    expect(differentBarrier.appendToStream).toHaveBeenCalledTimes(2);
  });
  it("history 500/501: complete stream sees late receipt and late poison, never presence alone", async () => {
    const store = makeStore();
    const id = "sup_long_history";
    await seedCase(store, id);
    const opened = await readCompleteStream(store, { streamId: `support.support-request-${id}` });
    let state = opened.reduce((s, event) => evolveSupportRequest(s, codec.decode(event)), initialSupportRequestState);
    const facts: SupportRequestEvent[] = [];
    for (let index = opened.length; index < 500; index++) {
      const next = await decideSupportRequest(state, {
        type: "SubmitSupportEvidence",
        evidenceId: `sev_seed_${index}`,
        submittedByRole: "support",
        evidenceType: "support-note",
        summary: "Legacy note",
        submittedAt: "2026-10-12T12:00:00.000Z",
      });
      facts.push(...next);
      state = next.reduce(evolveSupportRequest, state);
    }
    await store.appendToStream({
      streamId: `support.support-request-${id}`,
      expectedVersion: opened.length,
      context: actorContext(buyer),
      events: facts.map(codec.encode),
    });
    const f = participantFixture(store);
    const body = { submittedByRole: "buyer", evidenceType: "buyer-attestation", summary: "Late evidence" };
    const first = await f.executeParticipant("submit-evidence", body, id);
    expect(first.version).toBe(502);
    expect(await f.lookup("submit-evidence", body, id)).toMatchObject({ outcome: "confirming", result: first });
    const events = await readCompleteStream(store, { streamId: `support.support-request-${id}` });
    for (const broken of [
      events.slice(0, 501),
      [...events, { ...events[501], streamVersion: 503 }],
      [...events.slice(0, 501), { ...events[501], payload: { ...events[501].payload, targetId: "sup_other" } }],
    ])
      expect(() => validateParticipantHistory(broken, id)).toThrow();
    const gapStore = {
      ...store,
      readStream: async (input: Parameters<EventStore["readStream"]>[0]) =>
        (await store.readStream(input)).filter((event) => event.streamVersion !== 501),
    };
    expect(await participantFixture(gapStore).lookup("submit-evidence", body, id)).toEqual({
      outcome: "unknown",
      reason: "authority-unavailable",
    });
  });
}
