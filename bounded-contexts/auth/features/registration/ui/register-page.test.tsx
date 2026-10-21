// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RegisterPage } from "./register-page";
import { createPasskeyCredential } from "../../../support/ui-support/passkey-browser";
import MarketplaceRegisterRoute, { loader } from "../../../routes/marketplace/register";
import {
  missingPhoneFailure,
  renderAuthRoute,
  safeFailure,
  mockNativeRequestSubmit,
  successfulPasskey,
  pendingPasskey,
} from "../../../tests/auth-form-route-test-support";
import { createBrowserRouter, redirect, RouterProvider } from "react-router";

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
  it("F1 regression: retires social failure after phone success and gives a failed retry only its summary", async () => {
    const route = await renderAuthRoute(
      { path: "/register", Component: MarketplaceRegisterRoute, loader },
      "/register?socialLoginError=provider_failed",
    );
    expect(document.activeElement).toBe(screen.getByRole("alert"));
    fireEvent.click(screen.getByRole("radio", { name: "Phone Code" }));
    expect(screen.queryByRole("alert")).toBeNull();
    const form = screen.getByRole("button", { name: "Text me a code" }).closest("form")!;
    fireEvent.submit(form);
    await waitFor(() => expect(route.requests).toHaveBeenCalledOnce());
    await route.settle({
      status: "phone-code-sent",
      phone: "+13125550100",
      tokenId: "synthetic-token",
      expiresAt: "2099-01-01T00:00:00Z",
    });
    expect(document.activeElement).toBe(screen.getByLabelText("Phone Code"));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(new URLSearchParams(route.router.state.location.search).has("socialLoginError")).toBe(false);

    fireEvent.submit(form);
    await waitFor(() => expect(route.requests).toHaveBeenCalledTimes(2));
    await route.settle(await missingPhoneFailure("phone-code-request"));
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(screen.getByRole("alert").tagName).toBe("SECTION");
    expect(document.activeElement).toBe(screen.getByRole("alert"));
  });

  it("F1 regression: gives a failure submitted from a social URL only its summary", async () => {
    const route = await renderAuthRoute(
      { path: "/register", Component: MarketplaceRegisterRoute, loader },
      "/register?socialLoginError=provider_failed",
    );
    fireEvent.click(screen.getByRole("radio", { name: "Phone Code" }));
    fireEvent.submit(screen.getByRole("button", { name: "Text me a code" }).closest("form")!);
    await waitFor(() => expect(route.requests).toHaveBeenCalledOnce());
    await route.settle(await missingPhoneFailure("phone-code-request"));
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(screen.getByRole("alert").tagName).toBe("SECTION");
    expect(document.activeElement).toBe(screen.getByRole("alert"));
  });

  it("F2 regression: a real browser-history summary-link click retains the committed failure without refocus or reinsertion", async () => {
    const previousUrl = window.location.href;
    const previousState: unknown = window.history.state;
    window.history.replaceState(null, "", "/register");
    let resolveAction: (value: unknown) => void = () => {};
    const requests = vi.fn();
    const router = createBrowserRouter([
      {
        path: "/register",
        Component: MarketplaceRegisterRoute,
        loader,
        action: async ({ request }) => {
          requests(request.method);
          return new Promise((resolve) => {
            resolveAction = resolve;
          });
        },
      },
    ]);
    try {
      await act(async () => {
        render(<RouterProvider router={router} />);
      });
      await waitFor(() => expect(router.state.initialized).toBe(true));
      fireEvent.click(screen.getByRole("radio", { name: "Phone Code" }));
      fireEvent.submit(screen.getByRole("button", { name: "Text me a code" }).closest("form")!);
      await waitFor(() => expect(requests).toHaveBeenCalledOnce());
      const failure = await missingPhoneFailure("phone-code-request");
      await act(async () => {
        resolveAction(failure);
      });
      await waitFor(() => expect(router.state.navigation.state).toBe("idle"));
      const summary = screen.getByRole("alert");
      const link = screen.getByRole("link", { name: /Phone.*Phone is required/ });
      const phone = document.getElementById(link.getAttribute("href")!.slice(1))!;
      const summaryFocus = vi.spyOn(summary, "focus");
      const locationKey = router.state.location.key;
      fireEvent.click(link);
      await waitFor(() => {
        expect(router.state.location.hash).toBe(`#${phone.id}`);
        expect(router.state.location.key).not.toBe(locationKey);
        expect(router.state.actionData).toBeNull();
      });
      expect(document.activeElement).toBe(phone);
      expect(screen.getAllByRole("alert")).toHaveLength(1);
      expect(screen.getByRole("alert")).toBe(summary);
      expect(summary.tagName).toBe("SECTION");
      expect(document.querySelectorAll('[role="alert"], [aria-live="assertive"]')).toHaveLength(1);
      expect(phone.getAttribute("aria-invalid")).toBe("true");
      const description = document.getElementById(phone.getAttribute("aria-describedby")!)!;
      expect(description.textContent).toBe("Phone is required.");
      expect(description.getAttribute("role")).toBeNull();
      expect(description.getAttribute("aria-live")).toBeNull();
      expect(summaryFocus).not.toHaveBeenCalled();
      expect(requests).toHaveBeenCalledExactlyOnceWith("POST");
      await act(async () => {
        await router.navigate("/register?returnTo=%2Faccount");
      });
      expect(screen.queryByRole("alert")).toBeNull();
      expect(phone.getAttribute("aria-invalid")).toBeNull();
      await act(async () => {
        await router.navigate("/register");
      });
      expect(screen.queryByRole("alert")).toBeNull();
    } finally {
      cleanup();
      router.dispose();
      window.history.replaceState(previousState, "", previousUrl);
    }
  });

  it("focus lifecycle: a retired browser ceremony cannot clear a new form's loading or warning owner", async () => {
    const oldCeremony = pendingPasskey();
    const newCeremony = pendingPasskey();
    createPasskeyCredentialMock.mockReturnValueOnce(oldCeremony.promise).mockReturnValueOnce(newCeremony.promise);
    const route = await renderAuthRoute(
      { path: "/register", Component: MarketplaceRegisterRoute, loader },
      "/register",
    );
    fireEvent.submit(screen.getByRole("button", { name: "Create With Passkey" }).closest("form")!);
    fireEvent.click(screen.getByRole("radio", { name: "Password" }));
    fireEvent.click(screen.getByRole("radio", { name: "Passkey" }));
    const button = screen.getByRole("button", { name: "Create With Passkey" });
    fireEvent.submit(button.closest("form")!);
    await act(async () => {
      oldCeremony.reject(new Error("RAW_OLD_PASSKEY_MARKER"));
    });
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(screen.queryByRole("alert")).toBeNull();
    await act(async () => {
      newCeremony.reject(new Error("RAW_NEW_PASSKEY_MARKER"));
    });
    expect(document.activeElement).toBe(screen.getByRole("alert"));
    expect(document.body.textContent).not.toMatch(/RAW_.*MARKER/);
    expect(route.requests).not.toHaveBeenCalled();
  });

  it.each([
    ["Password", "Create account with password", "password"],
    ["Magic Link", "Email me a magic link", "password"],
    ["Passkey", "Create With Passkey", "passkey-register"],
  ] as const)(
    "safe fields / auth parity: %s failures are form-only and successful retries navigate",
    async (method, buttonName, intent) => {
      createPasskeyCredentialMock.mockResolvedValue(successfulPasskey);
      mockNativeRequestSubmit();
      const route = await renderAuthRoute(
        { path: "/register", Component: MarketplaceRegisterRoute, loader },
        "/register",
      );
      fireEvent.click(screen.getByRole("radio", { name: method }));
      const form = screen.getByRole("button", { name: buttonName }).closest("form")!;
      fireEvent.submit(form);
      await waitFor(() => expect(route.requests).toHaveBeenCalledOnce());
      await route.settle(safeFailure(intent));
      expect(screen.getByRole("alert").querySelector("a")).toBeNull();
      expect(document.querySelector('[aria-invalid="true"]')).toBeNull();
      expect(document.body.textContent).not.toContain("RAW_AUTH_MARKER");
      fireEvent.submit(form);
      await waitFor(() => expect(route.requests).toHaveBeenCalledTimes(2));
      await route.settle(redirect("/done"));
      expect(screen.getByText("Authenticated destination")).toBeTruthy();
    },
  );

  it("focus lifecycle: passkey recovery focuses its only polite success owner", async () => {
    createPasskeyCredentialMock.mockResolvedValue(successfulPasskey);
    mockNativeRequestSubmit();
    const route = await renderAuthRoute(
      { path: "/register", Component: MarketplaceRegisterRoute, loader },
      "/register",
    );
    fireEvent.submit(screen.getByRole("button", { name: "Create With Passkey" }).closest("form")!);
    await waitFor(() => expect(route.requests).toHaveBeenCalledOnce());
    await route.settle({ status: "passkey-recovery", message: "The passkey was added. Sign in with it to continue." });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("status"));
  });

  it("focus lifecycle: switching methods during post-action loading discards the old form error", async () => {
    const route = await renderAuthRoute(
      { path: "/register", Component: MarketplaceRegisterRoute, loader },
      "/register",
    );
    fireEvent.click(screen.getByRole("radio", { name: "Phone Code" }));
    fireEvent.submit(screen.getByRole("button", { name: "Text me a code" }).closest("form")!);
    await waitFor(() => expect(route.requests).toHaveBeenCalledOnce());
    await route.settle(await missingPhoneFailure("phone-code-request"), true);
    const password = screen.getByRole("radio", { name: "Password" });
    password.focus();
    fireEvent.click(password);
    await route.finishLoading();
    expect(document.activeElement).toBe(password);
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: "Phone Code" }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(document.querySelector('[aria-invalid="true"]')).toBeNull();
  });

  it("auth parity: social failure owns only its Banner until a new method is selected", async () => {
    await renderAuthRoute(
      { path: "/register", Component: MarketplaceRegisterRoute, loader },
      "/register?socialLoginError=provider_failed",
    );
    const banner = screen.getByRole("alert");
    expect(banner.tagName).not.toBe("SECTION");
    expect(banner.querySelector("a")).toBeNull();
    expect(document.activeElement).toBe(banner);
    fireEvent.click(screen.getByRole("radio", { name: "Phone Code" }));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it.each(["phone-code-request", "phone-code-consume"] as const)(
    "safe fields: %s links only its mounted phone, with ARIA before focus",
    async (intent) => {
      const route = await renderAuthRoute(
        { path: "/register", Component: MarketplaceRegisterRoute, loader },
        "/register",
      );
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
      const inlineError = document.getElementById(descriptionAtFocus!)!;
      expect(inlineError.getAttribute("role")).toBeNull();
      expect(inlineError.getAttribute("aria-live")).toBeNull();
      const summary = screen.getByRole("alert");
      expect(summary.tagName).toBe("SECTION");
      expect(document.querySelectorAll('[role="alert"], [aria-live="assertive"]')).toHaveLength(1);
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
    },
  );

  it("focus lifecycle: clears on accepted start, focuses identical results separately, then phone success and navigation", async () => {
    const route = await renderAuthRoute(
      { path: "/register", Component: MarketplaceRegisterRoute, loader },
      "/register",
    );
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
    await route.settle({
      status: "phone-code-sent",
      phone: "+13125550100",
      tokenId: "synthetic-token",
      expiresAt: "2099-01-01T00:00:00Z",
    });
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
    const route = await renderAuthRoute(
      { path: "/register", Component: MarketplaceRegisterRoute, loader },
      "/register",
    );
    fireEvent.submit(screen.getByRole("button", { name: "Create With Passkey" }).closest("form")!);
    expect((await screen.findByRole("alert")).textContent).toContain("Passkey registration failed.");
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("alert")));
    fireEvent.click(screen.getByRole("radio", { name: "Password" }));
    fireEvent.submit(screen.getByRole("button", { name: "Create account with password" }).closest("form")!);
    await waitFor(() => expect(route.requests).toHaveBeenCalledOnce());
    await route.settle(
      safeFailure("password", 400, {
        error: {
          code: "validation_failed",
          message: "RAW_AUTH_MARKER",
          details: [{ field: "email", code: "phone_required", message: "RAW_AUTH_MARKER" }],
        },
      }),
    );
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
  it("each auth form busies only itself", async () => {
    const route = await renderAuthRoute(
      { path: "/register", Component: MarketplaceRegisterRoute, loader },
      "/register",
    );
    fireEvent.click(screen.getByRole("radio", { name: "Phone Code" }));
    fireEvent.change(inputNamed("displayName"), { target: { value: "Todd" } });
    fireEvent.change(inputNamed("phone"), { target: { value: "+13125550100" } });
    const send = screen.getByRole("button", { name: "Text me a code" });
    const requestForm = send.closest("form")!;
    const consumeForm = screen.getByLabelText("Phone Code").closest("form")!;
    fireEvent.click(send);
    await waitFor(() => expect(route.requests).toHaveBeenCalledOnce());
    expect(requestForm.getAttribute("aria-busy")).toBe("true");
    expect(consumeForm.getAttribute("aria-busy")).toBeNull();
    await route.settle(safeFailure("phone-code-request"));
    expect(requestForm.getAttribute("aria-busy")).toBeNull();
  });

  it("passkey re-entry submits complete form data", async () => {
    createPasskeyCredentialMock.mockResolvedValue(successfulPasskey);
    mockNativeRequestSubmit();
    const route = await renderAuthRoute(
      { path: "/register", Component: MarketplaceRegisterRoute, loader },
      "/register",
    );
    const form = screen.getByRole("button", { name: "Create With Passkey" }).closest("form")!;
    fireEvent.submit(form);
    await waitFor(() => expect(route.requests).toHaveBeenCalledOnce());
    expect(route.submittedFields[0]).toMatchObject({
      intent: "passkey-register",
      registrationMethod: "passkey",
      registrationMethodsShown: "passkey,phone-code,magic-link,password",
      challengeId: successfulPasskey.challengeId,
    });
    await route.settle(safeFailure("passkey-register"));
  });

  it("re-enables after back-to-back failures and after an aborted submission", async () => {
    const route = await renderAuthRoute(
      { path: "/register", Component: MarketplaceRegisterRoute, loader },
      "/register",
    );
    fireEvent.click(screen.getByRole("radio", { name: "Password" }));
    const form = screen.getByRole("button", { name: "Create account with password" }).closest("form")!;
    for (const attempt of [1, 2]) {
      fireEvent.submit(form);
      await waitFor(() => expect(route.requests).toHaveBeenCalledTimes(attempt));
      await route.settle(safeFailure("password"));
      expect(form.getAttribute("aria-busy")).toBeNull();
    }
    await act(async () => {
      await route.router.navigate("/done");
      await route.router.navigate("/register");
    });
    expect(document.querySelector('[aria-busy="true"]')).toBeNull();
  });

  it("emits completed and no abandoned event after a completed registration", async () => {
    const events: CustomEvent["detail"][] = [];
    const listener = (event: Event) => events.push((event as CustomEvent).detail);
    window.addEventListener("chase-sets:registration-method", listener);
    const route = await renderAuthRoute(
      { path: "/register", Component: MarketplaceRegisterRoute, loader },
      "/register",
    );
    fireEvent.click(screen.getByRole("radio", { name: "Password" }));
    const form = screen.getByRole("button", { name: "Create account with password" }).closest("form")!;
    fireEvent.submit(form);
    await waitFor(() => expect(route.requests).toHaveBeenCalledOnce());
    window.dispatchEvent(new Event("beforeunload"));
    expect(events).toEqual(
      expect.arrayContaining([expect.objectContaining({ method: "password", stage: "completed" })]),
    );
    expect(events.some((event) => event?.stage === "abandoned")).toBe(false);
    await route.settle(redirect("/done"));
    window.removeEventListener("chase-sets:registration-method", listener);
  });

  it("emits abandoned on beforeunload when registration was never completed", () => {
    const events: CustomEvent["detail"][] = [];
    const listener = (event: Event) => events.push((event as CustomEvent).detail);
    window.addEventListener("chase-sets:registration-method", listener);
    render(<RegisterPage />);
    window.dispatchEvent(new Event("beforeunload"));
    expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ stage: "abandoned" })]));
    window.removeEventListener("chase-sets:registration-method", listener);
  });

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
