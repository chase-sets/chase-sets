// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SignInPage } from "./sign-in-page";
import { defineAuthHost } from "../../../support/route-support/auth-host";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("sign-in page magic link recovery", () => {
  it("shows email-only magic link success without same-browser recovery controls", () => {
    render(
      <SignInPage
        notice={{
          status: "magic-link-sent",
          tokenId: "cmd_magic",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        }}
      />,
    );

    expect(screen.getByText("Magic link sent")).toBeTruthy();
    expect(screen.getByText("Magic link ready. Check your email to continue.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Continue With Token" })).toBeNull();
    expect(
      document.querySelector('input[name="intent"][value="magic-link-consume"]'),
    ).toBeNull();
  });

  it("does not render manual token entry when host config disables it", () => {
    render(<SignInPage allowManualMagicLinkTokenEntry={false} />);

    fireEvent.click(screen.getByRole("tab", { name: /Magic Link/ }));

    expect(screen.getByRole("button", { name: "Send Magic Link" })).toBeTruthy();
    expect(screen.queryByLabelText("Magic Link Token")).toBeNull();
    expect(screen.queryByRole("button", { name: "Continue With Token" })).toBeNull();
    expect(
      document.querySelector('input[name="intent"][value="magic-link-consume"]'),
    ).toBeNull();
  });

  it("rejects crafted manual magic-link consumes when host config disables token entry", async () => {
    const host = defineAuthHost({
      signInPath: "/identity/sign-in",
      fallbackPath: "/identity/accounts",
      defaultSuccessPath: "/identity/accounts",
      accountSelectionPath: "/identity/account-select",
      signedOutReturnTo: "/identity/sign-in",
      allowManualMagicLinkTokenEntry: false,
    });
    const action = host.createSignInAction();
    const form = new FormData();
    form.set("intent", "magic-link-consume");
    form.set("token", "magic_token");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("manual token entry should be rejected before the API call");
      }),
    );

    await expect(
      action({
        request: new Request("https://admin.chasesets.test/identity/sign-in", {
          method: "POST",
          body: form,
        }),
        params: {},
        context: {},
      }),
    ).resolves.toEqual({
      error: "Magic link token entry is not available here.",
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});
