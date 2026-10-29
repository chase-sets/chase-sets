// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import { createEventStoreError } from "@chase-sets/event-core/event-store";
import { readCompleteStream } from "@chase-sets/event-core/complete-stream";
import { getEventCommitMetadata, runWithEventCommitMetadata } from "@chase-sets/event-core/consistency";
import { parseStrictTypedUlid } from "@chase-sets/primitives/typed-ids";
import { deriveDisplayReference } from "@chase-sets/primitives/display-reference";
import { evidenceActor } from "../domain/evidence-access-policy.test-support";
import {
  participantFixture,
  openBody,
  buyer,
  attemptId,
  requestHash,
  actorContext,
  responseCases,
  responseFixture,
  responseSeller,
} from "./participant-attempt.test-support";
import { participantOpenSupportRequestId, validateParticipantHistory } from "./participant-runtime";
import { evolveSupportRequest, initialSupportRequestState, type SupportRequestEvent } from "../domain/domain";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";

describe("participant response derives resolution after hashing", () => {
  for (const scenario of responseCases.filter((entry) => entry.resolutionType !== null)) {
    it(`${scenario.responseType}: explicit, omitted, null and empty have equivalent facts and state`, async () => {
      const snapshots = [];
      for (const field of [
        { offerResolutionType: scenario.resolutionType },
        {},
        { offerResolutionType: null },
        { offerResolutionType: "" },
      ]) {
        const f = await responseFixture(scenario.responseType);
        const body = { ...f.body, ...field };
        const result = await f.executeParticipant("record-response", body, f.id, attemptId, responseSeller);
        const history = await readCompleteStream(f.eventStore, { streamId: `support.support-request-${f.id}` });
        const codec = createPassthroughDomainEventCodec<SupportRequestEvent>();
        const state = history.reduce(
          (current, event) => evolveSupportRequest(current, codec.decode(event)),
          initialSupportRequestState,
        );
        expect(state.status).toBe("waiting-on-buyer");
        expect(state.pendingOffer).toMatchObject({
          resolutionType: scenario.resolutionType,
          pendingWithRole: "buyer",
          refundAmount:
            scenario.responseType === "offer-partial-refund"
              ? "6.00"
              : scenario.responseType === "accept-return"
                ? "24.00"
                : null,
        });
        const fact = history.find((event) => event.eventType.endsWith(".response-recorded"))!;
        const response = fact.payload.response as Record<string, unknown>;
        const offer = fact.payload.offer as Record<string, unknown>;
        snapshots.push({
          ...fact.payload,
          supportRequestId: "generated",
          response: { ...response, responseId: "generated", offerId: "generated" },
          offer: { ...offer, responseId: "generated", offerId: "generated" },
        });
        expect(await f.executeParticipant("record-response", body, f.id, attemptId, responseSeller)).toEqual(result);
        expect(await f.lookup("record-response", body, f.id, attemptId, responseSeller)).toMatchObject({
          outcome: "confirming",
          result,
        });
        expect(await readCompleteStream(f.eventStore, { streamId: `support.support-request-${f.id}` })).toEqual(
          history,
        );
      }
      for (const snapshot of snapshots) expect(snapshot).toEqual(snapshots[0]);
    });
  }
});

