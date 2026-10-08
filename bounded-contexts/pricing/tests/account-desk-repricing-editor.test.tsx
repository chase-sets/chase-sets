// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
  vi.restoreAllMocks();
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
const fallbackMessage = "The repricing change could not be saved. Try again.";

function json(body: unknown, status = 200, headers: HeadersInit = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

type HeldWrite = {
  started: ReturnType<typeof deferred<void>>;
  response: ReturnType<typeof deferred<Response>>;
  completed: ReturnType<typeof deferred<void>>;
  unsubscribe: () => void;
};

function rejectedResponse(includeDetails = true) {
  return json(
    { error: { code: "validation_failed", ...(includeDetails ? { details: [{ message: validationMessage }] } : {}) } },
    400,
  );
}

function editor() {
  return screen.getByTestId("repricing-policy-editor");
}

function assertDetails() {
  expect(within(editor()).getByText(validationMessage)).toBeTruthy();
}

function assertSaving() {
  expect(editor().querySelector("fieldset")?.hasAttribute("inert")).toBe(true);
  expect(within(editor()).queryByText(validationMessage)).toBeNull();
}

async function fixture(detail: boolean) {
  let saved = false;
  let write: HeldWrite | undefined;
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
          if (!write) throw new Error("Save response must be held before submitting");
          write.started.resolve(undefined);
          const response = await write.response.promise;
          if (response.ok) saved = true;
          return response;
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
  const subscribe = router.subscribe.bind(router);
  type Notification = Parameters<Parameters<typeof router.subscribe>[0]>;
  const queued: { deliver: () => void; notification: Notification }[] = [];
  let holdNotifications = false;
  const subscription = vi.spyOn(router, "subscribe").mockImplementation((subscriber) =>
    subscribe((...notification) => {
      if (holdNotifications) queued.push({ deliver: () => subscriber(...notification), notification });
      else subscriber(...notification);
    }),
  );
  function releaseNotifications() {
    holdNotifications = false;
    for (const { deliver } of queued.splice(0)) deliver();
  }
  function holdWrite(): HeldWrite {
    const started = deferred<void>();
    const response = deferred<Response>();
    const completed = deferred<void>();
    let pending = false;
    const unsubscribe = subscribe((state) => {
      if (state.navigation.state !== "idle") pending = true;
      if (pending && state.navigation.state === "idle") {
        unsubscribe();
        completed.resolve(undefined);
      }
    });
    write = { started, response, completed, unsubscribe };
    return write;
  }
  if (!router.state.initialized) {
    await new Promise<void>((resolve) => {
      const unsubscribe = subscribe((state) => {
        if (state.initialized) {
          unsubscribe();
          resolve();
        }
      });
    });
  }
  await act(async () => {
    render(<RouterProvider router={router} />);
  });
  async function openAndPrepare() {
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: detail ? "Edit repricing policy" : "Create repricing policy" }),
      );
    });
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Policy name", { exact: true }), {
        target: { value: "Unsaved seller edit" },
      });
      if (!detail) {
        fireEvent.change(screen.getByLabelText("Minimum price", { exact: true }), { target: { value: "4.00" } });
      }
    });
    if (!detail) {
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Preview policy" }));
      });
    }
    expect(
      (screen.getByRole("button", { name: detail ? "Save policy" : "Activate policy" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  }
  async function submit() {
    const held = holdWrite();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: detail ? "Save policy" : "Activate policy" }));
      await held.started.promise;
    });
    assertSaving();
    return held;
  }
  async function settle(held: HeldWrite, response: Response) {
    await act(async () => {
      held.response.resolve(response);
      await held.completed.promise;
      releaseNotifications();
    });
  }
  return {
    router,
    openAndPrepare,
    submit,
    settle,
    holdNotifications: () => {
      holdNotifications = true;
    },
    queued,
    dispose: async () => {
      await act(async () => {
        releaseNotifications();
        write?.response.resolve(rejectedResponse());
        if (write && router.state.navigation.state !== "idle") await write.completed.promise;
        write?.unsubscribe();
        cleanup();
        router.dispose();
        subscription.mockRestore();
      });
    },
  };
}

