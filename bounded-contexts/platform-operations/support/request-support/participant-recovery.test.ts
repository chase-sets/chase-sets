// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { hashParticipantRequest } from "../../features/support-requests/domain/participant-attempt";
import { participantActorMatches, readParticipantRecovery } from "./participant-recovery";
import { createSupportRequestApiClient } from "./support-request-api-client";

const actor = { accountId: "acc_buyer", tenantId: "tnt_identity" };
const descriptor = {
  actionKind: "cancel",
  targetId: "sup_case",
  attemptId: "7163_recovery_0123456789abcdef",
  requestHash: "a".repeat(64),
};
describe("reload/serialization scan/account-switch/tenant-mismatch matrix", () => {
  it("retains one bounded inert descriptor, no business text or file metadata, and reload performs only reads", async () => {
    const form = new FormData();
    form.set("participantRecovery", JSON.stringify({ phase: "ambiguous", descriptor, ...actor }));
    const recovered = readParticipantRecovery(form, actor);
    expect(recovered?.descriptor).toEqual(descriptor);
    expect(JSON.stringify(recovered).length).toBeLessThan(1024);
    expect(Object.keys(recovered!.descriptor!).sort()).toEqual(
      ["actionKind", "targetId", "attemptId", "requestHash"].sort(),
    );
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ outcome: "not-recorded" })));
    await createSupportRequestApiClient({ fetch: fetchMock }).lookupParticipantAttempt(recovered!.descriptor!);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1]?.method).toBeUndefined();
    expect(readParticipantRecovery(new FormData(), actor)).toBeNull();
  });
  for (const changed of [
    { ...actor, accountId: "acc_other" },
    { ...actor, tenantId: "tnt_other" },
  ]) {
    it(`never retargets across ${JSON.stringify(changed)}`, () => {
      const form = new FormData();
      form.set("participantAccountId", actor.accountId);
      form.set("participantTenantId", actor.tenantId);
      form.set("participantRecovery", JSON.stringify({ phase: "ambiguous", descriptor, ...actor }));
      expect(participantActorMatches(form, changed)).toBe(false);
      expect(() => readParticipantRecovery(form, changed)).toThrow("owner changed");
    });
  }
  for (const field of ["summary", "file", "filename", "path", "url", "objectKey", "token", "bytes", "metadata"]) {
    it(`refuses serialized ${field} even nested`, () => {
      const form = new FormData();
      form.set(
        "participantRecovery",
        JSON.stringify({
          phase: "ambiguous",
          descriptor: { ...descriptor, [field]: { planted: "PRIVATE" } },
          ...actor,
        }),
      );
      expect(() => readParticipantRecovery(form, actor)).toThrow();
    });
  }
  it("new payloads produce different hashes without persisting their text", async () => {
    expect(await hashParticipantRequest("cancel", { reason: "First private reason" })).not.toBe(
      await hashParticipantRequest("cancel", { reason: "Second private reason" }),
    );
  });
});
