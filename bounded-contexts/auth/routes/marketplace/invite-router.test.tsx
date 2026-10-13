// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryRouter, redirect, RouterProvider } from "react-router";
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
    expect(document.body.innerHTML).not.toMatch(/synthetic-secret|synthetic-password-secret/);
    fireEvent.click(screen.getByRole("button", { name: "Check status" }));
    await waitFor(() => expect(api.getInvitationAcceptanceStatus).toHaveBeenCalledTimes(2));
    expect(api.acceptInvitation).toHaveBeenCalledOnce();
    expect(api.inspectInvitation).toHaveBeenCalledTimes(3);
  });
  it.each([
    [409, "invitation_attempt_conflict", "This invitation acceptance does not match the original attempt."],
    [409, "invitation_attempts_not_active", "Accept your invitation"],
    [400, "invitation_attempt_invalid", "Accept your invitation"],
    [403, "forbidden", "This invitation is unavailable."],
  ] as const)(
    "renders a safe %s/%s known rejection without lookup or cookie completion",
    async (status, code, copy) => {
      api.inspectInvitation.mockResolvedValue(pending);
      api.acceptInvitation.mockRejectedValue(
        new AuthApiError(status, { error: { code, message: "synthetic-secret-must-not-render" } }),
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
      await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("status")));
      expect(api.getInvitationAcceptanceStatus).not.toHaveBeenCalled();
      expect(complete).not.toHaveBeenCalled();
      expect(document.body.textContent).not.toContain("synthetic-secret-must-not-render");
    },
  );
  it.each([409, 503])("F3 server ambiguous %s performs one owner lookup and never renders conflict", async (status) => {
    api.inspectInvitation.mockResolvedValue(pending);
    api.acceptInvitation.mockRejectedValue(
      new AuthApiError(status, { error: { code: "invitation_attempt_ambiguous", message: "synthetic-secret" } }),
    );
    api.getInvitationAcceptanceStatus.mockResolvedValue({ type: "ambiguous" });
    const router = createMemoryRouter(
      [{ path: "/invite/:invitationId", loader, action, Component: MarketplaceInviteRoute }],
      { initialEntries: ["/invite/ivt_invited"] },
    );
    render(<RouterProvider router={router} />);
    await screen.findByText("Accept your invitation");
    fireEvent.click(screen.getByRole("radio", { name: "Password" }));
    fireEvent.submit(screen.getByLabelText("Enter or create a password").closest("form")!);
    await screen.findByText("Invitation acceptance could not be confirmed.");
    expect(api.getInvitationAcceptanceStatus).toHaveBeenCalledOnce();
    expect(api.acceptInvitation).toHaveBeenCalledOnce();
    expect(complete).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain("synthetic-secret");
  });
  it("retains one attempt on double-submit and manual retry after a known safe refusal", async () => {
    api.inspectInvitation.mockResolvedValue(pending);
    api.acceptInvitation
      .mockRejectedValueOnce(new AuthApiError(400, { error: { message: "synthetic-not-rendered" } }))
      .mockResolvedValue({ type: "confirming" });
    const router = createMemoryRouter(
      [{ path: "/invite/:invitationId", loader, action, Component: MarketplaceInviteRoute }],
      { initialEntries: ["/invite/ivt_invited"] },
    );
    render(<RouterProvider router={router} />);
    await screen.findByText("Accept your invitation");
    fireEvent.click(screen.getByRole("radio", { name: "Password" }));
    const form = screen.getByLabelText("Enter or create a password").closest("form")!;
    fireEvent.submit(form);
    fireEvent.submit(form);
    await screen.findByText("Review your input or check this attempt's status before continuing.");
    expect(api.acceptInvitation).toHaveBeenCalledOnce();
    const firstId = api.acceptInvitation.mock.calls[0][0].attemptId;
    fireEvent.submit(screen.getByLabelText("Enter or create a password").closest("form")!);
    await screen.findByText("Confirming invitation acceptance");
    expect(api.acceptInvitation).toHaveBeenCalledTimes(2);
    expect(api.acceptInvitation.mock.calls[1][0].attemptId).toBe(firstId);
    expect(api.getInvitationAcceptanceStatus).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });
  it("a known first Session result redirects once without an extra invitation revalidation", async () => {
    api.inspectInvitation.mockResolvedValue(pending);
    api.acceptInvitation.mockResolvedValue({
      type: "session-started",
      sessionId: "ses_reserved",
      sessionToken: "synthetic-session-secret",
    });
    complete.mockReturnValue(redirect("/account"));
    const router = createMemoryRouter(
      [
        { path: "/invite/:invitationId", loader, action, Component: MarketplaceInviteRoute },
        { path: "/account", Component: () => <div>Current account</div> },
      ],
      { initialEntries: ["/invite/ivt_invited"] },
    );
    render(<RouterProvider router={router} />);
    await screen.findByText("Accept your invitation");
    fireEvent.click(screen.getByRole("radio", { name: "Password" }));
    fireEvent.submit(screen.getByLabelText("Enter or create a password").closest("form")!);
    await screen.findByText("Current account");
    expect(api.acceptInvitation).toHaveBeenCalledOnce();
    expect(complete).toHaveBeenCalledOnce();
    expect(api.inspectInvitation).toHaveBeenCalledOnce();
    expect(api.getInvitationAcceptanceStatus).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain("synthetic-session-secret");
  });
  it("unknown write and lookup results render ambiguous with no prior Account or write retry", async () => {
    api.inspectInvitation.mockResolvedValue(pending);
    api.acceptInvitation.mockRejectedValue(new TypeError("synthetic-transport-secret"));
    api.getInvitationAcceptanceStatus.mockRejectedValue(new TypeError("synthetic-lookup-secret"));
    const router = createMemoryRouter(
      [{ path: "/invite/:invitationId", loader, action, Component: MarketplaceInviteRoute }],
      { initialEntries: ["/invite/ivt_invited"] },
    );
    render(<RouterProvider router={router} />);
    await screen.findByText("Accept your invitation");
    fireEvent.click(screen.getByRole("radio", { name: "Password" }));
    fireEvent.submit(screen.getByLabelText("Enter or create a password").closest("form")!);
    await screen.findByText("Invitation acceptance could not be confirmed.");
    expect(api.acceptInvitation).toHaveBeenCalledOnce();
    expect(complete).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /Accept with/ })).toBeNull();
    expect(document.body.textContent).not.toMatch(
      /synthetic-transport-secret|synthetic-lookup-secret|Synthetic invited Account/,
    );
  });
  it("a different Invitation never inherits the previous route's retained attempt", async () => {
    window.history.replaceState(
      {
        invitationAcceptanceAttempt: { invitationId: "ivt_invited", attemptId: "01c9f50d-cb3e-42ac-a0a8-8b5f887a01ea" },
      },
      "",
    );
    api.inspectInvitation.mockResolvedValue(pending);
    const router = createMemoryRouter(
      [{ path: "/invite/:invitationId", loader, action, Component: MarketplaceInviteRoute }],
      { initialEntries: ["/invite/ivt_invited"] },
    );
    render(<RouterProvider router={router} />);
    await screen.findByText("Confirming invitation acceptance");
    api.inspectInvitation.mockResolvedValue({
      ...pending,
      invitationId: "ivt_other",
      accountName: "Different invited Account",
    });
    await router.navigate("/invite/ivt_other");
    await screen.findByText("Accept your invitation");
    expect(screen.queryByText("Confirming invitation acceptance")).toBeNull();
    expect(document.body.textContent).not.toContain("Synthetic invited Account");
    expect(api.acceptInvitation).not.toHaveBeenCalled();
  });
});