describe("rendered repricing editor write lifecycle", () => {
  it.each([false, true])(
    "preserves edits/details on rejected save, clears reopened errors and closes only on receipt redirect (detail=%s)",
    async (detail) => {
      const test = await fixture(detail);
      const { router, openAndPrepare, submit, settle } = test;
      try {
        await openAndPrepare();
        const rejection = await submit();
        expect(router.state.location.search).not.toContain("postWriteToken=");
        await settle(rejection, rejectedResponse());
        assertDetails();
        expect(editor().querySelector("fieldset")?.hasAttribute("inert")).toBe(false);
        expect(router.state.location.search).not.toContain("postWriteToken=");
        expect((screen.getByLabelText("Policy name", { exact: true }) as HTMLInputElement).value).toBe(
          "Unsaved seller edit",
        );
        await act(async () => {
          fireEvent.click(screen.getByRole("button", { name: "Close" }));
        });
        expect(screen.queryByTestId("repricing-policy-editor")).toBeNull();
        await openAndPrepare();
        expect(within(screen.getByTestId("repricing-policy-editor")).queryByText(validationMessage)).toBeNull();
        expect(within(editor()).queryByText(fallbackMessage)).toBeNull();
        const success = await submit();
        expect(router.state.location.search).not.toContain("postWriteToken=");
        await settle(
          success,
          json(policy, detail ? 200 : 201, {
            "Chase-Sets-Consistency": "eventual",
            "Chase-Sets-Commit-Position": "51",
            "Chase-Sets-Commit-Event-Ids": "evt_synthetic",
            [CHASE_SETS_COMMIT_RECEIPT_HEADER]: encodeCommitReceipt([
              { sourceContextName: "pricing", maxGlobalPosition: "51", eventIds: ["evt_synthetic"] },
            ]),
          }),
        );
        expect(screen.queryByTestId("repricing-policy-editor")).toBeNull();
        expect(router.state.location.search).toContain("postWriteToken=");
        expect(router.state.actionData).toBeNull();
        expect(screen.getAllByText("Stored policy").length).toBeGreaterThan(0);
      } finally {
        await test.dispose();
      }
    },
  );

  it("router completion is not a rendered rejection", async () => {
    const test = await fixture(true);
    try {
      await test.openAndPrepare();
      const originalKey = test.router.state.location.key;
      const held = await test.submit();
      test.holdNotifications();
      const response = rejectedResponse();
      held.response.resolve(response);
      await held.completed.promise;
      await waitFor(() => expect(test.router.state.location.key).not.toBe(originalKey));
      expect(test.router.state.navigation.state).toBe("idle");
      expect(Object.values(test.router.state.actionData ?? {})).toEqual([
        { error: fallbackMessage, details: [validationMessage] },
      ]);
      expect(test.queued.at(-1)?.notification[0]).toBe(test.router.state);
      assertSaving();
      await expect(waitFor(assertDetails)).rejects.toThrow(validationMessage);
      console.info("AC2 OLD_PROTOCOL_RED: router idle with details; committed drawer still saving without details");
      await test.settle(held, response);
      assertDetails();
      expect(editor().querySelector("fieldset")?.hasAttribute("inert")).toBe(false);
      console.info(
        "AC2 OWNED_SETTLEMENT_GREEN: unchanged queued provider notifications committed; exact details rendered",
      );
    } finally {
      await test.dispose();
    }
  });

  it.each([false, true])(
    "settled rejection without details cannot satisfy the detail assertion (detail=%s)",
    async (detail) => {
      for (const includeDetails of [true, false]) {
        const test = await fixture(detail);
        try {
          await test.openAndPrepare();
          const held = await test.submit();
          await test.settle(held, rejectedResponse(includeDetails));
          expect(test.router.state.navigation.state).toBe("idle");
          expect(editor().querySelector("fieldset")?.hasAttribute("inert")).toBe(false);
          expect(Object.values(test.router.state.actionData ?? {})).toEqual([
            { error: fallbackMessage, details: includeDetails ? [validationMessage] : [] },
          ]);
          if (includeDetails) assertDetails();
          else {
            expect(assertDetails).toThrow(validationMessage);
            expect(within(editor()).getByText(fallbackMessage)).toBeTruthy();
          }
          console.info(
            `AC3 ${includeDetails ? "DETAILS_GREEN" : "OMISSION_RED_SAFE_FALLBACK"}: detail=${detail}, settled validation_failed 400`,
          );
        } finally {
          await test.dispose();
        }
      }
    },
  );
});
