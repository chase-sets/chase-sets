// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider, useRevalidator } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import IntegrationsRoute, { action, shouldRevalidate } from "../routes/admin/integrations";
import type {
  CatalogIntegrationsCommandResult,
  SourceObservationImportJobReceipt,
} from "../features/source-observations/ui/contracts";
import { buildCatalogPrimaryWorkbenchReadModelForSurface } from "../features/source-observations/ui/primary-workbench-read-model";
import {
  controlPlaneOverview,
  integrationJobSummary,
  loaderData,
  profileReview,
  sourceObservationScope,
} from "../features/source-observations/ui/primary-workbench-test-fixtures";

const { enqueue, rejectObservations } = vi.hoisted(() => ({
  enqueue: vi.fn(),
  rejectObservations: vi.fn(),
}));
vi.mock("../support/request-support/api-client", async () => {
  const { withCatalogSurfaceReads } = await vi.importActual<
    typeof import("../features/source-observations/tests/integrations-surface-read-test-client")
  >("../features/source-observations/tests/integrations-surface-read-test-client");
  return {
    createCatalogRequestApiClient: (request: Request) =>
      withCatalogSurfaceReads(
        {
          enqueueSourceObservationIntegrationJob: enqueue,
          bulkRejectSourceObservations: rejectObservations,
          recordCatalogControlPlaneEvent: vi.fn().mockResolvedValue({ status: "recorded" }),
        },
        request,
      ),
  };
});
vi.mock("@chase-sets/platform-runtime/auth", () => ({
  isTransientAuthResolutionError: () => false,
  resolveActorFromAuthApi: async () => ({ permissions: ["catalog.view", "catalog.manage"] }),
}));

const location =
  "/catalog/integrations?providerKey=tcgdex&unitKey=tcgdex:pokemon:card:import&importScope=en:3:base:base1&profileVersion=2026.06.04&jobId=synthetic-url-not-receipt";
