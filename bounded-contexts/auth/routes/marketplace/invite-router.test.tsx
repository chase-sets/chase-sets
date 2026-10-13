// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryRouter, RouterProvider } from "react-router";
import MarketplaceInviteRoute, { action, loader } from "./invite";
import { AuthApiError } from "../../client";
import { invitationAttemptRollout } from "../../features/invitation-acceptance/api/rollout";

const { api, complete } = vi.hoisted(() => ({
  api: { inspectInvitation: vi.fn(), acceptInvitation: vi.fn(), getInvitationAcceptanceStatus: vi.fn() },
  complete: vi.fn(),
}));
vi.mock("../../support/request-support/api-client", () => ({ createAuthRequestApiClient: () => api }));
vi.mock("../../support/route-support/auth-host.server", () => ({
  marketplaceAuthHost: { completeAuthentication: complete },
}));
vi.mock("../../features/invitation-acceptance/api/rollout", () => ({
  invitationAttemptRollout: { active: true, requireAttempt: true },
}));
const pending = {
  status: "pending",
  invitationId: "ivt_invited",
  email: "synthetic@example.com",
  accountName: "Synthetic invited Account",
  invitedByName: "Synthetic inviter",
  roleLabel: "Viewer",
};

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "");
  Object.assign(invitationAttemptRollout, { active: true });
  vi.resetAllMocks();
});
describe("invitation-acceptance-real-route", () => {
  it("restores a nonsecret retained attempt after deactivation and only reads status", async () => {
    const attemptId = "01c9f50d-cb3e-42ac-a0a8-8b5f887a01ea";
    window.history.replaceState(
      { idx: 2, invitationAcceptanceAttempt: { invitationId: "ivt_invited", attemptId } },
      "",
    );
    Object.assign(invitationAttemptRollout, { active: false });
    api.inspectInvitation.mockResolvedValue({ status: "accepted" });
    api.getInvitationAcceptanceStatus.mockResolvedValue({ type: "accepted-reauth-required", attemptId });
    const router = createMemoryRouter(
      [{ path: "/invite/:invitationId", loader, action, Component: MarketplaceInviteRoute }],
      { initialEntries: ["/invite/ivt_invited?token=synthetic-secret"] },
    );
    render(<RouterProvider router={router} />);
    await screen.findByText("Confirming invitation acceptance");
    fireEvent.click(screen.getByRole("button", { name: "Check status" }));
    await screen.findByText("Invitation accepted. Sign in to continue.");
    expect(api.getInvitationAcceptanceStatus).toHaveBeenCalledWith({
      invitationId: "ivt_invited",
      token: "synthetic-secret",
      attemptId,
    });
    expect(api.acceptInvitation).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    expect(window.history.state.idx).toBe(2);
    expect(JSON.stringify(window.history.state)).not.toMatch(/synthetic-secret|password|challenge/);
  });
  it("renders submitting and confirming through the real action, performs lookup after possible send and never retries the write", async () => {
    api.inspectInvitation.mockResolvedValue(pending);
    let loseResponse!: () => void;
    api.acceptInvitation
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            loseResponse = () => reject(new TypeError("synthetic network loss"));
          }),
      )
      .mockResolvedValue({ type: "accepted-reauth-required" });
    let confirm!: () => void;
    api.getInvitationAcceptanceStatus
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            confirm = () => resolve({ type: "accepted-reauth-required" });
          }),
      )
      .mockResolvedValue({ type: "accepted-reauth-required" });
    const router = createMemoryRouter(
      [{ path: "/invite/:invitationId", loader, action, Component: MarketplaceInviteRoute }],
      { initialEntries: ["/invite/ivt_invited?token=synthetic-secret"] },
    );
    render(<RouterProvider router={router} />);
    await screen.findByText("Accept your invitation");
    fireEvent.click(screen.getByRole("radio", { name: "Password" }));
    const password = screen.getByLabelText("Enter or create a password");
    fireEvent.change(password, { target: { value: "synthetic-password-secret" } });
    fireEvent.submit(password.closest("form")!);
    await screen.findByText("Submitting your invitation acceptance");
    expect(screen.queryByLabelText("Enter or create a password")).toBeNull();
    loseResponse();
    await waitFor(() => expect(api.getInvitationAcceptanceStatus).toHaveBeenCalledOnce());
    confirm();
    await screen.findByText("Invitation accepted. Sign in to continue.");
    expect(complete).not.toHaveBeenCalled();
    expect(api.acceptInvitation).toHaveBeenCalledOnce();
    const attempt = api.acceptInvitation.mock.calls[0][0].attemptId;
    expect(attempt).toMatch(/^[0-9a-f-]{36}$/i);
    expect(api.getInvitationAcceptanceStatus.mock.calls[0][0]).toEqual({
      invitationId: "ivt_invited",
      token: "synthetic-secret",
      attemptId: attempt,
    });
    expect(screen.getByRole("status").getAttribute("aria-live")).toBe("polite");
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("status")));
    expect(document.body.textContent).not.toMatch(/synthetic-secret|synthetic-password-secret/);
    fireEvent.click(screen.getByRole("button", { name: "Check status" }));
    await waitFor(() => expect(api.getInvitationAcceptanceStatus).toHaveBeenCalledTimes(2));
    expect(api.acceptInvitation).toHaveBeenCalledOnce();
    expect(api.inspectInvitation).toHaveBeenCalledTimes(3);
  });
  it.each([
    [409, "This invitation acceptance does not match the original attempt."],
    [400, "Accept your invitation"],
  ] as const)("renders a safe %s known rejection without lookup or cookie completion", async (status, copy) => {
    api.inspectInvitation.mockResolvedValue(pending);
    api.acceptInvitation.mockRejectedValue(
      new AuthApiError(status, { error: { message: "synthetic-secret-must-not-render" } }),
    );
    const router = createMemoryRouter(
      [{ path: "/invite/:invitationId", loader, action, Component: MarketplaceInviteRoute }],
      { initialEntries: ["/invite/ivt_invited"] },
    );
    render(<RouterProvider router={router} />);
    await screen.findByText("Accept your invitation");
    fireEvent.click(screen.getByRole("radio", { name: "Password" }));
    fireEvent.submit(screen.getByLabelText("Enter or create a password").closest("form")!);
    await waitFor(() => expect(api.acceptInvitation).toHaveBeenCalledOnce());
    await screen.findByText(copy);
    expect(api.getInvitationAcceptanceStatus).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain("synthetic-secret-must-not-render");
  });
});
