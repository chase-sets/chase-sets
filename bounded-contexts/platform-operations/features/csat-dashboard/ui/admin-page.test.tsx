import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryRouter, RouterProvider } from "react-router";
import { CsatAdminPage } from "./admin-page";

const capability = "customer-feedback.privacy.export-sensitive-feedback";
const metadata = {
  exportId: "cse_fixture",
  rowCount: 0,
  status: "completed",
  artifactExpiresAt: "2099-01-01T00:00:00.000Z",
};

function dashboard(): Parameters<typeof CsatAdminPage>[0]["data"] {
  const metric = {
    csat: null,
    csatAvailability: "zero-denominator" as const,
    satisfiedCount: 0,
    submittedCount: 0,
    responseRate: null,
    responseRateAvailability: "zero-denominator" as const,
    presentedCount: 0,
    respondedPresentedCount: 0,
    ratingDistribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
    volume: { eligible: 0, issued: 0, presented: 0, dismissed: 0, expired: 0, submitted: 0 },
  };
  const surveyVersion = {
    surveyKind: "transactional-csat" as const,
    surveyVersion: "csat.v1",
    questionVersion: "csat.q.v1",
  };
  return {
    analytics: {
      asOf: "2026-11-01T00:00:00.000Z",
      timezone: "UTC",
      filters: { surveyVersion },
      windows: {
        "trailing-7d": { ...metric, window: "trailing-7d", from: "2026-10-25", to: "2026-11-01" },
        "trailing-30d": { ...metric, window: "trailing-30d", from: "2026-10-02", to: "2026-11-01" },
      },
      trend: { items: [], nextCursor: null, limit: 31, granularity: "day", from: "2026-10-02", to: "2026-11-01" },
      health: {
        complete: true,
        stale: false,
        lastProjectedAt: null,
        projectionLagMs: 0,
        rejectedEventCount: 0,
        denominatorAnomalyCount: 0,
        invitationToSubmissionLatency: { sampleCount: 0, medianMs: null, p95Ms: null, maximumMs: null },
      },
    },
    queue: { items: [], nextCursor: null, previousCursor: null, limit: 50 },
    filters: {
      from: "2026-10-02",
      to: "2026-11-01",
      surveyVersion,
      outcomeCodes: ["checkout.completed", "order.delivered"],
      customerRoles: ["buyer", "seller"],
      states: ["submitted", "presented"],
      ratings: [4, 5],
      followUpConsent: "granted",
    },
  };
}

async function show(permissions = [capability]) {
  const router = createMemoryRouter([
    {
      id: "root",
      path: "/",
      loader: () => ({ actor: { permissions } }),
      children: [{ index: true, element: <CsatAdminPage data={dashboard()} /> }],
    },
  ]);
  render(<RouterProvider router={router} />);
  await screen.findByText("CSAT operations");
  return router;
}

describe("CSAT page canonical export workflow", () => {
  const fetcher = vi.fn<typeof fetch>();
  const createObjectURL = vi.fn(() => "blob:csat-export");
  const revokeObjectURL = vi.fn();
  beforeEach(() => {
    vi.stubGlobal("fetch", fetcher.mockReset());
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectURL.mockClear() });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeObjectURL.mockClear() });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("hides export for legacy-only and view/manage-only actors", async () => {
    await show(["platform-feedback.export", "platform-feedback.view", "platform-feedback.manage"]);
    expect(screen.queryByRole("button", { name: "Export safe CSV" })).toBeNull();
    expect(screen.queryByLabelText("Export reason")).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("requires a reason, carries all applied filters, and downloads CSV only after 201 metadata", async () => {
    let finishCreation!: (response: Response) => void;
    fetcher.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          finishCreation = resolve;
        }),
    );
    fetcher.mockResolvedValueOnce(new Response("header\n", { headers: { "Content-Type": "text/csv; charset=utf-8" } }));
    await show();
    const button = screen.getByRole("button", { name: "Export safe CSV" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Export reason"), { target: { value: "case-review" } });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(button.disabled).toBe(true);
    expect(screen.getByRole("status", { name: "Export safe CSV" }).textContent).toBe(
      "Creating and downloading export...",
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    const query = new URL(String(url), "https://admin.test").searchParams;
    expect(Object.fromEntries(query)).toEqual({
      from: "2026-10-02",
      to: "2026-11-01",
      surveyVersion: "csat.v1",
      outcomeCodes: "checkout.completed,order.delivered",
      customerRoles: "buyer,seller",
      states: "submitted,presented",
      ratings: "4,5",
      followUpConsent: "granted",
      reason: "case-review",
    });
    expect(init).toMatchObject({ method: "GET", credentials: "include", cache: "no-store" });
    expect(createObjectURL).not.toHaveBeenCalled();
    finishCreation(Response.json(metadata, { status: 201 }));
    await waitFor(() =>
      expect(screen.getByRole("status", { name: "Export safe CSV" }).textContent).toBe("Export downloaded."),
    );
    expect(fetcher).toHaveBeenLastCalledWith(
      "/api/customer-feedback/export/cse_fixture",
      expect.objectContaining({ credentials: "include", cache: "no-store" }),
    );
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(HTMLAnchorElement.prototype.click).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:csat-export");
    expect(button.disabled).toBe(false);
  });

  it.each(["creation-denied", "metadata-not-created", "expired-metadata", "missing", "expired", "json", "network"])(
    "shows failure and never downloads for %s",
    async (failure) => {
      if (failure === "creation-denied")
        fetcher.mockResolvedValueOnce(Response.json({ error: "forbidden" }, { status: 403 }));
      else if (failure === "metadata-not-created") fetcher.mockResolvedValueOnce(Response.json(metadata));
      else if (failure === "expired-metadata")
        fetcher.mockResolvedValueOnce(Response.json({ ...metadata, artifactExpiresAt: "2000-01-01" }, { status: 201 }));
      else {
        fetcher.mockResolvedValueOnce(Response.json(metadata, { status: 201 }));
        if (failure === "network") fetcher.mockRejectedValueOnce(new Error("offline"));
        else
          fetcher.mockResolvedValueOnce(
            Response.json({ error: "missing" }, { status: failure === "json" ? 200 : 404 }),
          );
      }
      await show();
      fireEvent.change(screen.getByLabelText("Export reason"), { target: { value: "quality-review" } });
      fireEvent.click(screen.getByRole("button", { name: "Export safe CSV" }));
      await waitFor(() =>
        expect(screen.getByRole("status", { name: "Export safe CSV" }).textContent).toContain(
          "Export could not be downloaded.",
        ),
      );
      expect(createObjectURL).not.toHaveBeenCalled();
      expect(HTMLAnchorElement.prototype.click).not.toHaveBeenCalled();
    },
  );
});