const formA = {
  _intent: "scope.import",
  providerKey: "tcgdex",
  unitKey: "tcgdex:pokemon:card:import",
  importScope: "en:3:base:base1",
  profileVersion: "2026.06.04",
  jobId: "synthetic-form-not-receipt",
};
const formB = {
  _intent: "scope.import",
  providerKey: "scrydex",
  unitKey: "scrydex:one-piece:single-card:source-observation-import",
  importScope: "en:one-piece:op-01",
  profileVersion: "synthetic-profile-B",
  jobId: "synthetic-form-B-not-receipt",
  languageCode: "en",
  productLineId: "synthetic-line-B",
  seriesId: "one-piece",
  setId: "op-01",
};
const receiptA: SourceObservationImportJobReceipt = {
  schemaVersion: "source-observation-import-job-receipt/v1",
  jobId: "synthetic-job-A",
  status: "queued",
  scope: {
    provider: "tcgdex",
    ingestionUnitKey: formA.unitKey,
    language: "en",
    productLineId: "3",
    seriesId: "base",
    setId: "base1",
  },
  submitted: { providerKey: formA.providerKey, unitKey: formA.unitKey, profileVersion: formA.profileVersion },
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function RouteWithRefresh() {
  const revalidator = useRevalidator();
  return (
    <>
      <button disabled={revalidator.state !== "idle"} onClick={() => void revalidator.revalidate()}>
        Refresh receipt fixture
      </button>
      <IntegrationsRoute />
    </>
  );
}

const routers: ReturnType<typeof createMemoryRouter>[] = [];
beforeEach(() => {
  enqueue.mockReset().mockResolvedValue({ jobId: receiptA.jobId, status: receiptA.status });
  rejectObservations.mockReset().mockResolvedValue({ status: "recorded" });
});
afterEach(() => {
  cleanup();
  for (const router of routers.splice(0)) router.dispose();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function receiptNode() {
  return document.querySelector('[data-catalog-import-job-receipt="source-observation-import-job-receipt/v1"]');
}

function expectReceipt(expected: SourceObservationImportJobReceipt) {
  const root = receiptNode();
  expect(root).not.toBeNull();
  const fields = Object.fromEntries(
    [...root!.querySelectorAll<HTMLElement>("[data-catalog-receipt-field]")].map((field) => [
      field.dataset.catalogReceiptField,
      field.dataset.catalogReceiptKind === "null" ? null : field.textContent,
    ]),
  );
  expect(fields).toEqual({
    schemaVersion: expected.schemaVersion,
    jobId: expected.jobId,
    status: expected.status,
    ...Object.fromEntries(Object.entries(expected.scope).map(([key, value]) => [`scope.${key}`, value])),
    ...Object.fromEntries(Object.entries(expected.submitted).map(([key, value]) => [`submitted.${key}`, value])),
  });
}

function hiddenInputs() {
  return [...document.querySelectorAll<HTMLInputElement>('input[type="hidden"]')].map((field) => [
    field.name,
    field.value,
  ]);
}

async function mount(
  options: { active?: boolean; hydration?: CatalogIntegrationsCommandResult; omitReceipt?: () => boolean } = {},
) {
  const base = controlPlaneOverview();
  const readModel = buildCatalogPrimaryWorkbenchReadModelForSurface("health", {
    requestUrl: `http://localhost${location}`,
    scopes: { items: [sourceObservationScope()], total: 1, count: 1 },
    profileReviews: {
      items: [profileReview({ active: true, lifecycle: "active", profileVersion: formA.profileVersion })],
      total: 1,
      count: 1,
    },
    controlPlaneOverview: controlPlaneOverview({
      unitActivity: {
        ...base.unitActivity,
        units: [
          {
            unitKey: formA.unitKey,
            recentJobs: [
              integrationJobSummary({
                jobId: "synthetic-recent-other",
                operatorStatus: options.active ? "running" : "completed",
                phase: options.active ? "processing" : "completed",
              }),
            ],
          },
        ],
      },
    }),
    canManageCatalog: true,
  });
  const data = loaderData({ requestUrl: `http://localhost${location}`, readModel });
  let loaderGate: ReturnType<typeof deferred<void>> | null = null;
  let actionGate: ReturnType<typeof deferred<void>> | null = null;
  const load = vi.fn(async () => {
    await loaderGate?.promise;
    return data;
  });
  const runAction = vi.fn(async (args: Parameters<typeof action>[0]) => {
    await actionGate?.promise;
    const result = await action(args);
    if (!(result instanceof Response) && options.omitReceipt?.()) {
      // Transport compatibility control: the real action runs, but its optional receipt is absent.
      const { importJobReceipt: _omitted, ...withoutReceipt } = result;
      return withoutReceipt;
    }
    return result;
  });
  const router = createMemoryRouter(
    [
      {
        id: "daily",
        path: "/catalog/integrations",
        loader: load,
        action: runAction,
        shouldRevalidate,
        Component: RouteWithRefresh,
      },
      { path: "/elsewhere", Component: () => <p>Elsewhere</p> },
    ],
    {
      initialEntries: [location],
      ...(options.hydration
        ? { hydrationData: { loaderData: { daily: data }, actionData: { daily: options.hydration } } }
        : {}),
    },
  );
  routers.push(router);
  await act(async () => {
    render(<RouterProvider router={router} />);
  });
  await screen.findByRole("button", { name: "Refresh receipt fixture" });
  return {
    router,
    load,
    runAction,
    data,
    holdLoader: () => {
      loaderGate = deferred<void>();
      return () => {
        loaderGate!.resolve();
        loaderGate = null;
      };
    },
    holdAction: () => {
      actionGate = deferred<void>();
      return () => {
        actionGate!.resolve();
        actionGate = null;
      };
    },
  };
}

type Harness = Awaited<ReturnType<typeof mount>>;
function startSubmission(harness: Harness, values = formA) {
  const formData = new FormData();
  for (const [key, value] of Object.entries(values)) formData.set(key, value);
  return harness.router.navigate(location, { formMethod: "post", formData });
}
async function submit(harness: Harness, values = formA) {
  await act(async () => {
    await startSubmission(harness, values);
  });
}
async function refresh(harness: Harness) {
  const calls = harness.load.mock.calls.length;
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Refresh receipt fixture" }));
  });
  await waitFor(() => {
    expect(harness.load.mock.calls.length).toBeGreaterThan(calls);
    expect(harness.router.state.revalidation).toBe("idle");
  });
  expect(harness.router.state.actionData).toBeNull();
}

it("retains the exact settled import receipt through repeated same-location revalidation", async () => {
  const harness = await mount();
  expect(receiptNode()).toBeNull();
  const releaseAction = harness.holdAction();
  let submitted!: Promise<void>;
  await act(async () => {
    submitted = startSubmission(harness);
  });
  expect(harness.router.state.navigation.state).toBe("submitting");
  expect(receiptNode()).toBeNull();
  await act(async () => {
    releaseAction();
    await submitted;
  });
  expectReceipt(receiptA);
  expect(enqueue).toHaveBeenCalledWith("import", receiptA.scope);
  const initialLocation = harness.router.state.location;
  const inputs = hiddenInputs();
  const originalModel = structuredClone(harness.data.readModel);
  const storage = [JSON.stringify(localStorage), JSON.stringify(sessionStorage)];
  const fetch = vi.spyOn(globalThis, "fetch");
  for (let i = 0; i < 2; i++) {
    expect((screen.getByRole("button", { name: "Refresh receipt fixture" }) as HTMLButtonElement).disabled).toBe(false);
    const release = harness.holdLoader();
    const calls = harness.load.mock.calls.length;
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Refresh receipt fixture" }));
    });
    expect(harness.router.state.revalidation).toBe("loading");
    expect(harness.load.mock.calls.length).toBeGreaterThan(calls);
    expectReceipt(receiptA);
    await act(async () => {
      release();
    });
    await waitFor(() => expect(harness.router.state.revalidation).toBe("idle"));
    expect(harness.router.state.actionData).toBeNull();
    expectReceipt(receiptA);
    expect(harness.router.state.location).toEqual(initialLocation);
    expect(hiddenInputs()).toEqual(inputs);
    expect(harness.data.readModel).toEqual(originalModel);
  }
  expect(receiptNode()!.textContent).not.toContain("synthetic-recent-other");
  expect([JSON.stringify(localStorage), JSON.stringify(sessionStorage)]).toEqual(storage);
  expect(fetch).not.toHaveBeenCalled();
  expect(enqueue).toHaveBeenCalledTimes(1);
});