describe("participant response refusal controls", () => {
  for (const scenario of responseCases) {
    it(`${scenario.responseType}: mismatches refuse without an append`, async () => {
      const f = await responseFixture(scenario.responseType);
      const before = f.allEvents.length;
      const wrong = scenario.resolutionType === "replacement" ? "partial-refund" : "replacement";
      await expect(
        f.executeParticipant(
          "record-response",
          { ...f.body, offerResolutionType: wrong },
          f.id,
          attemptId,
          responseSeller,
        ),
      ).rejects.toThrow(
        scenario.resolutionType
          ? "Offer resolution does not match the response type."
          : "Only offer responses can include an offer resolution.",
      );
      expect(f.allEvents).toHaveLength(before);
    });
    if (scenario.resolutionType === null) {
      for (const field of [{}, { offerResolutionType: null }]) {
        it(`${scenario.responseType}: ${JSON.stringify(field)} has no offer`, async () => {
          const f = await responseFixture(scenario.responseType);
          await f.executeParticipant("record-response", { ...f.body, ...field }, f.id, attemptId, responseSeller);
          expect(f.allEvents.find((event) => event.eventType.endsWith(".response-recorded"))?.payload.offer).toBeNull();
        });
      }
    }
  }
  it("preserves wrong-role, unknown/type/nested, hash, id, amount, flow and terminal guards", async () => {
    for (const invalid of [
      { responseType: "unknown" },
      { offerResolutionType: "unknown" },
      { offerResolutionType: 3 },
      { offerResolutionType: { value: "partial-refund" } },
      { summary: { unknown: true } },
      { affectedLineIds: [{ unknown: true }] },
      { extra: { unknown: true } },
      { submittedByRole: "buyer" },
      { refundAmount: "0.00" },
      { refundAmount: "24.01" },
    ]) {
      const f = await responseFixture("offer-partial-refund");
      const before = f.allEvents.length;
      await expect(
        f.runtime.executeParticipantAttempt(
          {
            actionKind: "record-response",
            body: { ...f.body, ...invalid },
            targetId: f.id,
            accountId: responseSeller.accountId,
            actor: responseSeller,
            attempt: {
              attemptId,
              requestHash: requestHash(
                "record-response",
                "refundAmount" in invalid || "submittedByRole" in invalid ? { ...f.body, ...invalid } : f.body,
              ),
            },
          },
          actorContext(responseSeller),
        ),
      ).rejects.toThrow();
      expect(f.allEvents).toHaveLength(before);
    }
    const f = await responseFixture("offer-partial-refund");
    const before = f.allEvents.length;
    await expect(f.executeParticipant("record-response", f.body, f.id)).rejects.toThrow(
      "Support responses must come from the seller or support.",
    );
    for (const attempt of [
      { attemptId: "bad", requestHash: requestHash("record-response", f.body) },
      { attemptId, requestHash: "a".repeat(64) },
    ]) {
      await expect(
        f.runtime.executeParticipantAttempt(
          {
            actionKind: "record-response",
            body: f.body,
            targetId: f.id,
            accountId: responseSeller.accountId,
            actor: responseSeller,
            attempt,
          },
          actorContext(responseSeller),
        ),
      ).rejects.toThrow();
    }
    expect(f.allEvents).toHaveLength(before);
    await f.executeParticipant("cancel", { reason: "Withdrawn" }, f.id, `${attemptId}_cancel`);
    const terminalCount = f.allEvents.length;
    await expect(f.executeParticipant("record-response", f.body, f.id, attemptId, responseSeller)).rejects.toThrow(
      "Closed support requests cannot accept responses.",
    );
    expect(f.allEvents).toHaveLength(terminalCount);
    const wrongFlow = await responseFixture("provide-tracking");
    const flowCount = wrongFlow.allEvents.length;
    await expect(
      wrongFlow.executeParticipant(
        "record-response",
        { responseType: "accept-return", summary: "Offer" },
        wrongFlow.id,
        attemptId,
        responseSeller,
      ),
    ).rejects.toThrow("This response is not accepted for the support flow.");
    expect(wrongFlow.allEvents).toHaveLength(flowCount);
  });
});

