import type { ActionFunctionArgs } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import { t } from "@chase-sets/localization";
import { action } from "./invite";

const marker = "Bearer synthetic-invitation-token-marker";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function args(): ActionFunctionArgs {
  const request = new Request("https://marketplace.test/invite/inv_test", {
    method: "POST",
    body: new URLSearchParams({ token: marker, password: "synthetic-password" }),
  });
  return {
    request,
    params: { invitationId: "inv_test" },
    context: {},
    url: new URL(request.url),
    pattern: "/invite/:invitationId",
  };
}

it.each([
  [
    401,
    { error: `Invitation acceptance token is invalid or expired. ${marker}` },
    "auth.support.routeSupport.authHost.request.failed",
  ],
  [
    400,
    { error: { code: "registration_consent_expired", message: marker, reason: "expired" } },
    "auth.support.apiSupport.socialLoginRoutes.registration.consent.unavailable",
  ],
] as const)("returns safe FORM copy for an invitation rejection at %s", async (status, body, key) => {
  const logs = [vi.spyOn(console, "error"), vi.spyOn(console, "warn")];
  const fetch = vi.fn().mockResolvedValue(Response.json(body, { status }));
  vi.stubGlobal("fetch", fetch);
  const result = await action(args());
  expect(result).toEqual({
    error: t(key),
    intent: "invitation-accept",
    classification: "FORM",
    errors: { fieldErrors: {}, formErrors: [t(key)] },
  });
  expect(fetch).toHaveBeenCalledOnce();
  expect(JSON.stringify(result)).not.toContain(marker);
  expect(JSON.stringify(logs.map((log) => log.mock.calls))).not.toContain(marker);
});

it("rethrows non-API, non-transient invitation errors", async () => {
  const failure = new Error("synthetic programming failure");
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(failure));
  await expect(action(args())).rejects.toBe(failure);
});
