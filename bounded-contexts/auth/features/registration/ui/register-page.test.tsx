// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RegisterPage } from "./register-page";
import { createPasskeyCredential } from "../../../support/ui-support/passkey-browser";
import MarketplaceRegisterRoute, { loader } from "../../../routes/marketplace/register";
import { missingPhoneFailure, renderAuthRoute, safeFailure } from "../../../tests/auth-form-route-test-support";
import { redirect } from "react-router";

vi.mock("../../../support/route-support/auth-host.server", async () => {
  const { defineAuthHost } = await import("../../../support/route-support/auth-host");
  const { marketplaceAuthHostConfig } = await import("../../../support/route-support/host-config");
  return { marketplaceAuthHost: defineAuthHost(marketplaceAuthHostConfig) };
});

vi.mock("../../../support/ui-support/passkey-browser", () => ({
  createPasskeyCredential: vi.fn(),
}));

const createPasskeyCredentialMock = vi.mocked(createPasskeyCredential);

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("routed registration errors", () => {
  it.each(["phone-code-request", "phone-code-consume"] as const)("safe fields: %s links only its mounted phone, with ARIA before focus", async (intent) => {
    const route = await renderAuthRoute({ path: "/register", Component: MarketplaceRegisterRoute, loader }, "/register");
    fireEvent.click(screen.getByRole("radio", { name: "Phone Code" }));
    const form = document.querySelector(`input[name="intent"][value="${intent}"]`)!.closest("form")!;
    const phone = form.querySelector<HTMLInputElement>('input[name="phone"]')!;
    let invalidAtFocus: string | null = null;
    let descriptionAtFocus: string | null = null;
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    focus.mockImplementation(function (this: HTMLElement) {
      if (this.tagName === "SECTION") {
        invalidAtFocus = phone.getAttribute("aria-invalid");
        descriptionAtFocus = phone.getAttribute("aria-describedby");
      }
      focus.mockRestore();
      this.focus();
    });
    fireEvent.submit(form);
    await waitFor(() => expect(route.requests).toHaveBeenCalledOnce());
    await route.settle(await missingPhoneFailure(intent));
    expect(invalidAtFocus).toBe("true");
    expect(document.getElementById(descriptionAtFocus!)?.textContent).toBe("Phone is required.");
    const summary = screen.getByRole("alert");
    expect(document.activeElement).toBe(summary);
    const link = screen.getByRole("link", { name: /Phone.*Phone is required/ });
    expect(link.getAttribute("href")).toBe(`#${phone.id}`);
    fireEvent.keyDown(link, { key: "Enter" });
    expect(document.activeElement).toBe(phone);
    const otherPhone = [...document.querySelectorAll('input[name="phone"]')].find((element) => element !== phone)!;
    expect(otherPhone.getAttribute("aria-invalid")).toBeNull();
    await route.revalidate();
    expect(document.activeElement).toBe(phone);
    fireEvent.click(screen.getByRole("radio", { name: "Password" }));
    expect(screen.queryByRole("alert")).toBeNull();
    route.router.dispose();
  });

  it("focus lifecycle: clears on accepted start, focuses identical results separately, then phone success and navigation", async () => {
    const route = await renderAuthRoute({ path: "/register", Component: MarketplaceRegisterRoute, loader }, "/register");
    fireEvent.click(screen.getByRole("radio", { name: "Phone Code" }));
    const button = screen.getByRole("button", { name: "Text me a code" });
    for (let attempt = 1; attempt <= 2; attempt++) {
      button.focus();
      fireEvent.submit(button.closest("form")!);
      await waitFor(() => expect(route.requests).toHaveBeenCalledTimes(attempt));
      expect(screen.queryByRole("alert")).toBeNull();
      expect(document.activeElement).toBe(button);
      await route.settle(await missingPhoneFailure("phone-code-request"), true);
      expect(screen.queryByRole("alert")).toBeNull();
      await route.finishLoading();
      expect(document.activeElement).toBe(screen.getByRole("alert"));
      button.focus();
      await route.revalidate();
      expect(document.activeElement).toBe(button);
    }
    fireEvent.submit(button.closest("form")!);
    await waitFor(() => expect(route.requests).toHaveBeenCalledTimes(3));
    await route.settle({ status: "phone-code-sent", phone: "+13125550100", tokenId: "synthetic-token", expiresAt: "2099-01-01T00:00:00Z" });
    expect(document.activeElement).toBe(screen.getByLabelText("Phone Code"));
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.submit(screen.getByRole("button", { name: "Create account with code" }).closest("form")!);
    await waitFor(() => expect(route.requests).toHaveBeenCalledTimes(4));
    await route.settle(redirect("/done"));
    expect(screen.getByText("Authenticated destination")).toBeTruthy();
    route.router.dispose();
  });

  it("auth parity: unknown fields and browser failures never expose markers in DOM or analytics", async () => {
    const events: unknown[] = [];
    const listener = (event: Event) => events.push((event as CustomEvent).detail);
    window.addEventListener("chase-sets:registration-method", listener);
    createPasskeyCredentialMock.mockRejectedValueOnce(new Error("RAW_PASSKEY_SECRET_MARKER"));
    const route = await renderAuthRoute({ path: "/register", Component: MarketplaceRegisterRoute, loader }, "/register");
    fireEvent.submit(screen.getByRole("button", { name: "Create With Passkey" }).closest("form")!);
    expect((await screen.findByRole("alert")).textContent).toContain("Passkey registration failed.");
    expect(document.activeElement).toBe(screen.getByRole("alert"));
    fireEvent.click(screen.getByRole("radio", { name: "Password" }));
    fireEvent.submit(screen.getByRole("button", { name: "Create account with password" }).closest("form")!);
    await waitFor(() => expect(route.requests).toHaveBeenCalledOnce());
    await route.settle(safeFailure("password", 400, { error: { code: "validation_failed", message: "RAW_AUTH_MARKER", details: [{ field: "email", code: "phone_required", message: "RAW_AUTH_MARKER" }] } }));
    expect(screen.getByRole("alert").querySelector("a")).toBeNull();
    expect(document.body.textContent).not.toMatch(/RAW_.*MARKER/);
    expect(JSON.stringify(events)).not.toMatch(/RAW_.*MARKER/);
    expect(JSON.stringify(events)).toContain("INDETERMINATE");
    route.router.dispose();
    window.removeEventListener("chase-sets:registration-method", listener);
  });
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
        actionError={safeFailure("phone-code-consume")}
        notice={{
          status: "phone-code-sent",
          tokenId: "synthetic-registration-token",
          phone: "+13125550100",
          displayName: "Todd",
          expiresAt: "2099-01-01T00:00:00Z",
        }}
      />,
    );
    expect(screen.getByRole("alert").textContent).toContain("Phone code is invalid or has expired.");
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

    expect(await screen.findByText("Passkey registration failed.")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Use magic link" }));

    expect(inputNamed("displayName").value).toBe("Todd");
    expect(inputNamed("email").value).toBe("todd@example.com");
    expect(screen.getByRole("button", { name: "Email me a magic link" })).toBeTruthy();
  });
});
