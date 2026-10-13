// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { ChaseRoot } from "@chase-sets/design-system";
import { RouterLinkAdapter } from "@chase-sets/design-system/react-router";
import Route, { action, loader } from "./account-agents-detail";
import { AuthApiError } from "../../support/request-support/api-client";
import type { AgentGrant } from "../../features/agent-grants/ui/contracts";

const { api } = vi.hoisted(() => ({
  api: {
    getAgentGrant: vi.fn(),
    listAgentGrantActivity: vi.fn(),
    getAgentGrantWebhook: vi.fn(),
    revokeAgentGrant: vi.fn(),
    getAgentGrantRevocation: vi.fn(),
  },
}));
vi.mock("../../support/request-support/api-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../support/request-support/api-client")>()),
  createUcpOAuthRequestApiClient: () => api,
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  window.sessionStorage.clear();
});
const grant: AgentGrant = {
  id: "grant_a",
  account_id: "acc_a",
  client_id: "client_a",
  client_name: "Synthetic Agent A",
  client_uri: null,
  platform_profile_url: "https://synthetic.example/profile",
  scopes: [],
  status: "active",
  access_token_expires_at: "2099-01-01T00:00:00.000Z",
  refresh_token_expires_at: null,
  granted_at: "2026-10-12T00:00:00.000Z",
  last_refreshed_at: null,
  revoked_at: null,
  revocation_reason: null,
  updated_at: "2026-10-12T00:00:00.000Z",
};
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function mount() {
  api.getAgentGrant.mockResolvedValue({ authorization: grant, revocation_available: true });
  api.listAgentGrantActivity.mockResolvedValue({ activity: [], total: 0 });
  api.getAgentGrantWebhook.mockResolvedValue({ webhook: null });
  const router = createMemoryRouter([{ path: "/account/agents/:id", loader, action, element: createElement(Route) }], {
    initialEntries: ["/account/agents/grant_a"],
  });
  render(createElement(ChaseRoot, { linkComponent: RouterLinkAdapter }, createElement(RouterProvider, { router })));
  await screen.findByText("You can revoke access or confirm interrupted cleanup.");
  return router;
}
async function revoke() {
  fireEvent.click(screen.getByRole("button", { name: "Revoke access" }));
  await screen.findByRole("alertdialog");
  fireEvent.click(screen.getAllByRole("button", { name: "Revoke access" }).at(-1)!);
}

describe("agent-grant-revocation-real-route", () => {
  it.each([
    { state: ["succeeded"], phase: ["completed"] },
    { state: "ambiguous", phase: ["identity-terminal"] },
  ])("rejects nested receipt scalars without a success frame or second write: %j", async (fields) => {
    const router = await mount();
    api.revokeAgentGrant.mockImplementation(async (_id: string, attemptId: string) => ({
      attempt_id: attemptId, ...fields,
    }));
    await revoke();
    await waitFor(() => expect(router.state.navigation.state).toBe("idle"));
    expect(router.state.actionData?.["0"]?.revocation).toMatchObject({ state: "ambiguous" });
    expect(router.state.actionData?.["0"]?.revocation).not.toHaveProperty("phase");
    expect(screen.queryByText("Access revoked and cleanup complete.")).toBeNull();
    expect(api.revokeAgentGrant).toHaveBeenCalledTimes(1);
    expect(api.getAgentGrantRevocation).not.toHaveBeenCalled();
  });
  it("reuses only the retained Account/Grant UUID without storing receipt or sensitive data", async () => {
    const attemptId = "6c165feb-a604-4ff5-8e22-8b4c99491728";
    window.sessionStorage.setItem("agent-grant-revocation:acc_a:grant_a", attemptId);
    await mount();
    api.revokeAgentGrant.mockResolvedValue({ attempt_id: attemptId, state: "succeeded", phase: "completed" });
    await revoke();
    await screen.findByText("Access revoked and cleanup complete.");
    expect(api.revokeAgentGrant).toHaveBeenCalledExactlyOnceWith("grant_a", attemptId);
    expect(window.sessionStorage.length).toBe(1);
    expect(window.sessionStorage.getItem("agent-grant-revocation:acc_a:grant_a")).toBe(attemptId);
  });
  it("renders submitting and confirming from actual router transitions, then completion", async () => {
    const response = deferred();
    const confirmation = deferred();
    await mount();
    api.revokeAgentGrant.mockImplementation(async (_id: string, attemptId: string) => {
      await response.promise;
      api.getAgentGrant.mockImplementation(async () => {
        await confirmation.promise;
        return { authorization: { ...grant, status: "revoked" }, revocation_available: true };
      });
      return { attempt_id: attemptId, state: "succeeded", phase: "completed" };
    });
    await revoke();
    await screen.findByText("Revoking access...");
    response.resolve();
    await screen.findByText("Confirming cleanup...");
    confirmation.resolve();
    await screen.findByText("Access revoked and cleanup complete.");
    expect(api.revokeAgentGrant).toHaveBeenCalledTimes(1);
    expect(api.getAgentGrantRevocation).not.toHaveBeenCalled();
  });
  it.each([
    "failed-safe",
    "conflict",
    "ambiguous",
    "reauth-required",
    "route-denied",
    "already-revoked-cleanup-complete",
  ])("renders safe %s state after one lost-response read", async (state) => {
    await mount();
    api.revokeAgentGrant.mockRejectedValue(new Error("SYNTHETIC_SECRET_ERROR"));
    api.getAgentGrantRevocation.mockImplementation(async (_id: string, attemptId: string) => {
      if (state === "reauth-required") throw new AuthApiError(401, {});
      if (state === "route-denied") throw new AuthApiError(404, {});
      return {
        attempt_id: attemptId,
        state,
        phase: state === "already-revoked-cleanup-complete" ? "completed" : "identity-terminal",
      };
    });
    await revoke();
    await waitFor(() => expect(api.getAgentGrantRevocation).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByText("Revoking access...")).toBeNull());
    expect(api.revokeAgentGrant).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).not.toContain("SYNTHETIC_SECRET_ERROR");
    const messages: Record<string, string> = {
      "failed-safe": "Cleanup could not be confirmed. Resume this attempt to finish safely.",
      conflict: "This attempt belongs to a different request. It has not been changed.",
      ambiguous: "The result is not confirmed. Resume the same attempt; do not start another.",
      "reauth-required": "Sign in again before confirming this attempt.",
      "route-denied": "This connected agent is not available in your current account.",
      "already-revoked-cleanup-complete": "Access was already revoked. Cleanup is complete.",
    };
    expect(screen.getByText(messages[state])).toBeTruthy();
  });
  it("removes the old Account frame while the real router waits for another Account's Grant", async () => {
    const router = await mount();
    const switched = deferred();
    api.getAgentGrant.mockImplementation(async () => {
      await switched.promise;
      return {
        authorization: { ...grant, id: "grant_b", account_id: "acc_b", client_name: "Synthetic Agent B" },
        revocation_available: true,
      };
    });
    const navigation = router.navigate("/account/agents/grant_b");
    await screen.findByText("Loading connected agent...");
    expect(screen.queryByText("Synthetic Agent A")).toBeNull();
    switched.resolve();
    await navigation;
    await screen.findByRole("heading", { name: "Synthetic Agent B" });
    expect(screen.queryByText("Synthetic Agent A")).toBeNull();
  });
});
