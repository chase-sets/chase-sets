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

describe("registration page", () => {
  it("defaults to passkeys and presents them as recommended", () => {
    const events: unknown[] = [];
    window.addEventListener("chase-sets:registration-method", (event) => {
      events.push((event as CustomEvent).detail);
    });

    render(<RegisterPage />);

    expect(screen.getByRole("tab", { name: /Passkey/ }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText("Recommended")).toBeTruthy();
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
  });

  it("keeps entered identity details when moving to magic link", () => {
    render(<RegisterPage />);
    fillIdentity();

    fireEvent.click(screen.getByRole("tab", { name: /Magic Link/ }));

    expect(screen.getByRole("tab", { name: /Magic Link/ }).getAttribute("aria-selected")).toBe("true");
    expect(inputNamed("displayName").value).toBe("Todd");
    expect(inputNamed("email").value).toBe("todd@example.com");
    expect(screen.getByRole("button", { name: "Email me a magic link" })).toBeTruthy();
    expect(document.querySelector('input[name="intent"][value="magic-link-register"]')).not.toBeNull();
  });

  it("offers phone code registration without requiring email", () => {
    render(<RegisterPage />);

    fireEvent.click(screen.getByRole("tab", { name: /Phone Code/ }));

    expect(screen.getByRole("tab", { name: /Phone Code/ }).getAttribute("aria-selected")).toBe("true");
    expect(inputNamed("phone")).toBeTruthy();
    expect(screen.queryByLabelText("Email")).toBeNull();
    expect(screen.getByRole("button", { name: "Text me a code" })).toBeTruthy();
    expect(document.querySelector('input[name="intent"][value="phone-code-request"]')).not.toBeNull();
  });

  it("keeps password registration available as the fallback", () => {
    render(<RegisterPage />);

    fireEvent.click(screen.getByRole("tab", { name: /Password/ }));

    expect(screen.getByText("Use this fallback when passkeys and magic links are not available.")).toBeTruthy();
    expect(inputNamed("password")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Create account with password" })).toBeTruthy();
    expect(document.querySelector('input[name="intent"][value="password"]')).not.toBeNull();
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
