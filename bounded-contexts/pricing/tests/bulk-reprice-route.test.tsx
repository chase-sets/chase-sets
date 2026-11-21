// @vitest-environment jsdom
import { File as NodeFile } from "node:buffer";
import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";

type Upload = Readonly<{ accountId: string; idempotencyKey: string | undefined; csvText: string }>;

// A synthetic Pricing API: one job per account and upload attempt, as the real route keys it.
const pricing = vi.hoisted(() => ({
  jobs: new Map<string, string>(),
  uploads: [] as Upload[],
  loseNextReply: false,
}));

vi.mock("@chase-sets/platform-runtime/auth", () => ({
  requireActorFromAuthApi: vi.fn(async () => ({ accountId: "acc_seller_synthetic" })),
}));
vi.mock("@chase-sets/platform-runtime/durable-job-web", () => ({
  subscribeDurableJobStatus: () => ({ close: () => undefined }),
}));
vi.mock("../support/request-support/api-client", () => ({
  PricingApiError: class PricingApiError extends Error {
    status = 500;
  },
  createPricingRequestApiClient: () => ({
    isBulkRepriceAvailable: async () => true,
    createBulkRepriceJob: async (input: Readonly<{ csvText: string }>, idempotencyKey?: string) => {
      const accountId = "acc_seller_synthetic";
      pricing.uploads.push({ accountId, idempotencyKey, csvText: input.csvText });
      const key = `${accountId}:${idempotencyKey ?? crypto.randomUUID()}`;
      let jobId = pricing.jobs.get(key);
      if (!jobId) {
        jobId = `job_${pricing.jobs.size + 1}`;
        pricing.jobs.set(key, jobId);
      }
      if (pricing.loseNextReply) {
        pricing.loseNextReply = false;
        throw new Error("Request failed.");
      }
      return { jobId };
    },
  }),
}));

const { default: BulkRepriceRoute, action } = await import("../routes/marketplace/bulk-reprice");

function routerReady(router: ReturnType<typeof createMemoryRouter>) {
  if (router.state.initialized && router.state.navigation.state === "idle" && router.state.revalidation === "idle")
    return Promise.resolve();
  return new Promise<void>((resolve) => {
    const unsubscribe = router.subscribe((state) => {
      if (state.initialized && state.navigation.state === "idle" && state.revalidation === "idle") {
        unsubscribe();
        resolve();
      }
    });
  });
}

// The router posts a Request built from the form's FormData, and Node's Request (which the action
// parses) accepts only Node's own FormData and File. Read the form the way a browser does, into those.
const NodeFormData = (await new Response(new URLSearchParams()).formData()).constructor as typeof FormData;
class BrowserFormData extends NodeFormData {
  constructor(form?: HTMLFormElement, submitter?: HTMLElement | null) {
    super();
    for (const element of Array.from(form?.elements ?? []) as HTMLInputElement[]) {
      if (!element.name || element.disabled || element.type === "submit") continue;
      if (element.type === "file") for (const file of Array.from(element.files ?? [])) this.append(element.name, file);
      else this.append(element.name, element.value);
    }
    const button = submitter as HTMLButtonElement | null | undefined;
    if (button?.name) this.append(button.name, button.value);
  }
}

// jsdom cannot hold a real file selection, so its constraint check refuses the required file input on a
// click. Dispatch the submit a browser sends once a file is chosen, with the Upload button as submitter.
function upload() {
  const button = screen.getByRole("button", { name: "Upload CSV" }) as HTMLButtonElement;
  act(() => {
    button.form!.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true, submitter: button }));
  });
}

describe("Bulk reprice upload through a real data router", () => {
  beforeEach(() => {
    vi.stubGlobal("crypto", webcrypto);
    vi.stubGlobal("FormData", BrowserFormData);
    vi.stubGlobal("File", NodeFile);
    pricing.jobs.clear();
    pricing.uploads.length = 0;
    pricing.loseNextReply = false;
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("retries a lost upload reply from the error with the same file and attempt, and lands on the first job", async () => {
    const router = createMemoryRouter(
      [
        {
          path: "/account/bulk-reprice",
          Component: BulkRepriceRoute,
          loader: ({ request }) => ({
            available: true,
            activeJobId: new URL(request.url).searchParams.get("jobId"),
            activeJob: null,
          }),
          action,
        },
      ],
      { initialEntries: ["/account/bulk-reprice"] },
    );
    const { container } = render(<RouterProvider router={router} />);
    await routerReady(router);
    await screen.findByRole("button", { name: "Upload CSV" });

    const fileInput = container.querySelector<HTMLInputElement>('input[name="file"]')!;
    fireEvent.change(fileInput, {
      target: { files: [new File(["sku,price\nsku_1,1.00"], "prices.csv", { type: "text/csv" })] },
    });
    const attempt = () => container.querySelector<HTMLInputElement>('input[name="idempotencyKey"]')?.value;
    const key = attempt();
    expect(key).toMatch(/^[0-9a-f-]{36}$/);

    pricing.loseNextReply = true;
    upload();
    await routerReady(router);

    expect(await screen.findByText("Request failed.")).toBeTruthy();
    expect(router.state.location.search).toBe("");
    expect(pricing.jobs.size).toBe(1);
    expect(container.querySelector('input[name="file"]')).toBe(fileInput);
    expect(fileInput.files?.[0]?.name).toBe("prices.csv");
    expect(attempt()).toBe(key);

    upload();
    await routerReady(router);

    expect(router.state.location.search).toBe("?jobId=job_1");
    expect(pricing.uploads).toEqual([
      { accountId: "acc_seller_synthetic", idempotencyKey: key, csvText: "sku,price\nsku_1,1.00" },
      { accountId: "acc_seller_synthetic", idempotencyKey: key, csvText: "sku,price\nsku_1,1.00" },
    ]);
    expect(pricing.jobs.size).toBe(1);
    await waitFor(() => expect(attempt()).not.toBe(key));
  });
});
