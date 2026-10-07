// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RegisterPage } from "./register-page";
import { createPasskeyCredential } from "../../../support/ui-support/passkey-browser";

vi.mock("../../../support/ui-support/passkey-browser", () => ({
  createPasskeyCredential: vi.fn(),
}));

const createPasskeyCredentialMock = vi.mocked(createPasskeyCredential);

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

beforeEach(() => {
  createPasskeyCredentialMock.mockRejectedValue(new Error("Passkeys are not available in this browser."));
});

function fillIdentity() {
  fireEvent.change(document.querySelector('input[name="displayName"]')!, {
    target: { value: "Todd" },
  });
  fireEvent.change(document.querySelector('input[name="email"]')!, {
    target: { value: "todd@example.com" },
  });
}

function inputNamed(name: string) {
  return document.querySelector(`input[name="${name}"]`) as HTMLInputElement;
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

describe("registration page", () => {
  it("defaults to passkeys and presents them as recommended", () => {
    const events: unknown[] = [];
    window.addEventListener("chase-sets:registration-method", (event) => {
      events.push((event as CustomEvent).detail);
    });

    render(<RegisterPage />);

    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1, name: "Create your account" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: /Passkey/ }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getAllByText("Recommended")).toHaveLength(1);
    expect(containingCard(screen.getByText("Recommended"))).toBe(
      containingCard(screen.getByRole("button", { name: "Create With Passkey" })),
    );
    expect(screen.queryByText("Fastest")).toBeNull();
    expect(screen.getByText(/Face ID, Touch ID, Windows Hello/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Create With Passkey" })).toBeTruthy();
    expect(screen.queryByLabelText("Password")).toBeNull();
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ method: "passkey", stage: "shown", priority: 1 }),
        expect.objectContaining({ method: "phone-code", stage: "shown", priority: 2 }),
        expect.objectContaining({ method: "magic-link", stage: "shown", priority: 3 }),
        expect.objectContaining({ method: "password", stage: "shown", priority: 4 }),
      ]),
    );
    expect(elevatedCardCount()).toBe(1);
    expect(document.querySelector(".rounded-tokenLg.overflow-hidden.ds-glow")).not.toBeNull();
    const socialCard = containingCard(screen.getByRole("link", { name: "Continue with Google" }));
    expect(socialCard.classList.contains("bg-surface-2")).toBe(false);
    expect(socialCard.classList.contains("shadow-tokenSm")).toBe(false);
    expect(socialCard.classList.contains("ds-glass")).toBe(false);
  });

  it("shows contextual registration copy when the return path needs an account gate", () => {
    render(
      <RegisterPage
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

  it.each(["Phone Code", "Magic Link", "Password"])(
    "keeps %s and the social row free of recommendation badges",
    (label) => {
      render(<RegisterPage />);
      fillIdentity();
      fireEvent.click(screen.getByRole("radio", { name: label }));
      expect(screen.getByRole("radio", { name: label }).getAttribute("aria-checked")).toBe("true");
      expect(screen.getByRole("heading", { level: 1, name: "Create your account" })).toBeTruthy();
      expect(screen.queryByText("Recommended")).toBeNull();
      expect(screen.queryByText("Fastest")).toBeNull();
      expect(inputNamed("displayName").value).toBe("Todd");
      fireEvent.click(screen.getByRole("radio", { name: "Passkey" }));
      expect(inputNamed("email").value).toBe("todd@example.com");
      expect(screen.getAllByText("Recommended")).toHaveLength(1);
    },
  );

  it("preserves registration notice, error, and native phone verification payload", () => {
    const action = "/register?returnTo=%2Faccount%2Fsell-list";
    render(
      <RegisterPage
        action={action}
        hiddenFields={[{ name: "returnTo", value: "/account/sell-list" }]}
        errorMessage="The previous code expired."
        notice={{
          status: "phone-code-sent",
          tokenId: "synthetic-registration-token",
          phone: "+13125550100",
          displayName: "Todd",
          expiresAt: "2099-01-01T00:00:00Z",
        }}
      />,
    );
    expect(screen.getByRole("alert").textContent).toContain("The previous code expired.");
    expect(screen.getByText("Phone code sent")).toBeTruthy();
    expect(screen.queryByText("Recommended")).toBeNull();
    expect(screen.queryByText("Fastest")).toBeNull();
    fireEvent.change(inputNamed("code"), { target: { value: "123456" } });
    const form = screen.getByRole("button", { name: "Create account with code" }).closest("form")!;
    expect(form.getAttribute("action")).toBe(action);
    expect(form.getAttribute("method")).toBe("post");
    expect(Object.fromEntries(new FormData(form))).toEqual({
      returnTo: "/account/sell-list",
      registrationMethod: "phone-code",
      registrationMethodsShown: "passkey,phone-code,magic-link,password",
      intent: "phone-code-consume",
      tokenId: "synthetic-registration-token",
      phone: "+13125550100",
      displayName: "Todd",
      code: "123456",
    });
    const submit = vi.fn((event: Event) => event.preventDefault());
    form.addEventListener("submit", submit);
    fireEvent.submit(form);
    expect(submit).toHaveBeenCalledOnce();
  });

  it("keeps entered identity details when moving to magic link", () => {
    render(<RegisterPage />);
    fillIdentity();

    fireEvent.click(screen.getByRole("radio", { name: /Magic Link/ }));

    expect(screen.getByRole("radio", { name: /Magic Link/ }).getAttribute("aria-checked")).toBe("true");
    expect(inputNamed("displayName").value).toBe("Todd");
    expect(inputNamed("email").value).toBe("todd@example.com");
    expect(screen.getByRole("button", { name: "Email me a magic link" })).toBeTruthy();
    expect(document.querySelector('input[name="intent"][value="magic-link-register"]')).not.toBeNull();
    expect(elevatedCardCount()).toBe(1);
  });

  it("offers phone code registration without requiring email", () => {
    render(<RegisterPage />);

    fireEvent.click(screen.getByRole("radio", { name: /Phone Code/ }));

    expect(screen.getByRole("radio", { name: /Phone Code/ }).getAttribute("aria-checked")).toBe("true");
    expect(inputNamed("phone")).toBeTruthy();
    expect(screen.queryByLabelText("Email")).toBeNull();
    expect(screen.getByRole("button", { name: "Text me a code" })).toBeTruthy();
    expect(document.querySelector('input[name="intent"][value="phone-code-request"]')).not.toBeNull();
    expect(inputNamed("code").getAttribute("autocomplete")).toBe("one-time-code");
    expect(elevatedCardCount()).toBe(2);
  });

  it("binds the issued phone challenge to the registration verification form", () => {
    render(
      <RegisterPage
        notice={{
          status: "phone-code-sent",
          tokenId: "cmd_phone_registration",
          phone: "+13125550100",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          displayName: "Todd",
        }}
      />,
    );

    expect(inputNamed("tokenId").value).toBe("cmd_phone_registration");
  });

  it("keeps password registration available as the fallback", () => {
    render(<RegisterPage />);

    fireEvent.click(screen.getByRole("radio", { name: /Password/ }));

    expect(screen.getByText("Use this fallback when passkeys and magic links are not available.")).toBeTruthy();
    expect(inputNamed("password")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Create account with password" })).toBeTruthy();
    expect(document.querySelector('input[name="intent"][value="password"]')).not.toBeNull();
    expect(elevatedCardCount()).toBe(1);
  });

  it("identifies registration fields for browser and password-manager autofill", () => {
    render(<RegisterPage />);

    expect(inputNamed("displayName").getAttribute("autocomplete")).toBe("name");
    expect(inputNamed("email").getAttribute("autocomplete")).toBe("email");

    fireEvent.click(screen.getByRole("radio", { name: /Phone Code/ }));

    expect(inputNamed("displayName").getAttribute("autocomplete")).toBe("name");
    expect(Array.from(document.querySelectorAll('input[name="phone"]'))).toHaveLength(2);
    for (const phoneInput of document.querySelectorAll('input[name="phone"]')) {
      expect(phoneInput.getAttribute("autocomplete")).toBe("tel");
    }
    expect(inputNamed("code").getAttribute("autocomplete")).toBe("one-time-code");

    fireEvent.click(screen.getByRole("radio", { name: /Password/ }));

    expect(inputNamed("password").getAttribute("autocomplete")).toBe("new-password");
  });

  it("posts registration forms to the supplied auth action so return targets survive", () => {
    const action = "/register?returnTo=%2Faccount%2Fsell-list%3FregistrationReturn%3Dseller-checkout";
    render(<RegisterPage action={action} />);

    fireEvent.click(screen.getByRole("radio", { name: /Password/ }));

    const passwordForm = document.querySelector('input[name="intent"][value="password"]')?.closest("form");

    expect(passwordForm?.getAttribute("action")).toBe(action);
  });

  it("explains passkey failures and lets the user continue with magic link without losing progress", async () => {
    render(<RegisterPage />);
    fillIdentity();

    fireEvent.submit(screen.getByRole("button", { name: "Create With Passkey" }).closest("form")!);

    expect(await screen.findByText("Passkeys are not available in this browser.")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Use magic link" }));

    expect(inputNamed("displayName").value).toBe("Todd");
    expect(inputNamed("email").value).toBe("todd@example.com");
    expect(screen.getByRole("button", { name: "Email me a magic link" })).toBeTruthy();
  });
});
