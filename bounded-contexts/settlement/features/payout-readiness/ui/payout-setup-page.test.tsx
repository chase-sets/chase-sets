// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SettlementPayoutReadinessRow } from "../read-model/queries";

const { mockLoadConnectAndInitialize } = vi.hoisted(() => ({
  mockLoadConnectAndInitialize: vi.fn(),
}));

vi.mock("@stripe/connect-js/pure", () => ({
  loadConnectAndInitialize: mockLoadConnectAndInitialize,
}));

import {
  fetchEmbeddedClientSecret,
  loadStripeConnectComponent,
  PayoutSetupPage,
  StripeConnectEmbeddedComponent,
} from "./payout-setup-page";

function readiness(overrides: Partial<SettlementPayoutReadinessRow> = {}): SettlementPayoutReadinessRow {
  return {
    account_id: "acc_test" as never,
    status: "not-started",
    missing_requirements: [],
    advisory_requirements: [],
    disabled_reason: null,
    requirements_deadline: null,
    provider_reference: null,
    contact_email: null,
    onboarding_status: "not-started",
    transfer_capability_status: "inactive",
    payout_capability_status: "inactive",
    payout_destination_status: "missing",
    payout_destination_fingerprint: null,
    payout_destination_changed_at: null,
    payout_account_dashboard: "unknown",
    losses_collector: "unknown",
    fees_collector: "unknown",
    requirements_collector: "unknown",
    updated_at: null,
    ...overrides,
  };
}

function renderPage(row: SettlementPayoutReadinessRow, options: { providerErrorMessage?: string | null } = {}) {
  return renderToStaticMarkup(
    <PayoutSetupPage
      payoutReadiness={row}
      mode="setup"
      stripePublishableKey="pk_test_123"
      providerErrorMessage={options.providerErrorMessage ?? null}
    />,
  );
}

function setThemeScope(element: HTMLElement, colorMode: "light" | "dark", tokens: Readonly<Record<string, string>>) {
  element.setAttribute("data-chase-theme-scope", "");
  element.setAttribute("data-color-mode", colorMode);
  for (const [name, value] of Object.entries(tokens)) {
    element.style.setProperty(name, value);
  }
}

const setupLightTokens = {
  "--card": "#fffaf2",
  "--surface-2": "#f4efe3",
  "--foreground": "#17130f",
  "--text-secondary": "#4f4638",
  "--border": "#d8cab4",
  "--primary": "#0b5cad",
  "--primary-foreground": "#ffffff",
  "--body-font": "Inter, sans-serif",
  "--control-md-px": "1.25rem",
  "--control-md-py": "0.75rem",
} as const;

const managementDarkTokens = {
  "--card": "#101820",
  "--surface-2": "#172331",
  "--foreground": "#f8fafc",
  "--text-secondary": "#cbd5e1",
  "--border": "#334155",
  "--primary": "#8fc7ff",
  "--primary-foreground": "#08111f",
  "--body-font": "IBM Plex Sans, sans-serif",
  "--control-md-px": "1rem",
  "--control-md-py": "0.625rem",
} as const;

