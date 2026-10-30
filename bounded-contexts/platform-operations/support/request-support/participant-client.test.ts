// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { CHASE_SETS_COMMIT_RECEIPT_HEADER, encodeCommitReceipt, getResponseMetadata } from "@chase-sets/http/responses";
import { createSupportRequestApiClient, SupportParticipantSendError } from "./support-request-api-client";
import { participantActions, type ParticipantAction } from "../../features/support-requests/domain/participant-attempt";
import { responseFixture, responseSeller } from "../../features/support-requests/api/participant-attempt.test-support";

const attemptId = "7163_client_0123456789abcdef";
const bodies: Record<ParticipantAction, unknown> = {
  "open-support-request": { orderId: "ord_case", flowType: "product-not-received" },
  "submit-evidence": { submittedByRole: "buyer", evidenceType: "buyer-attestation", summary: "No delivery." },
  "record-response": { submittedByRole: "seller", responseType: "provide-tracking", summary: "Carrier scan." },
  "accept-offer": {},
  "decline-offer": { summary: "Review needed." },
  escalate: { reason: "Review needed." },
  cancel: { reason: "Withdrawn." },
  close: {},
  "return-condition-dispute": { reason: "Condition changed." },
};
const result = (actionKind: ParticipantAction) => ({
  id: "sup_case",
  version: 2,
  status: participantActions[actionKind].status,
  evidenceId: null,
  responseId: null,
  offerId: null,
});
afterEach(() => vi.unstubAllGlobals());

describe("record-response v1 compatibility", () => {
  for (const explicit of [true, false]) {
    it(`response removal preserves retained attempt recovery: ${explicit ? "old explicit" : "omitted"} descriptor lookup and send replay retain bytes and append once`, async () => {
      const f = await responseFixture("offer-partial-refund", "Offer");
      f.setActor(responseSeller);
      const body = { ...f.body, ...(explicit ? { offerResolutionType: "partial-refund" } : {}) };
      const hash = explicit
        ? "3ba438568581f403087dcb003a79786b107e03b530c3d82b9e13318fe233bd69"
        : "5311718d3c0f214609932c3796b200034f9eead83a7aec7a1120fe9a1bc54216";
      const clientFetch = vi.fn<typeof fetch>(async (url, init) =>
        f.app.request(String(url).replace("/api/marketplace", ""), init),
      );
      const api = createSupportRequestApiClient({ fetch: clientFetch });
      const first = await api.participantCommand("record-response", body, attemptId, f.id);
      expect(new Headers(clientFetch.mock.calls[0][1]?.headers).get("X-Support-Request-Hash")).toBe(hash);
      expect(JSON.parse(String(clientFetch.mock.calls[0][1]?.body))).toEqual(body);
      const descriptor = { actionKind: "record-response", targetId: f.id, attemptId, requestHash: hash } as const;
      expect(await api.lookupParticipantAttempt(descriptor)).toMatchObject({ outcome: "confirming", result: first });
      expect(await api.participantCommand("record-response", body, attemptId, f.id)).toEqual(first);
      expect(f.allEvents.filter((event) => event.eventType.endsWith(".response-recorded"))).toHaveLength(1);
      expect(f.allEvents.filter((event) => event.eventType.endsWith(".participant-attempt-recorded"))).toHaveLength(1);
      if (explicit) {
        const beforeConflict = [...f.allEvents];
        clientFetch.mockClear();
        await expect(api.participantCommand("record-response", f.body, attemptId, f.id)).rejects.toMatchObject({
          phase: "ambiguous",
          descriptor: {
            ...descriptor,
            requestHash: "5311718d3c0f214609932c3796b200034f9eead83a7aec7a1120fe9a1bc54216",
          },
        });
        expect(clientFetch.mock.calls.map(([, init]) => init?.method ?? "GET")).toEqual(["POST", "GET"]);
        expect((await clientFetch.mock.results[0].value).status).toBe(409);
        expect((await clientFetch.mock.results[1].value).status).toBe(200);
        expect(f.allEvents).toEqual(beforeConflict);
      }
    });
  }
});

