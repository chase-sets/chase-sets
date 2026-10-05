// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CHASE_SETS_COMMIT_RECEIPT_HEADER, encodeCommitReceipt } from "@chase-sets/http/responses";
import ListRoute, { action as listAction } from "../routes/marketplace/account-desk-repricing";
import DetailRoute, { action as detailAction } from "../routes/marketplace/account-desk-repricing-policy";
import { dryRunBody } from "../features/repricing-engine/tests/dry-run-fixture";

vi.mock("../support/request-support/api-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../support/request-support/api-client")>();
  return { ...actual, pricingApi: actual.createPricingApiClient({ fetch: (...args) => globalThis.fetch(...args) }) };
});
vi.mock("@chase-sets/platform-runtime/durable-job-web", () => ({
  subscribeDurableJobStatus: () => ({ close() {}, current: () => null }),
}));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const basePath = "/account/desk/repricing";
const policy = {
  ...dryRunBody,
  policyId: "rpp_synthetic",
  accountId: "acc_synthetic",
  name: "Stored policy",
  status: "active",
  createdAt: "2026-09-27T00:00:00Z",
  updatedAt: "2026-09-27T00:00:00Z",
};
const halt = { engaged: false, engagedAt: null, releasedAt: null };
const validationMessage = "Floor amount must be greater than zero.";

function json(body: unknown, status = 200, headers: HeadersInit = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

function fixture(detail: boolean) {
  let reject = true;
  let saved = false;
  const run = {
    dryRunId: "synthetic-run",
    body: dryRunBody,
    bodyHash: "synthetic-hash",
    status: "completed",
    consumedAt: null,
    requestedAt: "2026-09-27T00:00:00Z",
    completedAt: "2026-09-27T00:00:01Z",
    updatedAt: "2026-09-27T00:00:01Z",
    replacingPolicyId: null,
    cursor: null,
    summary: null,
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(new URL(String(input), "http://localhost"), init);
      const url = new URL(request.url);
      if (url.pathname.endsWith("/api/auth/session"))
        return json({
          actor: {
            sessionId: "ses_synthetic",
            tenantId: "tnt_identity",
            userId: "usr_synthetic",
            accountId: "acc_synthetic",
            membershipId: "mbr_synthetic",
            roleKey: "owner",
            permissions: ["pricing.view", "pricing.manage"],
          },
        });
      const path = url.pathname.replace("/api/marketplace/account/repricing-policies", "");
      if (request.method === "GET") {
        if (path === "/authoring-prerequisites") return json({ listingCurrencyCodes: ["USD"], hasCostBasis: false });
        if (path === "/categories" || path.endsWith("/traces")) return json([]);
        if (path === "/dry-runs/synthetic-run") return json(run);
      }
      if (request.method === "POST") {
        if (path === "/scope-preview") return json({ matching: 0, governed: 0, shadowedBy: [], takenFrom: [] });
        if (path === "/dry-runs") return json(run, 202);
        if (path === "" || path === "/rpp_synthetic/revise") {
          if (reject)
            return json({ error: { code: "validation_failed", details: [{ message: validationMessage }] } }, 400);
          saved = true;
          return json(policy, detail ? 200 : 201, {
            "Chase-Sets-Consistency": "eventual",
            "Chase-Sets-Commit-Position": "51",
            "Chase-Sets-Commit-Event-Ids": "evt_synthetic",
            [CHASE_SETS_COMMIT_RECEIPT_HEADER]: encodeCommitReceipt([
              { sourceContextName: "pricing", maxGlobalPosition: "51", eventIds: ["evt_synthetic"] },
            ]),
          });
        }
      }
      throw new Error(`Unexpected synthetic API request ${request.method} ${path}`);
    }),
  );
  const path = detail ? `${basePath}/rpp_synthetic` : basePath;
  const router = createMemoryRouter(
    [
      {
        path,
        Component: detail ? DetailRoute : ListRoute,
        action: detail ? detailAction : listAction,
        loader: () =>
          detail
            ? {
                recovery: null,
                policy,
                halt,
                changesUsedToday: 0,
                activity: null,
                activityFilter: null,
                activityLoadFailed: false,
              }
            : {
                policies: saved ? [{ ...policy, changesUsedToday: 0 }] : [],
                halt,
                dryRuns: [],
                catchingUp: false,
                loadFailed: false,
              },
      },
    ],
    { initialEntries: [path] },
  );
  render(<RouterProvider router={router} />);
  return {
    router,
    succeed: () => {
      reject = false;
    },
  };
}

describe("rendered repricing editor write lifecycle", () => {
  it.each([false, true])(
    "preserves edits/details on rejected save, clears reopened errors and closes only on receipt redirect (detail=%s)",
    async (detail) => {
      const { router, succeed } = fixture(detail);
      const openLabel = detail ? "Edit repricing policy" : "Create repricing policy";
      async function openAndPrepare() {
        fireEvent.click(await screen.findByRole("button", { name: openLabel }));
        const name = await screen.findByLabelText("Policy name", { exact: true });
        fireEvent.change(name, { target: { value: "Unsaved seller edit" } });
        if (!detail) {
          fireEvent.change(screen.getByLabelText("Minimum price", { exact: true }), { target: { value: "4.00" } });
          fireEvent.click(screen.getByRole("button", { name: "Preview policy" }));
          await waitFor(() =>
            expect((screen.getByRole("button", { name: "Activate policy" }) as HTMLButtonElement).disabled).toBe(false),
          );
        }
      }
      try {
        await openAndPrepare();
        const originalKey = router.state.location.key;
        fireEvent.click(screen.getByRole("button", { name: detail ? "Save policy" : "Activate policy" }));
        await waitFor(() => expect(router.state.location.key).not.toBe(originalKey));
        await waitFor(() =>
          expect(within(screen.getByTestId("repricing-policy-editor")).getByText(validationMessage)).toBeTruthy(),
        );
        expect((screen.getByLabelText("Policy name", { exact: true }) as HTMLInputElement).value).toBe(
          "Unsaved seller edit",
        );
        fireEvent.click(screen.getByRole("button", { name: "Close" }));
        await openAndPrepare();
        expect(within(screen.getByTestId("repricing-policy-editor")).queryByText(validationMessage)).toBeNull();
        succeed();
        fireEvent.click(screen.getByRole("button", { name: detail ? "Save policy" : "Activate policy" }));
        await waitFor(() => expect(screen.queryByTestId("repricing-policy-editor")).toBeNull());
        expect(router.state.location.search).toContain("postWriteToken=");
        expect(router.state.actionData).toBeNull();
        expect(screen.getAllByText("Stored policy").length).toBeGreaterThan(0);
      } finally {
        router.dispose();
      }
    },
  );
});
