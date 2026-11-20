// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChaseRoot } from "@chase-sets/design-system";
const { mockUseActionData, mockUseLoaderData } = vi.hoisted(() => ({
  mockUseActionData: vi.fn(),
  mockUseLoaderData: vi.fn(),
}));
vi.mock("react-router", async () => {
  const actual = await vi.importActual<typeof import("react-router")>("react-router");
  const React = await vi.importActual<typeof import("react")>("react");
  return {
    ...actual,
    Form: ({ children, ...props }: { children: ReactNode }) => React.createElement("form", props, children),
    useActionData: mockUseActionData,
    useLoaderData: mockUseLoaderData,
    useNavigation: () => ({ state: "idle" }),
    useFormAction: () => "/",
  };
});
import GuestPaymentClaimRoute from "../routes/marketplace/guest-payment-claim";
const buildPayment = (overrides: object = {}) => ({ payment_id: "pay_1", ...overrides });
const buildPurchase = (overrides: object = {}) => ({ order_id: "ord_1", ...overrides });
type SurfaceTreatment = "flush" | "tinted" | "outlined" | "elevated";

// Reads the rendered treatment back from the classes the design-system
// Surface owns: furniture has no chrome, `tinted` keeps a soft fill,
// `outlined` a hairline, and `elevated` the raised border and shadow.
function expectSurfaceTreatment(anchor: HTMLElement, treatment: SurfaceTreatment, glow = false) {
  const root = anchor.closest<HTMLElement>(".min-w-0.max-w-full.rounded-tokenLg");
  expect(root).toBeTruthy();
  const classes = root!.className.split(/\s+/);
  const raised = classes.includes("surface-border") || classes.some((name) => name.startsWith("shadow-"));
  if (treatment === "elevated") expect(classes).toEqual(expect.arrayContaining(["surface-border", "shadow-tokenLg"]));
  else expect(raised).toBe(false);
  if (treatment === "outlined") expect(classes).toContain("border");
  if (treatment === "flush" || treatment === "tinted") expect(classes).not.toContain("border");
  if (treatment === "flush") expect(classes.some((name) => name.startsWith("bg-"))).toBe(false);
  if (treatment === "tinted") expect(classes).toContain("bg-surface-2");
  expect(classes.includes("ds-glow")).toBe(glow);
}

afterEach(cleanup);
beforeEach(() => {
  mockUseActionData.mockReturnValue(undefined);
});
describe("guest payment claim UI", () => {
  it("retains the relocated Surface root with explicit elevation and no legacy elevated boolean", () => {
    const source = readFileSync(resolve("features/registration/ui/guest-payment-claim-prompt.tsx"), "utf8");
    const roots = [...source.matchAll(/<Surface\b[^>]*>/g)].map((match) => match[0]);
    expect(roots).toHaveLength(1);
    expect(roots[0]).toMatch(/\selevation="elevated"/);
    expect(roots[0]).not.toMatch(/\selevated(?:\s|=|\/?>)/);
  });
  it("raises the guest order claim host with its glow", () => {
    mockUseLoaderData.mockReturnValue({
      payment: buildPayment({
        status: "captured",
        processor_status: "succeeded",
        captured_at: "2026-04-01T00:05:00.000Z",
      }),
      orders: [buildPurchase({ status: "paid" })],
      isGuestCheckoutPayment: true,
      claimable: true,
      guestClaimContact: {
        contactEmail: "jane@example.com",
        contactName: "Jane Smith",
      },
      showSupportDetails: false,
      paymentElementDefaultValues: null,
    });

    render(
      <ChaseRoot>
        <GuestPaymentClaimRoute />
      </ChaseRoot>,
    );

    expectSurfaceTreatment(
      screen.getByText(
        "Save this order after payment with a passkey. You can use an email link if this device cannot create one.",
      ),
      "elevated",
      true,
    );
  });

  it("does not render manual guest claim token entry when no gated local token is present", () => {
    mockUseActionData.mockReturnValue({
      status: "claim-link-sent",
      token: null,
      expiresAt: "2026-05-04T16:00:00.000Z",
      displayName: "Jane Smith",
    });
    mockUseLoaderData.mockReturnValue({
      payment: buildPayment({
        status: "captured",
        processor_status: "succeeded",
        captured_at: "2026-04-01T00:05:00.000Z",
      }),
      orders: [buildPurchase({ status: "paid" })],
      isGuestCheckoutPayment: true,
      claimable: true,
      guestClaimContact: {
        contactEmail: "jane@example.com",
        contactName: "Jane Smith",
      },
      showSupportDetails: false,
      paymentElementDefaultValues: null,
    });

    render(
      <ChaseRoot>
        <GuestPaymentClaimRoute />
      </ChaseRoot>,
    );

    expect(screen.getByText("Save this order")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Email me a claim link" })).toBeTruthy();
    expect(screen.queryByLabelText("Claim token")).toBeNull();
    expect(screen.queryByText("Local recovery token. In production this arrives by email.")).toBeNull();
  });

  it("renders manual guest claim token entry only when action data carries a gated local token", () => {
    mockUseActionData.mockReturnValue({
      status: "claim-link-sent",
      token: "magic_token",
      expiresAt: "2026-05-04T16:00:00.000Z",
      displayName: "Jane Smith",
    });
    mockUseLoaderData.mockReturnValue({
      payment: buildPayment({
        status: "captured",
        processor_status: "succeeded",
        captured_at: "2026-04-01T00:05:00.000Z",
      }),
      orders: [buildPurchase({ status: "paid" })],
      isGuestCheckoutPayment: true,
      claimable: true,
      guestClaimContact: {
        contactEmail: "jane@example.com",
        contactName: "Jane Smith",
      },
      showSupportDetails: false,
      paymentElementDefaultValues: null,
    });

    render(
      <ChaseRoot>
        <GuestPaymentClaimRoute />
      </ChaseRoot>,
    );

    expect(screen.getByLabelText("Claim token")).toHaveProperty("value", "magic_token");
    expect(screen.getByText("Local recovery token. In production this arrives by email.")).toBeTruthy();
  });

  it("says a claim link was sent to the bound email", () => {
    mockUseActionData.mockReturnValue({
      status: "claim-link-sent",
      token: null,
      expiresAt: "2026-05-04T16:00:00.000Z",
      displayName: "Jane Smith",
    });
    mockUseLoaderData.mockReturnValue({
      paymentId: "pay_1",
      claimable: true,
      guestClaimContact: { contactEmail: "jane@example.com", contactName: "Jane Smith" },
    });

    render(
      <ChaseRoot>
        <GuestPaymentClaimRoute />
      </ChaseRoot>,
    );

    expect(screen.getByText("Claim link sent")).toBeTruthy();
    expect(
      screen.getByText("We sent a claim link to jane@example.com. Open it to save this order to an account."),
    ).toBeTruthy();
  });

  it("offers no claim for a paid order whose contact cannot be claimed, and says so", () => {
    mockUseLoaderData.mockReturnValue({ paymentId: "pay_1", claimable: true, guestClaimContact: null });

    render(
      <ChaseRoot>
        <GuestPaymentClaimRoute />
      </ChaseRoot>,
    );

    expect(
      screen.getByText("This order cannot be saved to an account right now. It stays on its payment page."),
    ).toBeTruthy();
    expect(screen.getByText("Account options for this order")).toBeTruthy();
    expect(screen.queryByText("Save this order")).toBeNull();
    expect(screen.queryByRole("button", { name: "Email me a claim link" })).toBeNull();
    expect(screen.queryByLabelText("Contact name")).toBeNull();
  });
});