it.each(["failed", "refused", "non-import", "receipt-absent"] as const)(
  "discards the prior import receipt when another command starts: %s",
  async (settlement) => {
    let omitReceipt = false;
    const harness = await mount({ omitReceipt: () => omitReceipt });
    await submit(harness);
    expectReceipt(receiptA);
    const release = harness.holdAction();
    if (settlement === "failed") enqueue.mockRejectedValueOnce(new Error("synthetic second import failure"));
    omitReceipt = settlement === "receipt-absent";
    const values = {
      ...formA,
      ...(settlement === "refused"
        ? { importScope: "", languageCode: "", productLineId: "", seriesId: "", setId: "" }
        : {}),
      ...(settlement === "non-import"
        ? {
            _intent: "observation.reject",
            selectedObservationIds: "synthetic-observation",
            reason: "Synthetic lifecycle control",
          }
        : {}),
    };
    let submitted!: Promise<void>;
    await act(async () => {
      submitted = startSubmission(harness, values);
    });
    expect(harness.router.state.navigation.state).toBe("submitting");
    expect(receiptNode()).toBeNull();
    await act(async () => {
      release();
      await submitted;
    });
    expect(harness.router.state.navigation.state).toBe("idle");
    expect(receiptNode()).toBeNull();
    const result = harness.router.state.actionData!.daily as CatalogIntegrationsCommandResult;
    expect(result.importJobReceipt).toBeUndefined();
    expect(result.feedback.status).toBe(settlement === "failed" || settlement === "refused" ? "error" : "success");
    await refresh(harness);
    expect(receiptNode()).toBeNull();
    await refresh(harness);
    expect(receiptNode()).toBeNull();
  },
);

