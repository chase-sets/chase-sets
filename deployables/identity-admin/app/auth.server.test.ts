import { describe, expect, it } from "vitest";
import { identityAdminAuthHost } from "../../../bounded-contexts/auth/host-config";

describe("identity admin auth host", () => {
  it("clears auth cookies and redirects to the signed-out path", async () => {
    const action = identityAdminAuthHost.createSignOutAction();

    const response = await action({
      request: new Request("http://identity-admin.test/sign-out", {
        method: "POST",
        headers: {
          cookie:
            "chase_sets_session=session_token; chase_sets_account_selection=selection_token",
        },
      }),
    } as never);

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/sign-in");
    expect(response.headers.get("Set-Cookie")).toContain("chase_sets_session=");
    expect(response.headers.get("Set-Cookie")).toContain(
      "chase_sets_account_selection=",
    );
  });
});