describe("scoped-attempt matrix", () => {
  it("participant open identity is a deterministic canonical typed ULID with a SUP display reference", () => {
    const inputs = [
      ["tnt_identity", "acc_buyer", attemptId],
      ["tnt_other", "acc_buyer", attemptId],
      ["tnt_identity", "acc_seller", attemptId],
      ["tnt_identity", "acc_buyer", `${attemptId}_other`],
    ] as const;
    const ids = inputs.map(([tenantId, accountId, key]) => {
      const id = participantOpenSupportRequestId(tenantId, accountId, key);
      expect(parseStrictTypedUlid(id, "sup")).toBe(id);
      expect(deriveDisplayReference(id)).toMatch(/^SUP-[0-9A-Z]{8}$/);
      expect(participantOpenSupportRequestId(tenantId, accountId, key)).toBe(id);
      return id;
    });
    expect(new Set(ids).size).toBe(inputs.length);
  });
  it("authenticated actor tenant/account mismatch refuses before any history read or append", async () => {
    const memory = createInMemoryEventStore();
    const readStream = vi.fn(memory.eventStore.readStream);
    const appendToStream = vi.fn(memory.eventStore.appendToStream);
    const f = participantFixture({ ...memory.eventStore, readStream, appendToStream });
    for (const actor of [
      { ...buyer, tenantId: "tnt_other" },
      { ...buyer, accountId: "acc_other" },
    ]) {
      await expect(
        f.runtime.executeParticipantAttempt(
          {
            actionKind: "open-support-request",
            body: openBody,
            accountId: buyer.accountId,
            actor,
            attempt: { attemptId, requestHash: requestHash("open-support-request", openBody) },
          },
          actorContext(buyer),
        ),
      ).rejects.toMatchObject({ status: 403, code: "participant-actor-mismatch" });
    }
    expect(readStream).not.toHaveBeenCalled();
    expect(appendToStream).not.toHaveBeenCalled();
    for (const operation of Object.values(f.storage)) expect(operation).not.toHaveBeenCalled();
  });
  it("same owner/id changed action conflicts with valid domain prerequisites", async () => {
    const f = participantFixture();
    const opened = await f.executeParticipant("open-support-request", openBody);
    const key = `${attemptId}_action`;
    await f.executeParticipant(
      "submit-evidence",
      { evidenceType: "support-note", summary: "Valid note" },
      opened.id,
      key,
    );
    const count = f.allEvents.length;
    await expect(f.executeParticipant("escalate", { reason: "Valid review" }, opened.id, key)).rejects.toMatchObject({
      status: 409,
    });
    expect(f.allEvents).toHaveLength(count);
  });
  it("buyer/seller same case owner binding prevents replay then permits independent same-id writes", async () => {
    const f = participantFixture();
    const opened = await f.executeParticipant("open-support-request", openBody);
    const seller = evidenceActor("viewer", ["support.view", "support.manage"], false, "acc_seller");
    const key = `${attemptId}_shared`;
    const body = { evidenceType: "support-note", summary: "Same valid input" };
    const first = await f.executeParticipant("submit-evidence", body, opened.id, key, buyer);
    expect(await f.lookup("submit-evidence", body, opened.id, key, seller)).toEqual({ outcome: "not-recorded" });
    const second = await f.executeParticipant("submit-evidence", body, opened.id, key, seller);
    expect(second.evidenceId).not.toBe(first.evidenceId);
    expect(await f.executeParticipant("submit-evidence", body, opened.id, key, buyer)).toEqual(first);
    expect(await f.executeParticipant("submit-evidence", body, opened.id, key, seller)).toEqual(second);
  });
  it("same owner/id changed hash conflicts before append (action-hash-partition control)", async () => {
    const f = participantFixture();
    const opened = await f.executeParticipant("open-support-request", openBody);
    expect(parseStrictTypedUlid(opened.id, "sup")).toBe(opened.id);
    const before = f.allEvents.length;
    await expect(
      f.executeParticipant("open-support-request", { ...openBody, affectedLineIds: ["line_a"] }),
    ).rejects.toMatchObject({ status: 409 });
    expect(f.allEvents).toHaveLength(before);
    const body = { submittedByRole: "buyer", evidenceType: "buyer-attestation", summary: "Order not received." };
    const first = await f.executeParticipant("submit-evidence", body, opened.id, "7163_evidence_0123456789abcdef");
    const count = f.allEvents.length;
    expect(await f.executeParticipant("submit-evidence", body, opened.id, "7163_evidence_0123456789abcdef")).toEqual(
      first,
    );
    await expect(
      f.executeParticipant(
        "submit-evidence",
        { ...body, summary: "Different valid evidence." },
        opened.id,
        "7163_evidence_0123456789abcdef",
      ),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      f.executeParticipant("escalate", { reason: "Needs review." }, opened.id, "7163_evidence_0123456789abcdef"),
    ).rejects.toMatchObject({ status: 409 });
    expect(f.allEvents).toHaveLength(count);
  });
  it("authorized targets/accounts/tenants independently use one opaque id, never cross-owner replay/disclosure", async () => {
    const f = participantFixture();
    const first = await f.executeParticipant("open-support-request", openBody, undefined, `${attemptId}_open`);
    const second = await f.executeParticipant("open-support-request", openBody, undefined, `${attemptId}_other`);
    const seller = evidenceActor("viewer", ["support.view", "support.manage"], false, "acc_seller");
    const body = { reason: "Needs review." };
    await f.executeParticipant("escalate", body, first.id, attemptId, buyer);
    await f.executeParticipant("escalate", body, second.id, attemptId, buyer);
    const sellerLookup = await f.lookup("escalate", body, first.id, attemptId, seller);
    expect(sellerLookup).toEqual({ outcome: "not-recorded" });
    const other = { ...buyer, tenantId: "tnt_other" };
    const otherOpen = await f.executeParticipant("open-support-request", openBody, undefined, attemptId, other);
    expect(otherOpen.id).not.toBe(first.id);
    expect(await f.lookup("open-support-request", openBody, undefined, attemptId, other)).toMatchObject({
      outcome: "confirming",
      result: { id: otherOpen.id },
    });
    expect(await f.lookup("escalate", body, first.id, attemptId, other)).toEqual({ outcome: "not-recorded" });
    const stranger = { ...buyer, accountId: "acc_stranger" };
    expect(await f.lookup("escalate", body, first.id, attemptId, stranger)).toEqual({ outcome: "not-recorded" });
  });
});