it("binds only the second import receipt to its own response", async () => {
  const harness = await mount();
  await submit(harness);
  expectReceipt(receiptA);
  enqueue.mockResolvedValueOnce({ jobId: "synthetic-job-B", status: "running" });
  const release = harness.holdAction();
  let submitted!: Promise<void>;
  await act(async () => {
    submitted = startSubmission(harness, formB);
  });
  expect(receiptNode()).toBeNull();
  await act(async () => {
    release();
    await submitted;
  });
  const receiptB: SourceObservationImportJobReceipt = {
    schemaVersion: receiptA.schemaVersion,
    jobId: "synthetic-job-B",
    status: "running",
    scope: {
      provider: formB.providerKey,
      ingestionUnitKey: formB.unitKey,
      language: "en",
      productLineId: "synthetic-line-B",
      seriesId: "one-piece",
      setId: "op-01",
    },
    submitted: { providerKey: formB.providerKey, unitKey: formB.unitKey, profileVersion: formB.profileVersion },
  };
  expect(enqueue).toHaveBeenNthCalledWith(2, "import", receiptB.scope);
  expectReceipt(receiptB);
  expect(receiptNode()!.textContent).not.toContain(receiptA.jobId);
  await refresh(harness);
  expectReceipt(receiptB);
  expect(enqueue).toHaveBeenCalledTimes(2);
});

it.each(["query", "hash", "path", "same-url-new-key"] as const)(
  "does not revive an import receipt after navigation or reload: %s",
  async (boundary) => {
    const harness = await mount();
    await submit(harness);
    expectReceipt(receiptA);
    const key = harness.router.state.location.key;
    const target =
      boundary === "query"
        ? `${location}&synthetic=other`
        : boundary === "hash"
          ? `${location}#other`
          : boundary === "path"
            ? "/elsewhere"
            : location;
    await act(async () => {
      await harness.router.navigate(target);
    });
    expect(harness.router.state.location.key).not.toBe(key);
    expect(receiptNode()).toBeNull();
    await act(async () => {
      await harness.router.navigate(-1);
    });
    expect(harness.router.state.location.pathname + harness.router.state.location.search).toBe(location);
    expect(receiptNode()).toBeNull();
    await refresh(harness);
    expect(receiptNode()).toBeNull();
    expect(enqueue).toHaveBeenCalledTimes(1);
  },
);

it("does not revive an import receipt after navigation or reload: identical-URL GET remount", async () => {
  const harness = await mount();
  await submit(harness);
  expectReceipt(receiptA);
  harness.router.dispose();
  cleanup();
  const remount = await mount();
  expect(remount.router.state.location.pathname + remount.router.state.location.search).toBe(location);
  expect(receiptNode()).toBeNull();
  await refresh(remount);
  expect(receiptNode()).toBeNull();
  expect(enqueue).toHaveBeenCalledTimes(1);
});

it("retains own hydrated action data A after its first revalidation", async () => {
  const formData = new FormData();
  for (const [key, value] of Object.entries(formA)) formData.set(key, value);
  const result = await action({
    request: new Request(`http://localhost${location}`, { method: "POST", body: formData }),
    url: new URL(`http://localhost${location}`),
    pattern: "/catalog/integrations",
    params: {},
    context: {},
  });
  expect(result).not.toBeInstanceOf(Response);
  const harness = await mount({ hydration: result as CatalogIntegrationsCommandResult });
  expectReceipt(receiptA);
  await refresh(harness);
  expectReceipt(receiptA);
  expect(enqueue).toHaveBeenCalledTimes(1);
});

it("retains the receipt through two mounted live-import poll ticks in the run-sync stage", async () => {
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const harness = await mount({ active: true });
  expect(harness.data.readModel.importJobs.activeJobCount).toBeGreaterThan(0);
  await submit(harness);
  expectReceipt(receiptA);
  const stage = document.querySelector('[data-catalog-import-workflow-stage="run-sync"]');
  expect(stage).not.toBeNull();
  expect(document.querySelector('[data-catalog-import-job-id="synthetic-recent-other"]')).not.toBeNull();
  const initialLocation = harness.router.state.location;
  for (let tick = 0; tick < 2; tick++) {
    const calls = harness.load.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000);
    });
    await waitFor(() => expect(harness.router.state.revalidation).toBe("idle"));
    expect(harness.load.mock.calls.length).toBeGreaterThan(calls);
    expect(harness.router.state.actionData).toBeNull();
    expectReceipt(receiptA);
    expect(harness.router.state.location).toEqual(initialLocation);
  }
  expect(enqueue).toHaveBeenCalledTimes(1);
});