async function flushMutationObserver() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("payout setup page", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    container?.remove();
    root = null;
    container = null;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    mockLoadConnectAndInitialize.mockReset();
  });

  it("renders a Chase Sets setup page for accounts that have not started", () => {
    const html = renderPage(readiness());

    expect(html).toContain("Payout setup");
    expect(html).toContain("Add the required account and payout destination details without leaving Chase Sets.");
    expect(html).toContain("Loading secure payout setup");
    expect(html).toContain("ds-glass rounded-tokenLg border border-muted shadow-tokenSm overflow-visible p-4");
    expect(html).not.toContain("Express");
    expect(html).not.toContain("hosted setup");
  });

  it("renders pending setup without sending users to a provider dashboard", () => {
    const html = renderPage(
      readiness({
        status: "pending",
        provider_reference: "acct_test",
        onboarding_status: "pending",
        transfer_capability_status: "pending",
        payout_capability_status: "pending",
        payout_destination_status: "pending",
        updated_at: "2026-06-01T15:00:00.000Z",
      }),
    );

    expect(html).toContain("Continue the Chase Sets setup page before requesting payouts.");
    expect(html).toContain("Payout setup");
    expect(html).not.toContain("Stripe Express");
  });

  it("groups restricted provider requirements before exposing raw support details", () => {
    const html = renderPage(
      readiness({
        status: "restricted",
        provider_reference: "acct_test",
        onboarding_status: "pending",
        missing_requirements: ["individual.verification.document", "external_account"],
        updated_at: "2026-06-01T15:00:00.000Z",
      }),
    );

    expect(html).toContain("Identity and business details");
    expect(html).toContain("Payout account");
    expect(html).toContain("Support details");
    expect(html).toContain("Contact support");
    expect(html).not.toContain("individual.verification.document");
    expect(html).not.toContain("external_account");
  });

  it("does not mount seller verification for platform posture review", () => {
    const html = renderPage(
      readiness({
        status: "pending",
        provider_reference: "acct_test",
        onboarding_status: "pending",
        missing_requirements: ["provider_dashboard_posture"],
        updated_at: "2026-06-01T15:00:00.000Z",
      }),
    );

    expect(html).toContain("Platform review — contact support");
    expect(html).toContain("Contact support");
    expect(html).not.toContain("Loading secure payout setup");
    expect(html).not.toContain("provider_dashboard_posture");
  });

  it("renders the ready state without mounting setup by default", () => {
    const html = renderPage(
      readiness({
        status: "ready",
        provider_reference: "acct_test",
        onboarding_status: "complete",
        transfer_capability_status: "active",
        payout_capability_status: "active",
        payout_destination_status: "ready",
        updated_at: "2026-06-01T15:00:00.000Z",
      }),
    );

    expect(html).toContain("Payouts are ready");
    expect(html).toContain("Request payout");
    expect(html).not.toContain("Loading secure payout setup");
  });

  it("renders provider errors with a retry path", () => {
    const html = renderPage(readiness({ status: "pending", provider_reference: "acct_test" }), {
      providerErrorMessage: "Provider session expired.",
    });

    expect(html).toContain("Setup could not load");
    expect(html).toContain("Provider session expired.");
    expect(html).toContain("Retry");
    expect(html).toContain("Contact support");
    expect(html).toContain("The setup session may have expired");
  });

  it("does not initialize the Connect runtime when setup is already ready", () => {
    root = createRoot(container!);

    act(() => {
      root!.render(
        <PayoutSetupPage
          payoutReadiness={readiness({
            status: "ready",
            provider_reference: "acct_test",
            onboarding_status: "complete",
            transfer_capability_status: "active",
            payout_capability_status: "active",
            payout_destination_status: "ready",
          })}
          mode="setup"
          stripePublishableKey="pk_test_123"
        />,
      );
    });

    expect(mockLoadConnectAndInitialize).not.toHaveBeenCalled();
    expect(container!.querySelector("[data-testid='stripe-connect-embedded-component']")).toBeNull();
  });

  it("initializes the supported Connect loader only after creating an embedded session", async () => {
    setThemeScope(container!, "light", setupLightTokens);
    const fetch = vi.fn(async () =>
      Response.json({
        clientSecret: "acs_test_secret",
      }),
    );
    vi.stubGlobal("fetch", fetch);
    const connectElement = document.createElement("stripe-connect-account-onboarding");
    Object.assign(connectElement, {
      setOnLoaderStart: vi.fn(),
      setOnLoadError: vi.fn(),
      setOnExit: vi.fn(),
    });
    const create = vi.fn(() => connectElement);
    mockLoadConnectAndInitialize.mockReturnValue({ create });
    root = createRoot(container!);

    await act(async () => {
      root!.render(
        <StripeConnectEmbeddedComponent mode="setup" publishableKey="pk_test_123" onProviderExit={vi.fn()} />,
      );
    });

    expect(mockLoadConnectAndInitialize).toHaveBeenCalledTimes(1);
    expect(mockLoadConnectAndInitialize).toHaveBeenCalledWith(
      expect.objectContaining({
        publishableKey: "pk_test_123",
        locale: "en-US",
        fetchClientSecret: expect.any(Function),
        appearance: expect.objectContaining({
          overlays: "dialog",
          variables: expect.objectContaining({
            buttonPaddingX: "20px",
            buttonPaddingY: "12px",
            buttonPrimaryColorBackground: setupLightTokens["--primary"],
            buttonPrimaryColorText: setupLightTokens["--primary-foreground"],
            colorBackground: setupLightTokens["--card"],
            colorBorder: setupLightTokens["--border"],
            colorSecondaryText: setupLightTokens["--text-secondary"],
            colorText: setupLightTokens["--foreground"],
            fontFamily: setupLightTokens["--body-font"],
            formBackgroundColor: setupLightTokens["--surface-2"],
          }),
        }),
      }),
    );
    expect(create).toHaveBeenCalledWith("account-onboarding");
    const providerSurface = container!.querySelector(
      "[data-testid='stripe-connect-embedded-component']",
    ) as HTMLElement;
    expect(providerSurface.className).toContain("min-h-[36rem]");
    expect(providerSurface.className).toContain("[&_iframe]:min-h-[36rem]");
    expect(providerSurface.className).toContain("[&>stripe-connect-account-onboarding]:block");
    expect(container!.querySelector("stripe-connect-account-onboarding")).toBe(connectElement);
    const fetchClientSecret = mockLoadConnectAndInitialize.mock.calls[0][0].fetchClientSecret;

    await expect(fetchClientSecret()).resolves.toBe("acs_test_secret");
    await expect(fetchClientSecret()).resolves.toBe("acs_test_secret");

    expect(fetch).toHaveBeenCalledWith(
      "/api/settlement/payout-setup/embedded-session",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        body: "{}",
      }),
    );
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(container!.textContent).not.toContain("cs_test_secret");
    expect(container!.textContent).not.toContain("acs_test_secret");
  });

  it("initializes the management component with scoped dark Connect appearance", async () => {
    setThemeScope(container!, "dark", managementDarkTokens);
    const fetch = vi.fn(async () =>
      Response.json({
        clientSecret: "acs_manage_secret",
      }),
    );
    vi.stubGlobal("fetch", fetch);
    const connectElement = document.createElement("stripe-connect-account-management");
    const create = vi.fn(() => connectElement);
    mockLoadConnectAndInitialize.mockReturnValue({ create });
    root = createRoot(container!);

    await act(async () => {
      root!.render(<StripeConnectEmbeddedComponent mode="management" publishableKey="pk_test_123" />);
    });

    expect(mockLoadConnectAndInitialize).toHaveBeenCalledWith(
      expect.objectContaining({
        appearance: expect.objectContaining({
          overlays: "dialog",
          variables: expect.objectContaining({
            buttonPrimaryColorBackground: managementDarkTokens["--primary"],
            buttonPrimaryColorText: managementDarkTokens["--primary-foreground"],
            colorBackground: managementDarkTokens["--card"],
            colorBorder: managementDarkTokens["--border"],
            colorSecondaryText: managementDarkTokens["--text-secondary"],
            colorText: managementDarkTokens["--foreground"],
            fontFamily: managementDarkTokens["--body-font"],
            formBackgroundColor: managementDarkTokens["--surface-2"],
          }),
        }),
      }),
    );
    expect(create).toHaveBeenCalledWith("account-management");
    expect(fetch).toHaveBeenCalledWith(
      "/api/settlement/payout-setup/account-management-embedded-session",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        body: "{}",
      }),
    );
    expect(container!.querySelector("stripe-connect-account-management")).toBe(connectElement);
  });

  it("remounts Connect with updated scoped appearance when the theme changes", async () => {
    setThemeScope(container!, "light", setupLightTokens);
    const fetch = vi.fn(async () =>
      Response.json({
        clientSecret: "acs_test_secret",
      }),
    );
    vi.stubGlobal("fetch", fetch);
    const firstConnectElement = document.createElement("stripe-connect-account-onboarding");
    const secondConnectElement = document.createElement("stripe-connect-account-onboarding");
    const create = vi.fn().mockReturnValueOnce(firstConnectElement).mockReturnValueOnce(secondConnectElement);
    mockLoadConnectAndInitialize.mockReturnValue({ create });
    root = createRoot(container!);

    await act(async () => {
      root!.render(<StripeConnectEmbeddedComponent mode="setup" publishableKey="pk_test_123" />);
    });

    expect(container!.querySelector("stripe-connect-account-onboarding")).toBe(firstConnectElement);

    await act(async () => {
      container!.setAttribute("data-color-mode", "dark");
      container!.style.setProperty("--card", managementDarkTokens["--card"]);
      container!.style.setProperty("--foreground", managementDarkTokens["--foreground"]);
      container!.style.setProperty("--primary", managementDarkTokens["--primary"]);
    });
    await flushMutationObserver();

    expect(mockLoadConnectAndInitialize).toHaveBeenCalledTimes(2);
    expect(mockLoadConnectAndInitialize.mock.calls[1][0].appearance.variables).toEqual(
      expect.objectContaining({
        buttonPrimaryColorBackground: managementDarkTokens["--primary"],
        colorBackground: managementDarkTokens["--card"],
        colorText: managementDarkTokens["--foreground"],
      }),
    );
    expect(container!.querySelectorAll("stripe-connect-account-onboarding")).toHaveLength(1);
    expect(container!.querySelector("stripe-connect-account-onboarding")).toBe(secondConnectElement);
  });

  it("requests a fresh embedded session whenever Connect asks for a client secret", async () => {
    const fetch = vi.fn(async () =>
      Response.json({
        clientSecret: "acs_test_secret",
      }),
    );
    vi.stubGlobal("fetch", fetch);

    loadStripeConnectComponent({ mode: "management", publishableKey: "pk_test_123" });
    const fetchClientSecret = mockLoadConnectAndInitialize.mock.calls[0][0].fetchClientSecret;

    await expect(fetchClientSecret()).resolves.toBe("acs_test_secret");
    await expect(fetchClientSecret()).resolves.toBe("acs_test_secret");

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenNthCalledWith(
      1,
      "/api/settlement/payout-setup/account-management-embedded-session",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        body: "{}",
      }),
    );
    expect(console.log).not.toHaveBeenCalled();
    expect(console.info).not.toHaveBeenCalled();
    expect(console.warn).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
  });

  it("surfaces embedded setup session creation failures from the API", async () => {
    const fetch = vi.fn(async () =>
      Response.json(
        {
          error: {
            message: "Live Connect setup is not enabled for this Stripe account.",
          },
        },
        { status: 400 },
      ),
    );
    vi.stubGlobal("fetch", fetch);
    root = createRoot(container!);

    await act(async () => {
      root!.render(<StripeConnectEmbeddedComponent mode="setup" publishableKey="pk_test_123" />);
    });

    expect(container!.textContent).toContain("Setup could not load");
    expect(container!.textContent).toContain("Live Connect setup is not enabled for this Stripe account.");
    expect(container!.textContent).toContain("Retry");
    expect(container!.textContent).toContain("Contact support");
    expect(mockLoadConnectAndInitialize).not.toHaveBeenCalled();
    expect(container!.querySelector("stripe-connect-account-onboarding")).toBeNull();
    expect(container!.innerHTML).not.toContain("client_secret");
  });

  it("offers re-authentication with a safe same-origin return target when the API refuses on step-up", async () => {
    const fetch = vi.fn(async () =>
      Response.json(
        {
          error: {
            code: "step_up_required",
            message: "Confirm it is you before managing payout account details.",
          },
        },
        { status: 400 },
      ),
    );
    vi.stubGlobal("fetch", fetch);
    root = createRoot(container!);

    await act(async () => {
      root!.render(<StripeConnectEmbeddedComponent mode="management" publishableKey="pk_test_123" />);
    });

    expect(container!.textContent).toContain("Confirm it is you");
    expect(container!.textContent).toContain("Sign in again");
    expect(container!.textContent).not.toContain("Contact support");

    const reauthenticate = container!.querySelector<HTMLAnchorElement>('a[href^="/sign-in"]');
    expect(reauthenticate).not.toBeNull();
    // Same-origin by construction: the return target is this page's own route
    // literal, never a value read from the location or query string.
    expect(reauthenticate!.getAttribute("href")).toBe(
      `/sign-in?returnTo=${encodeURIComponent("/account/desk/settings?mode=manage")}`,
    );
    expect(mockLoadConnectAndInitialize).not.toHaveBeenCalled();
  });

  it("retries session creation after fresh authentication and mounts the embedded component", async () => {
    let refuse = true;
    const fetch = vi.fn(async () =>
      refuse
        ? Response.json(
            { error: { code: "step_up_required", message: "Confirm it is you." } },
            { status: 400 },
          )
        : Response.json({ clientSecret: "acs_manage_secret" }),
    );
    vi.stubGlobal("fetch", fetch);
    const connectElement = document.createElement("stripe-connect-account-management");
    mockLoadConnectAndInitialize.mockReturnValue({ create: vi.fn(() => connectElement) });
    root = createRoot(container!);

    await act(async () => {
      root!.render(<StripeConnectEmbeddedComponent mode="management" publishableKey="pk_test_123" />);
    });
    expect(container!.textContent).toContain("Sign in again");

    // The session is now fresh (the seller re-authenticated); the surface's own
    // retry must re-run session creation rather than requiring a full reload.
    refuse = false;
    const retry = [...container!.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Retry"),
    );
    expect(retry).toBeDefined();
    await act(async () => {
      retry!.click();
    });

    expect(container!.textContent).not.toContain("Sign in again");
    expect(container!.querySelector("stripe-connect-account-management")).toBe(connectElement);
  });

  it("does not offer re-authentication for a provider-authority failure", async () => {
    const fetch = vi.fn(async () =>
      Response.json(
        {
          error: {
            code: "validation_failed",
            message: "Payout setup must be started before managing payout account details.",
          },
        },
        { status: 400 },
      ),
    );
    vi.stubGlobal("fetch", fetch);
    root = createRoot(container!);

    await act(async () => {
      root!.render(<StripeConnectEmbeddedComponent mode="management" publishableKey="pk_test_123" />);
    });

    expect(container!.textContent).toContain("Setup could not load");
    expect(container!.textContent).toContain("Payout setup must be started before managing payout account details.");
    expect(container!.textContent).not.toContain("Sign in again");
    expect(container!.querySelector('a[href^="/sign-in"]')).toBeNull();
  });

  it("keeps embedded client secrets transient when fetching setup sessions", async () => {
    const fetch = vi.fn(async () =>
      Response.json({
        clientSecret: "acs_setup_secret",
      }),
    );
    vi.stubGlobal("fetch", fetch);

    await expect(fetchEmbeddedClientSecret("setup")).resolves.toBe("acs_setup_secret");

    expect(fetch).toHaveBeenCalledWith(
      "/api/settlement/payout-setup/embedded-session",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        body: "{}",
      }),
    );
    expect(container!.innerHTML).not.toContain("acs_setup_secret");
    expect(console.log).not.toHaveBeenCalled();
    expect(console.info).not.toHaveBeenCalled();
    expect(console.warn).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
  });

  it("sends the signed-in contact email when creating setup sessions", async () => {
    const fetch = vi.fn(async () =>
      Response.json({
        clientSecret: "acs_setup_secret",
      }),
    );
    vi.stubGlobal("fetch", fetch);

    await expect(fetchEmbeddedClientSecret("setup", " seller@example.test ")).resolves.toBe("acs_setup_secret");

    expect(fetch).toHaveBeenCalledWith(
      "/api/settlement/payout-setup/embedded-session",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        body: JSON.stringify({ contactEmail: "seller@example.test" }),
      }),
    );
  });

  it("keeps management sessions independent from contact email", async () => {
    const fetch = vi.fn(async () =>
      Response.json({
        clientSecret: "acs_manage_secret",
      }),
    );
    vi.stubGlobal("fetch", fetch);

    await expect(fetchEmbeddedClientSecret("management", " seller@example.test ")).resolves.toBe("acs_manage_secret");

    expect(fetch).toHaveBeenCalledWith(
      "/api/settlement/payout-setup/account-management-embedded-session",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        body: "{}",
      }),
    );
  });
});