describe("history matrix", () => {
  it("concurrency without a receipt reloads once and never retries the command", async () => {
    const memory = createInMemoryEventStore();
    const readStream = vi.fn(memory.eventStore.readStream);
    const appendToStream = vi.fn(async () => {
      if (appendToStream.mock.calls.length > 1) throw new Error("second-command-mutant");
      throw createEventStoreError("concurrency_conflict", "forced absent winner");
    });
    const f = participantFixture({ ...memory.eventStore, readStream, appendToStream });
    await expect(f.executeParticipant("open-support-request", openBody)).rejects.toMatchObject({
      code: "participant-concurrency-unknown",
    });
    expect(readStream).toHaveBeenCalledTimes(2);
    expect(appendToStream).toHaveBeenCalledTimes(1);
    expect(memory.allEvents).toHaveLength(0);
  });
  it("matching receipt/facts and reflected read qualify committed; projection presence without receipt does not", async () => {
    const f = participantFixture();
    const first = await f.executeParticipant("open-support-request", openBody);
    f.db.query.mockResolvedValue({
      rows: [
        {
          support_request_id: first.id,
          buyer_account_id: buyer.accountId,
          seller_account_id: "acc_seller",
          opened_at: "2026-10-12T12:00:00.000Z",
          order_id: openBody.orderId,
          resolution: null,
          remedy_approval: null,
        },
      ],
    } as never);
    expect(await f.lookup("open-support-request", openBody)).toMatchObject({ outcome: "committed", result: first });
    expect(await f.lookup("open-support-request", openBody, undefined, `${attemptId}_unrecorded`)).toEqual({
      outcome: "not-recorded",
    });
  });
  it("poison remains undisclosed to another actor and unknown outcomes never receive receipt metadata", async () => {
    const f = participantFixture();
    const opened = await f.executeParticipant("open-support-request", openBody);
    await f.eventStore.appendToStream({
      streamId: `support.support-request-${opened.id}`,
      expectedVersion: opened.version,
      context: {
        tenantId: buyer.tenantId as never,
        audit: { performedByUserId: buyer.userId as never, forAccountId: buyer.accountId as never },
      },
      events: [{ eventType: "support.support-request.participant-attempt-recorded", payload: { token: "PRIVATE" } }],
    });
    const stranger = { ...buyer, accountId: "acc_stranger" };
    await runWithEventCommitMetadata(async () => {
      expect(await f.lookup("open-support-request", openBody)).toEqual({
        outcome: "unknown",
        reason: "history-invalid",
      });
      expect(
        await f.lookup(
          "submit-evidence",
          { evidenceType: "support-note", summary: "Valid" },
          opened.id,
          attemptId,
          stranger,
        ),
      ).toEqual({ outcome: "not-recorded" });
      expect(getEventCommitMetadata().sources).toEqual([]);
    });
  });
  it("receipt-only, business-only, unpaired duplicate, unexpected, wrong-target and receipt-metadata mismatch never qualify", async () => {
    const f = participantFixture();
    const opened = await f.executeParticipant("open-support-request", openBody);
    const events = await readCompleteStream(f.eventStore, { streamId: `support.support-request-${opened.id}` });
    expect(validateParticipantHistory(events, opened.id).receipts).toHaveLength(1);
    for (const history of [
      events.slice(1),
      events.slice(0, -1),
      [...events, { ...events[1], streamVersion: 3 }],
      [{ ...events[0], payload: { ...events[0].payload, supportRequestId: "sup_other" } }, events[1]],
      [{ ...events[0], eventType: "support.support-request.unexpected" }, events[1]],
      [events[0], { ...events[1], payload: { ...events[1].payload, requestHash: "b".repeat(64) } }],
    ]) {
      expect(() => validateParticipantHistory(history, opened.id)).toThrow();
    }
  });
  it("same scoped barrier race converges with one winner, zero recursive retry", async () => {
    const f = participantFixture();
    const results = await Promise.all([
      f.executeParticipant("open-support-request", openBody),
      f.executeParticipant("open-support-request", openBody),
    ]);
    expect(results[0]).toEqual(results[1]);
    expect(f.allEvents.filter((event) => event.eventType.endsWith(".opened"))).toHaveLength(1);
  });
  it("lookup owns absence/authorization, no writes/provider calls and malformed/duplicate query rejection", async () => {
    const f = participantFixture();
    const query = `requestHash=${requestHash("open-support-request", openBody)}`;
    const url = `/support-requests/participant-attempts/${attemptId}?${query}`;
    expect(await (await f.app.request(url)).json()).toEqual({ outcome: "not-recorded" });
    const opened = await f.executeParticipant("open-support-request", openBody);
    const before = f.allEvents.length;
    expect(await (await f.app.request(url)).json()).toMatchObject({ outcome: "confirming", result: { id: opened.id } });
    expect((await f.app.request(`${url}&${query}`)).status).toBe(400);
    expect((await f.app.request(`${url}&token=private`)).status).toBe(400);
    f.setActor(null);
    expect((await f.app.request(url)).status).toBe(401);
    expect(f.allEvents).toHaveLength(before);
    for (const operation of Object.values(f.storage)) expect(operation).not.toHaveBeenCalled();
  });
});
