import { describe, expect, it } from "vitest";
import type { SupportParticipantPolicy } from "../../features/support-requests/api/support-flow-projection";
import type { SupportRequestParticipantDetailResponse } from "../../features/support-requests/ui/contracts";
import { supportParticipantDetailFixture } from "../../features/support-requests/ui/participant-router.test-data";
import { supportRequestParticipantDetail } from "./support-request-detail-route-adapter";

function participantDetail(participantPolicy: SupportParticipantPolicy) {
  return {
    ...supportParticipantDetailFixture(),
    participantPolicy,
  } as unknown as SupportRequestParticipantDetailResponse;
}

describe("supportRequestParticipantDetail", () => {
  it("passes the API participant policy through instead of deriving the next actor, deadline or cancellation", () => {
    // The row alone (buyer opener, buyer checklist item open) would put the buyer next with a cancel control.
    const participantPolicy: SupportParticipantPolicy = {
      nextActor: "seller",
      deadlineAt: "2026-10-13T12:00:00.000Z",
      actions: [],
    };
    const detail = participantDetail(participantPolicy);

    const participant = supportRequestParticipantDetail(detail, "acc_buyer");
    expect(participant).toEqual({ flow: detail.flow, viewerRole: "buyer", participantPolicy });
    expect(participant?.participantPolicy).toBe(participantPolicy);
  });

  it("keeps the viewer role from row ownership and refuses an account that is neither party", () => {
    const detail = participantDetail({ nextActor: "buyer", deadlineAt: null, actions: [{ kind: "cancel" }] });

    expect(supportRequestParticipantDetail(detail, "acc_seller")?.viewerRole).toBe("seller");
    expect(supportRequestParticipantDetail(detail, "acc_other")).toBeNull();
  });
});
