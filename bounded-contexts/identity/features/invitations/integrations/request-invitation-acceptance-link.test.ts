import { CHASE_SETS_INTERNAL_API_ORIGIN_ENV } from "@chase-sets/platform-runtime/http";
import { CHASE_SETS_READ_AFTER_WRITE_HEADER, CHASE_SETS_READ_TARGET_CONTEXT_HEADER } from "@chase-sets/http/responses";
import { afterEach, describe, expect, it, vi } from "vitest";
import { requestInvitationAcceptanceLink } from "./request-invitation-acceptance-link";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("request invitation acceptance link", () => {
  it("waits for the Auth invitation projection before requesting the tokenized email", async () => {
    vi.stubEnv(CHASE_SETS_INTERNAL_API_ORIGIN_ENV, "https://platform-api.internal");
    const fetchMock = vi.fn<typeof fetch>(async () => Response.json({ invitationId: "ivt_1" }));
    vi.stubGlobal("fetch", fetchMock);

    await requestInvitationAcceptanceLink(new Request("https://marketplace.test/account/team"), "ivt_1", {
      commandReceipt: {
        mode: "eventual",
        commitEventIds: ["evt_invitation_created"],
        commitPositions: [
          {
            sourceContextName: "identity",
            maxGlobalPosition: "42",
            eventIds: ["evt_invitation_created"],
          },
        ],
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [input, init] = fetchMock.mock.calls[0]!;
    expect(String(input)).toBe("https://platform-api.internal/api/auth/invitations/acceptance-link/request");
    const headers = new Headers(init?.headers);
    expect(headers.get(CHASE_SETS_READ_AFTER_WRITE_HEADER)).toBeTruthy();
    expect(headers.get(CHASE_SETS_READ_TARGET_CONTEXT_HEADER)).toBe("auth");
    expect(JSON.parse(String(init?.body))).toEqual({
      invitationId: "ivt_1",
      landingPath: "/invite/ivt_1",
    });
  });
});