describe("action-map/client/runtime call-count matrix", () => {
  for (const actionKind of Object.keys(participantActions) as ParticipantAction[]) {
    it(`${actionKind}: loss after dispatch performs one POST and one read, never a second command`, async () => {
      const token = encodeCommitReceipt([
        { sourceContextName: "platform-operations", maxGlobalPosition: "42", eventIds: ["evt_first"] },
      ]);
      const clientFetch = vi.fn<typeof fetch>(async (_url, init) => {
        if (init?.method === "POST") throw new Error("lost reply");
        return new Response(JSON.stringify({ outcome: "confirming", actionKind, result: result(actionKind) }), {
          headers: { [CHASE_SETS_COMMIT_RECEIPT_HEADER]: token, "Chase-Sets-Consistency": "eventual" },
        });
      });
      const api = createSupportRequestApiClient({ fetch: clientFetch });
      const first = await api.participantCommand(
        actionKind,
        bodies[actionKind],
        attemptId,
        actionKind === "open-support-request" ? null : "sup_case",
        "sof_first",
      );
      expect(first).toMatchObject(result(actionKind));
      expect(clientFetch.mock.calls.map(([, init]) => init?.method ?? "GET")).toEqual(["POST", "GET"]);
      expect(new Headers(clientFetch.mock.calls[0][1]?.headers).get("Idempotency-Key")).toBe(attemptId);
      expect(getResponseMetadata(first)?.consistency?.commitPositions).toEqual([
        { sourceContextName: "platform-operations", maxGlobalPosition: "42", eventIds: ["evt_first"] },
      ]);
    });
  }
  for (const outcome of [
    { outcome: "not-recorded" },
    { outcome: "unknown", reason: "authority-unavailable" },
    { outcome: "unknown", reason: "history-invalid" },
    { outcome: "committed", projection: { id: "sup_case" } },
    { outcome: "committed", actionKind: "cancel", result: { ...result("cancel"), id: "sup_another" } },
    { outcome: "committed", actionKind: "close", result: result("close") },
    { outcome: "committed", actionKind: "cancel", result: { ...result("cancel"), token: "PRIVATE" } },
  ]) {
    it(`remains ambiguous and inert for ${JSON.stringify(outcome)}`, async () => {
      const clientFetch = vi.fn<typeof fetch>(async (_url, init) => {
        if (init?.method === "POST") throw new Error("maybe sent");
        return new Response(JSON.stringify(outcome));
      });
      const api = createSupportRequestApiClient({ fetch: clientFetch });
      await expect(api.participantCommand("cancel", bodies.cancel, attemptId, "sup_case")).rejects.toMatchObject({
        phase: "ambiguous",
        descriptor: { attemptId, targetId: "sup_case" },
      });
      expect(clientFetch.mock.calls.map(([, init]) => init?.method ?? "GET")).toEqual(["POST", "GET"]);
    });
  }
});
describe("one-variable adapter/call-count controls", () => {
  it("close and return-condition dispute retain the caller's participant attempt identity", async () => {
    const clientFetch = vi.fn<typeof fetch>(async () => new Response(null, { status: 400 }));
    const api = createSupportRequestApiClient({ fetch: clientFetch, participantAttemptId: attemptId });
    await expect(api.closeSupportRequest("sup_case")).rejects.toMatchObject({ phase: "failed-safe" });
    await expect(api.disputeSupportReturnCondition("sup_case", { reason: "Condition changed." })).rejects.toMatchObject(
      { phase: "failed-safe" },
    );
    expect(clientFetch).toHaveBeenCalledTimes(2);
    for (const [, init] of clientFetch.mock.calls)
      expect(new Headers(init?.headers).get("Idempotency-Key")).toBe(attemptId);
  });
  it("proved pre-send offline and local validation make zero calls", async () => {
    const clientFetch = vi.fn();
    const api = createSupportRequestApiClient({ fetch: clientFetch });
    await expect(api.participantCommand("cancel", { reason: "" }, attemptId, "sup_case")).rejects.toMatchObject({
      phase: "failed-safe",
    });
    vi.stubGlobal("navigator", { onLine: false });
    await expect(api.participantCommand("cancel", bodies.cancel, attemptId, "sup_case")).rejects.toBeInstanceOf(
      SupportParticipantSendError,
    );
    expect(clientFetch).not.toHaveBeenCalled();
  });
  for (const status of [400, 401, 403])
    it(`proved HTTP ${status} refusal does not lookup or resend`, async () => {
      const clientFetch = vi.fn<typeof fetch>(async () => new Response(null, { status }));
      await expect(
        createSupportRequestApiClient({ fetch: clientFetch }).participantCommand(
          "cancel",
          bodies.cancel,
          attemptId,
          "sup_case",
        ),
      ).rejects.toMatchObject({ phase: "failed-safe", descriptor: null });
      expect(clientFetch).toHaveBeenCalledTimes(1);
    });
});
