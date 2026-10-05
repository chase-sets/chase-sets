// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SignInPage } from "./sign-in-page";
import { defineAuthHost } from "../../../support/route-support/auth-host";
import { adminAuthHostConfig, marketplaceAuthHostConfig } from "../../../support/route-support/host-config";
import { getPasskeyCredential } from "../../../support/ui-support/passkey-browser";

vi.mock("../../../support/ui-support/passkey-browser", () => ({
  getPasskeyCredential: vi.fn(),
}));

function continueWithIdentifier(identifier: string) {
  fireEvent.change(screen.getByLabelText(/Email or phone/), {
    target: { value: identifier },
  });
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
}

function elevatedCardCount() {
  return document.querySelectorAll(".rounded-tokenLg.overflow-hidden.shadow-tokenSm").length;
}

function containingCard(element: HTMLElement) {
  const card = element.closest<HTMLElement>(".rounded-tokenLg.overflow-hidden");
  if (!card) {
    throw new Error("Expected element to be rendered inside a Card.");
  }
  return card;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("sign-in page two-step journey", () => {
  it.each([
    ["marketplace", marketplaceAuthHostConfig.signInMethods],
    ["access-admin", adminAuthHostConfig.signInMethods],
    ["password-only", ["password"] as const],
    ["empty", [] as const],
  ])("lists only configured %s methods before Continue without looking up an account", (_host, signInMethods) => {
    const fetchMock = vi.fn(() => {
      throw new Error("The identifier step must not look up an account.");
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<SignInPage signInMethods={signInMethods} />);

    const labels = {
      password: "Password",
      "phone-code": "Phone Code",
      "magic-link": "Email me a sign-in link",
      passkey: "Passkey",
    };
    function expectConfiguredList() {
      expect(Boolean(screen.queryByText("You can sign in with"))).toBe(signInMethods.length > 0);
      for (const [method, label] of Object.entries(labels)) {
        const text = screen.queryByText(label, { exact: true });
        expect(Boolean(text)).toBe(signInMethods.some((configured) => configured === method));
        expect(text?.closest('button, a, input, [role="radio"], [role="tab"]') ?? null).toBeNull();
      }
      expect(screen.queryByRole("radiogroup")).toBeNull();
      expect(document.querySelector('input[name="intent"]')).toBeNull();
      expect(screen.queryByText("No sign-in method available")).toBeNull();
    }

    expectConfiguredList();
    continueWithIdentifier("buyer@example.com");
    expect(screen.queryByText("You can sign in with")).toBeNull();
    if (signInMethods.length === 0) {
      expect(screen.getByText("No sign-in method available")).toBeTruthy();
    }
    fireEvent.click(screen.getByRole("button", { name: "Change" }));
    expectConfiguredList();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getPasskeyCredential).not.toHaveBeenCalled();
  });

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
    const socialCard = containingCard(screen.getByRole("link", { name: "Continue with Google" }));
    expect(socialCard.classList.contains("bg-surface-2")).toBe(false);
    expect(socialCard.classList.contains("shadow-tokenSm")).toBe(false);
    expect(socialCard.classList.contains("ds-glass")).toBe(false);
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
    expect(screen.getByRole("radio", { name: "Email me a sign-in link" })).toBeTruthy();
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

    expect(screen.queryByRole("radio", { name: "Email me a sign-in link" })).toBeNull();

    continueWithIdentifier("buyer@example.com");
    fireEvent.click(screen.getByRole("radio", { name: "Email me a sign-in link" }));

    expect(screen.getByRole("button", { name: "Email me a sign-in link" })).toBeTruthy();
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

describe("sign-in method presentation and native submissions", () => {
  const action = "/access/sign-in?returnTo=%2Faccess%2Faccounts";
  const hiddenFields = [{ name: "returnTo", value: "/access/accounts" }];

  function formFor(intent: string) {
    const form = document.querySelector(`input[name="intent"][value="${intent}"]`)?.closest("form");
    if (!form) throw new Error(`Missing form for ${intent}`);
    expect(form.getAttribute("action")).toBe(action);
    expect(form.getAttribute("method")).toBe("post");
    const submit = vi.fn((event: Event) => event.preventDefault());
    form.addEventListener("submit", submit);
    fireEvent.submit(form);
    expect(submit).toHaveBeenCalledOnce();
    return Object.fromEntries(new FormData(form));
  }

  it.each([
    ["multiple email methods", ["passkey", "magic-link", "password"] as const],
    ["email link alone", ["magic-link"] as const],
  ])("explains email links with the mail glyph and preserves the request for %s", (_name, signInMethods) => {
    render(<SignInPage action={action} hiddenFields={hiddenFields} signInMethods={signInMethods} />);
    continueWithIdentifier("buyer@example.com");

    if (signInMethods.length > 1) {
      const option = screen.getByRole("radio", { name: "Email me a sign-in link" }) as HTMLButtonElement;
      expect(option.disabled).toBe(false);
      expect(option.querySelector("svg.lucide-mail")).not.toBeNull();
      expect(option.querySelector("svg.lucide-message-square")).toBeNull();
      fireEvent.click(option);
      expect(option.getAttribute("aria-checked")).toBe("true");
    } else {
      expect(screen.queryByRole("radiogroup")).toBeNull();
    }

    expect(screen.getByText("We'll email you a one-time link.")).toBeTruthy();
    const button = screen.getByRole("button", { name: "Email me a sign-in link" }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    expect(button.querySelector("svg.lucide-mail")).not.toBeNull();
    expect(formFor("magic-link-request")).toEqual({
      returnTo: "/access/accounts",
      intent: "magic-link-request",
      email: "buyer@example.com",
    });
    expect(screen.queryByLabelText("Magic Link Token")).toBeNull();
    expect(document.querySelector('input[name="intent"][value="magic-link-consume"]')).toBeNull();
  });

  it("preserves password POST fields", () => {
    render(<SignInPage action={action} hiddenFields={hiddenFields} />);
    continueWithIdentifier("buyer@example.com");
    fireEvent.click(screen.getByRole("radio", { name: "Password" }));
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "synthetic-password" } });
    expect(formFor("password")).toEqual({
      returnTo: "/access/accounts",
      intent: "password",
      email: "buyer@example.com",
      password: "synthetic-password",
    });
  });

  it("keeps phone-only requests on the message glyph and consumes the rehydrated challenge", () => {
    const { rerender } = render(
      <SignInPage action={action} hiddenFields={hiddenFields} signInMethods={["phone-code"]} />,
    );
    continueWithIdentifier("+13125550100");
    expect(screen.queryByRole("radiogroup")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Send Phone Code" }).querySelector("svg.lucide-message-square"),
    ).not.toBeNull();
    expect(formFor("phone-code-request")).toEqual({
      returnTo: "/access/accounts",
      intent: "phone-code-request",
      phone: "+13125550100",
    });
    rerender(
      <SignInPage
        action={action}
        hiddenFields={hiddenFields}
        signInMethods={["phone-code"]}
        notice={{
          status: "phone-code-sent",
          tokenId: "synthetic-phone-token",
          phone: "+13125550100",
          expiresAt: "2099-01-01T00:00:00Z",
        }}
      />,
    );
    expect(screen.getByText("Phone code sent")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Phone Code"), { target: { value: "123456" } });
    expect(formFor("phone-code-consume")).toEqual({
      returnTo: "/access/accounts",
      intent: "phone-code-consume",
      phone: "+13125550100",
      tokenId: "synthetic-phone-token",
      code: "123456",
    });
  });

  it("posts the existing passkey credential payload after the browser ceremony", async () => {
    const payload = {
      challengeId: "synthetic-challenge-id",
      challenge: "synthetic-challenge",
      externalCredentialId: "synthetic-credential",
      label: "Synthetic passkey",
      webauthnResponse: "{}",
    };
    vi.mocked(getPasskeyCredential).mockResolvedValueOnce(payload);
    const requestSubmit = vi.spyOn(HTMLFormElement.prototype, "requestSubmit").mockImplementation(() => {});
    render(<SignInPage action={action} hiddenFields={hiddenFields} />);
    continueWithIdentifier("buyer@example.com");
    fireEvent.submit(screen.getByRole("button", { name: "Use Passkey" }).closest("form")!);
    await waitFor(() => expect(requestSubmit).toHaveBeenCalledOnce());
    expect(getPasskeyCredential).toHaveBeenCalledExactlyOnceWith("buyer@example.com");
    expect(formFor("passkey-sign-in")).toEqual({
      returnTo: "/access/accounts",
      intent: "passkey-sign-in",
      email: "buyer@example.com",
      ...payload,
    });
  });

  it("rehydrates the email notice and error without enabling manual token entry", () => {
    render(
      <SignInPage
        action={action}
        hiddenFields={hiddenFields}
        signInMethods={["magic-link"]}
        errorMessage="The previous link expired."
        allowManualMagicLinkTokenEntry={false}
        notice={{
          status: "magic-link-sent",
          tokenId: "synthetic-email-token",
          email: "buyer@example.com",
          expiresAt: "2099-01-01T00:00:00Z",
        }}
      />,
    );
    expect(screen.getByRole("alert").textContent).toContain("The previous link expired.");
    expect(document.activeElement).toBe(screen.getByRole("alert"));
    expect(screen.getByText("Magic link sent")).toBeTruthy();
    expect(screen.getByText("Signing in with buyer@example.com")).toBeTruthy();
    expect(screen.getByText("We'll email you a one-time link.")).toBeTruthy();
    expect(screen.queryByRole("radiogroup")).toBeNull();
    expect(screen.queryByLabelText("Magic Link Token")).toBeNull();
    expect(formFor("magic-link-request").email).toBe("buyer@example.com");
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
    fireEvent.click(screen.getByRole("radio", { name: "Email me a sign-in link" }));

    expect(screen.getByRole("button", { name: "Email me a sign-in link" })).toBeTruthy();
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
