// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SignInPage } from "./sign-in-page";
import { defineAuthHost } from "../../../support/route-support/auth-host";

function continueWithIdentifier(identifier: string) {
  fireEvent.change(screen.getByLabelText(/Email or phone/), {
    target: { value: identifier },
  });
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("sign-in page two-step journey", () => {
  it("starts with social login and one sign-in identifier field", () => {
    render(<SignInPage />);

    expect(screen.getByRole("link", { name: "Continue with Google" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Continue with Facebook" })).toBeTruthy();
    expect(screen.getByLabelText(/Email or phone/)).toBeTruthy();
    expect(screen.queryByRole("tab", { name: "Passkey" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Use Passkey" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Send Phone Code" })).toBeNull();
  });

  it("recommends passkey first after an email identifier", () => {
    render(<SignInPage />);

    continueWithIdentifier("buyer@example.com");

    expect(screen.getByText("Signing in with buyer@example.com")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Use Passkey" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Passkey" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tab", { name: "Magic Link" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Password" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Continue with Google" })).toBeNull();
  });

  it("uses phone code after a phone identifier", () => {
    render(<SignInPage />);

    continueWithIdentifier("3125550100");

    expect(screen.getByText("Signing in with 3125550100")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Send Phone Code" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Continue With Code" })).toBeTruthy();
    expect(screen.queryByRole("tab", { name: "Passkey" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Use Passkey" })).toBeNull();
  });

  it("keeps secondary options behind the identifier step", () => {
    render(<SignInPage />);

    expect(screen.queryByRole("tab", { name: "Magic Link" })).toBeNull();

    continueWithIdentifier("buyer@example.com");
    fireEvent.click(screen.getByRole("tab", { name: "Magic Link" }));

    expect(screen.getByRole("button", { name: "Send Magic Link" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Send Phone Code" })).toBeNull();
  });
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
    expect(screen.queryByRole("button", { name: "Continue With Token" })).toBeNull();
    expect(document.querySelector('input[name="intent"][value="magic-link-consume"]')).toBeNull();
  });

  it("does not render manual token entry when host config disables it", () => {
    render(<SignInPage allowManualMagicLinkTokenEntry={false} />);

    continueWithIdentifier("buyer@example.com");
    fireEvent.click(screen.getByRole("tab", { name: /Magic Link/ }));

    expect(screen.getByRole("button", { name: "Send Magic Link" })).toBeTruthy();
    expect(screen.queryByLabelText("Magic Link Token")).toBeNull();
    expect(screen.queryByRole("button", { name: "Continue With Token" })).toBeNull();
    expect(document.querySelector('input[name="intent"][value="magic-link-consume"]')).toBeNull();
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
