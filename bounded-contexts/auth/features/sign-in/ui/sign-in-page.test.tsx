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

function elevatedCardCount() {
  return document.querySelectorAll(".rounded-tokenLg.overflow-hidden.shadow-tokenSm").length;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("sign-in page two-step journey", () => {
  it("starts with social login and one sign-in identifier field", () => {
    render(<SignInPage />);

    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1, name: "Sign In" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Continue with Google" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Continue with Facebook" })).toBeTruthy();
    expect(screen.getByLabelText(/Email or phone/).getAttribute("autocomplete")).toBe("username");
    expect(screen.queryByRole("tab", { name: "Passkey" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Use Passkey" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Send Phone Code" })).toBeNull();
    expect(elevatedCardCount()).toBe(1);
    expect(document.querySelectorAll(".rounded-tokenLg.overflow-hidden.shadow-tokenLg")).toHaveLength(0);
  });

  it("shows contextual sign-in copy when the return path needs an account gate", () => {
    render(
      <SignInPage
        contextMessage={{
          title: "Use an account to continue seller checkout",
          description:
            "Your Sell List is saved. An account is required before offer acceptance, listing publication, payout, or shipping label work starts.",
        }}
      />,
    );

    expect(screen.getByText("Use an account to continue seller checkout")).toBeTruthy();
    expect(
      screen.getByText(
        "Your Sell List is saved. An account is required before offer acceptance, listing publication, payout, or shipping label work starts.",
      ),
    ).toBeTruthy();
  });

  it("preserves the identifier form payload after migrating to the shared Form pattern", () => {
    render(<SignInPage />);

    const identifier = screen.getByLabelText(/Email or phone/);
    fireEvent.change(identifier, { target: { value: "buyer@example.com" } });

    const form = identifier.closest("form");
    if (!form) {
      throw new Error("Expected identifier field to belong to a form.");
    }

    expect(new FormData(form).get("signInIdentifier")).toBe("buyer@example.com");
    expect(form.querySelector('button[type="submit"]')?.textContent).toBe("Continue");
  });

  it("posts credential forms to the supplied auth action so return targets survive", () => {
    const action = "/sign-in?returnTo=%2Faccount%2Fsell-list%3FregistrationReturn%3Dseller-checkout";
    render(<SignInPage action={action} />);

    continueWithIdentifier("buyer@example.com");
    fireEvent.click(screen.getByRole("radio", { name: "Password" }));

    const passwordForm = document.querySelector('input[name="intent"][value="password"]')?.closest("form");

    expect(passwordForm?.getAttribute("action")).toBe(action);
  });

  it("hydrates an identifier submitted before client-side state is ready", () => {
    render(<SignInPage initialIdentifier="buyer@example.com" returnTo="/account/sell-list" />);

    expect(screen.getByText("Signing in with buyer@example.com")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Use Passkey" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Passkey" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.queryByLabelText(/Email or phone/)).toBeNull();
  });

  it("can hydrate the password method from an identifier GET fallback", () => {
    render(<SignInPage initialIdentifier="buyer@example.com" initialMethod="password" returnTo="/account/sell-list" />);

    expect(screen.getByText("Signing in with buyer@example.com")).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Password" }).getAttribute("aria-checked")).toBe("true");
    expect(document.querySelector('input[name="password"]')?.getAttribute("autocomplete")).toBe("current-password");
    expect(elevatedCardCount()).toBe(1);
  });

  it("rehydrates the failed method step and focuses the announced error", () => {
    render(
      <SignInPage
        errorMessage="Invalid email or password."
        initialIdentifier="buyer@example.com"
        initialMethod="password"
      />,
    );

    const error = screen.getByRole("alert");
    expect(error.getAttribute("aria-live")).toBe("assertive");
    expect(error).toBe(document.activeElement);
    expect(screen.getByText("Signing in with buyer@example.com")).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Password" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByLabelText("Password")).toBeTruthy();
    expect(screen.queryByLabelText(/Email or phone/)).toBeNull();
  });

  it("preserves return targets when the identifier form falls back to a GET submit", () => {
    render(<SignInPage returnTo="/account/sell-list" />);

    const identifier = screen.getByLabelText(/Email or phone/);
    const form = identifier.closest("form");
    if (!form) {
      throw new Error("Expected identifier field to belong to a form.");
    }

    expect(new FormData(form).get("returnTo")).toBe("/account/sell-list");
    expect(new FormData(form).get("signInMethod")).toBe("password");
  });

  it("can render an admin Google Workspace SSO entry point", () => {
    render(
      <SignInPage
        socialLoginDescription="Use your Chase Sets Google Workspace account."
        socialLoginLinks={[
          {
            href: "/api/auth/social/google/start?journey=admin&returnTo=%2Faccess%2Faccounts",
            label: "Continue with Google Workspace",
            icon: "badgeCheck",
          },
        ]}
      />,
    );

    expect(screen.getByText("Use your Chase Sets Google Workspace account.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Continue with Google Workspace" }).getAttribute("href")).toBe(
      "/api/auth/social/google/start?journey=admin&returnTo=%2Faccess%2Faccounts",
    );
    expect(screen.queryByRole("link", { name: "Continue with Facebook" })).toBeNull();
  });

  it("recommends passkey first after an email identifier", () => {
    render(<SignInPage />);

    continueWithIdentifier("buyer@example.com");

    expect(screen.getByText("Signing in with buyer@example.com")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Use Passkey" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Passkey" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("radio", { name: "Magic Link" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Password" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Continue with Google" })).toBeNull();
    expect(elevatedCardCount()).toBe(1);
  });

  it("uses phone code after a phone identifier", () => {
    render(<SignInPage />);

    continueWithIdentifier("3125550100");

    expect(screen.getByText("Signing in with 3125550100")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Send Phone Code" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Continue With Code" })).toBeTruthy();
    expect(screen.getByLabelText("Phone Code").getAttribute("autocomplete")).toBe("one-time-code");
    expect(screen.queryByRole("radio", { name: "Passkey" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Use Passkey" })).toBeNull();
    expect(elevatedCardCount()).toBe(1);
  });

  it("binds the issued phone challenge to the verification form", () => {
    render(
      <SignInPage
        notice={{
          status: "phone-code-sent",
          tokenId: "cmd_phone_sign_in",
          phone: "+13125550100",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        }}
      />,
    );

    expect((document.querySelector('input[name="tokenId"]') as HTMLInputElement).value).toBe("cmd_phone_sign_in");
  });

  it("keeps secondary options behind the identifier step", () => {
    render(<SignInPage />);

    expect(screen.queryByRole("radio", { name: "Magic Link" })).toBeNull();

    continueWithIdentifier("buyer@example.com");
    fireEvent.click(screen.getByRole("radio", { name: "Magic Link" }));

    expect(screen.getByRole("button", { name: "Send Magic Link" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Send Phone Code" })).toBeNull();
    expect(elevatedCardCount()).toBe(1);
  });

  it("keeps the no-compatible-methods state free of cards", () => {
    render(<SignInPage signInMethods={[]} />);

    continueWithIdentifier("buyer@example.com");

    expect(screen.getByText("No sign-in method available")).toBeTruthy();
    expect(elevatedCardCount()).toBe(0);
    expect(document.querySelectorAll(".rounded-tokenLg.overflow-hidden")).toHaveLength(0);
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
    fireEvent.click(screen.getByRole("radio", { name: /Magic Link/ }));

    expect(screen.getByRole("button", { name: "Send Magic Link" })).toBeTruthy();
    expect(screen.queryByLabelText("Magic Link Token")).toBeNull();
    expect(screen.queryByRole("button", { name: "Continue With Token" })).toBeNull();
    expect(document.querySelector('input[name="intent"][value="magic-link-consume"]')).toBeNull();
  });

  it("rejects crafted manual magic-link consumes when host config disables token entry", async () => {
    const host = defineAuthHost({
      signInPath: "/access/sign-in",
      fallbackPath: "/access/accounts",
      defaultSuccessPath: "/access/accounts",
      accountSelectionPath: "/access/account-select",
      signedOutReturnTo: "/access/sign-in",
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
        request: new Request("https://admin.chasesets.test/access/sign-in", {
          method: "POST",
          body: form,
        }),
        params: {},
        context: {},
      } as never),
    ).resolves.toEqual({
      error: "Magic link token entry is not available here.",
      method: "magic-link",
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});
