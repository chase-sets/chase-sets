// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import { createEventStoreError } from "@chase-sets/event-core/event-store";
import { readCompleteStream } from "@chase-sets/event-core/complete-stream";
import { getEventCommitMetadata, runWithEventCommitMetadata } from "@chase-sets/event-core/consistency";
import { evidenceActor } from "../domain/evidence-access-policy.test-support";
import { participantFixture, openBody, buyer, attemptId, requestHash } from "./participant-attempt.test-support";
import { validateParticipantHistory } from "./participant-runtime";

describe("scoped-attempt matrix", () => {
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
  it("receipt-only, business-only, changed duplicate, unexpected, wrong-target and post-terminal history never qualify", async () => {
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
    expect(f.storage.putObject).not.toHaveBeenCalled();
    expect(f.storage.getObject).not.toHaveBeenCalled();
    expect(f.storage.deleteObjects).not.toHaveBeenCalled();
  });
});
