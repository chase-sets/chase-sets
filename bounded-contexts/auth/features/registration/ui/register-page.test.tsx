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

const activeRegistrationConsent = {
  operationId: "cmd_registration",
  snapshot: {
    bundleKey: "registration" as const,
    requirements: [
      { policyKey: "terms-of-service" as const, version: "v1" as const, href: "/terms" },
      { policyKey: "privacy-policy" as const, version: "v1" as const, href: "/privacy" },
    ],
  },
};

describe("registration page", () => {
  it("defaults to passkeys and presents them as recommended", () => {
    const events: unknown[] = [];
    window.addEventListener("chase-sets:registration-method", (event) => {
      events.push((event as CustomEvent).detail);
    });

    render(<RegisterPage registrationConsent={activeRegistrationConsent} />);

    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1, name: "Create an account with a passkey" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: /Passkey/ }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText("Recommended")).toBeTruthy();
    expect(screen.getByText(/Face ID, Touch ID, Windows Hello/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Create With Passkey" })).toBeTruthy();
    expect(screen.queryByLabelText("Password")).toBeNull();
    expect(screen.getAllByRole("checkbox", { name: /I agree/ })).toHaveLength(1);
    expect(screen.getByRole("link", { name: /Terms of Service/ }).getAttribute("href")).toBe("/terms");
    expect(screen.getByRole("link", { name: /Privacy Policy/ }).getAttribute("href")).toBe("/privacy");
    expect(inputNamed("consentAffirmed").value).toBe("false");
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ method: "passkey", stage: "shown", priority: 1 }),
        expect.objectContaining({ method: "phone-code", stage: "shown", priority: 2 }),
        expect.objectContaining({ method: "magic-link", stage: "shown", priority: 3 }),
        expect.objectContaining({ method: "password", stage: "shown", priority: 4 }),
      ]),
    );
  });

  it("carries one explicit affirmation across every registration method", () => {
    render(<RegisterPage registrationConsent={activeRegistrationConsent} />);

    fireEvent.click(screen.getByRole("checkbox", { name: /I agree/ }));
    expect(inputNamed("consentAffirmed").value).toBe("true");

    fireEvent.click(screen.getByRole("radio", { name: /Phone Code/ }));
    for (const affirmation of document.querySelectorAll<HTMLInputElement>('input[name="consentAffirmed"]')) {
      expect(affirmation.value).toBe("true");
    }

    fireEvent.click(screen.getByRole("radio", { name: /Password/ }));
    expect(inputNamed("consentAffirmed").value).toBe("true");
  });

  it("renders no operative affirmation for an empty bundle", () => {
    render(
      <RegisterPage
        registrationConsent={{
          operationId: "cmd_empty",
          snapshot: { bundleKey: "registration", requirements: [] },
        }}
      />,
    );

    expect(screen.queryByRole("checkbox", { name: /I agree/ })).toBeNull();
    expect(screen.queryByRole("link", { name: "Terms of Service" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Privacy Policy" })).toBeNull();
  });

  it("renders exactly the server-resolved partial bundle and submits its ordered identity", () => {
    const partial = {
      operationId: "cmd_partial",
      snapshot: {
        bundleKey: "registration" as const,
        requirements: [{ policyKey: "privacy-policy" as const, version: "v7" as const, href: "/privacy-canonical" }],
      },
    };
    render(<RegisterPage registrationConsent={partial} />);

    expect(screen.queryByRole("link", { name: "Terms of Service" })).toBeNull();
    expect(screen.getByRole("link", { name: "Privacy Policy" }).getAttribute("href")).toBe("/privacy-canonical");
    expect(screen.getByText(/privacy-policy · v7/)).toBeTruthy();
    expect(JSON.parse(inputNamed("registrationConsent").value)).toEqual(partial);
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

  it("keeps entered identity details when moving to magic link", () => {
    render(<RegisterPage />);
    fillIdentity();

    fireEvent.click(screen.getByRole("radio", { name: /Magic Link/ }));

    expect(screen.getByRole("radio", { name: /Magic Link/ }).getAttribute("aria-checked")).toBe("true");
    expect(inputNamed("displayName").value).toBe("Todd");
    expect(inputNamed("email").value).toBe("todd@example.com");
    expect(screen.getByRole("button", { name: "Email me a magic link" })).toBeTruthy();
    expect(document.querySelector('input[name="intent"][value="magic-link-register"]')).not.toBeNull();
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
