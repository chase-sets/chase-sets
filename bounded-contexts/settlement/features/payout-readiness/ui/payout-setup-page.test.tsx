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
    provider_reference: null,
    onboarding_status: "not-started",
    transfer_capability_status: "inactive",
    payout_capability_status: "inactive",
    payout_destination_status: "missing",
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

  it("initializes the supported Connect loader only when the embedded component mounts", () => {
    const connectElement = document.createElement("stripe-connect-account-onboarding");
    Object.assign(connectElement, {
      setOnLoaderStart: vi.fn(),
      setOnLoadError: vi.fn(),
      setOnExit: vi.fn(),
    });
    const create = vi.fn(() => connectElement);
    mockLoadConnectAndInitialize.mockReturnValue({ create });
    root = createRoot(container!);

    act(() => {
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
      }),
    );
    expect(create).toHaveBeenCalledWith("account-onboarding");
    expect(container!.querySelector("stripe-connect-account-onboarding")).toBe(connectElement);
    expect(container!.textContent).not.toContain("cs_test_secret");
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
      root!.render(<StripeConnectEmbeddedComponent mode="setup" publishableKey="pk_test_123" />);
    });

    const fetchClientSecret = mockLoadConnectAndInitialize.mock.calls[0][0].fetchClientSecret;

    await act(async () => {
      await expect(fetchClientSecret()).rejects.toThrow("Live Connect setup is not enabled for this Stripe account.");
    });

    expect(container!.textContent).toContain("Setup could not load");
    expect(container!.textContent).toContain("Live Connect setup is not enabled for this Stripe account.");
    expect(container!.textContent).toContain("Retry");
    expect(container!.textContent).toContain("Contact support");
    expect(container!.innerHTML).not.toContain("client_secret");
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
});
