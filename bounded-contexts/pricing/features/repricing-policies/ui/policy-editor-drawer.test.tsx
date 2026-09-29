// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { subscribeDurableJobStatus } from "@chase-sets/platform-runtime/durable-job-web";
import { createPricingApiClient, PricingApiError } from "../../../support/request-support/api-client";
import type { PricingApiEnv } from "../../../api";
import { createRepricingDryRunRoutes } from "../../repricing-engine/api/dry-run-route";
import { validateRepricingDryRunBody, type RepricingDryRun } from "../../repricing-engine/api/dry-run";
import { dryRunBody, dryRunContext } from "../../repricing-engine/tests/dry-run-fixture";
import { PolicyEditorDrawer } from "./policy-editor-drawer";

vi.mock("@chase-sets/platform-runtime/durable-job-web", () => ({
  subscribeDurableJobStatus: vi.fn(() => ({ close: vi.fn(), current: () => null })),
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
const body = { ...dryRunBody, name: "Synthetic policy" };
const completed: RepricingDryRun = {
  dryRunId: "synthetic-run",
  body: dryRunBody,
  bodyHash: "server-body-hash",
  replacingPolicyId: null,
  status: "completed",
  requestedAt: "2026-09-27T00:00:00Z",
  completedAt: "2026-09-27T00:00:01Z",
  consumedAt: null,
  cursor: null,
  updatedAt: "2026-09-27T00:00:01Z",
  summary: {
    listingsEvaluated: 1,
    outcomes: { changed: 1 },
    flags: {},
    skipReasons: {},
    deltaBuckets: { "0": 1 },
    withinTolerance: 0,
  },
};
type EditorApi = NonNullable<Parameters<typeof PolicyEditorDrawer>[0]["api"]>;
function apiFixture(): EditorApi {
  return {
    getRepricingAuthoringPrerequisites: vi.fn(async () => ({ listingCurrencyCodes: ["CAD"], hasCostBasis: false })),
    listRepricingCategories: vi.fn(async () => [
      { id: "cat_synthetic", name: "Trading cards", status: "active", listingCount: 1 },
    ]),
    previewRepricingScope: vi.fn(async () => ({ matching: 1, governed: 1, shadowedBy: [], takenFrom: [] })),
    startRepricingDryRun: vi.fn(async () => completed),
    getRepricingDryRun: vi.fn(async () => completed),
    listRepricingDryRunTraces: vi.fn(async () => []),
  };
}
async function choose(label: string, option: string) {
  const user = userEvent.setup();
  await user.click(screen.getByRole("combobox", { name: label }));
  await user.click(await screen.findByRole("option", { name: option }));
  expect(screen.getByRole("combobox", { name: label }).textContent).toContain(option);
}
function fill(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label, { exact: true }), { target: { value } });
}

describe("policy editor prerequisites and gates", () => {
  it.each([[], ["CAD"], ["CAD", "USD"]].map((listingCurrencyCodes) => ({ listingCurrencyCodes })))(
    "authoring prerequisites never invent currency or amounts: $listingCurrencyCodes",
    async ({ listingCurrencyCodes }) => {
      const api = apiFixture();
      vi.mocked(api.getRepricingAuthoringPrerequisites).mockResolvedValue({
        listingCurrencyCodes,
        hasCostBasis: false,
      });
      render(<PolicyEditorDrawer api={api} onSave={vi.fn()} onClose={vi.fn()} />);
      expect(screen.getByText("Loading listing currencies and cost availability")).toBeTruthy();
      const minimum = await screen.findByLabelText("Minimum price", { exact: true });
      expect((minimum as HTMLInputElement).value).toBe("");
      expect((screen.getByRole("button", { name: "Activate policy" }) as HTMLButtonElement).disabled).toBe(true);
      fill("Minimum price", "4.00");
      const preview = screen.getByRole("button", { name: "Preview policy" }) as HTMLButtonElement;
      expect(preview.disabled).toBe(listingCurrencyCodes.length !== 1);
      expect((screen.getByRole("button", { name: "Open up this preset" }) as HTMLButtonElement).disabled).toBe(
        listingCurrencyCodes.length !== 1,
      );
      if (!listingCurrencyCodes.length) fill("Listing currency", "EUR");
      else if (listingCurrencyCodes.length > 1) await choose("Listing currency", "USD");
      fireEvent.click(preview);
      await waitFor(() => expect(api.startRepricingDryRun).toHaveBeenCalled());
      expect(vi.mocked(api.startRepricingDryRun).mock.calls[0]![0].rules[0]!.directive).toMatchObject({
        currencyCode: listingCurrencyCodes.length === 1 ? "CAD" : listingCurrencyCodes.length ? "USD" : "EUR",
        floor: { mode: "absolute", amount: "4.00" },
      });
    },
  );
  it("defaults cost-present accounts to cost plus 10% but requires the fallback; opens a two-rule preset without dropping younger stock", async () => {
    const api = apiFixture();
    vi.mocked(api.getRepricingAuthoringPrerequisites).mockResolvedValue({
      listingCurrencyCodes: ["CAD"],
      hasCostBasis: true,
    });
    render(<PolicyEditorDrawer api={api} onSave={vi.fn()} onClose={vi.fn()} />);
    await screen.findByLabelText("Margin above cost (%)");
    expect((screen.getByLabelText("Margin above cost (%)") as HTMLInputElement).value).toBe("10");
    expect((screen.getByLabelText("Minimum price when cost is unavailable") as HTMLInputElement).value).toBe("");
    fill("Minimum price when cost is unavailable", "4.00");
    await choose("Strategy", "Move slow stock");
    fireEvent.click(screen.getByRole("button", { name: "Open up this preset" }));
    expect(screen.getByText("Advanced rule editor", { exact: true })).toBeTruthy();
    expect(screen.getByText("Default rule (always last)")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Preview policy" }));
    await waitFor(() => expect(api.startRepricingDryRun).toHaveBeenCalled());
    const rules = vi.mocked(api.startRepricingDryRun).mock.calls[0]![0].rules;
    expect(rules).toHaveLength(2);
    expect(rules[1]!.directive.offset).toEqual({ mode: "percent", percent: 0 });
    expect(
      rules.every(
        (rule) =>
          rule.directive.floor.mode === "cost-basis-plus-margin" &&
          rule.directive.floor.absoluteFallbackAmount === "4.00",
      ),
    ).toBe(true);
  });
  it("keeps unavailable facts distinct from empty success and preserves the existing body after retry", async () => {
    const api = apiFixture();
    vi.mocked(api.getRepricingAuthoringPrerequisites).mockRejectedValueOnce(
      new PricingApiError(404, { error: { code: "not_found" } }),
    );
    render(
      <PolicyEditorDrawer api={api} initialBody={body} policyId="rpp_synthetic" onSave={vi.fn()} onClose={vi.fn()} />,
    );
    await screen.findByText(/Could not load authoring information/);
    expect(screen.queryByLabelText("Policy name")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByLabelText("Policy name");
    expect((screen.getByLabelText("Policy name") as HTMLInputElement).value).toBe(body.name);
    expect((screen.getByLabelText("Listing currency") as HTMLInputElement).value).toBe("USD");
    fill("Policy name", "Unsaved edit");
    fireEvent.click(screen.getByRole("button", { name: "Open advanced editor" }));
    expect((screen.getByLabelText("Policy name") as HTMLInputElement).value).toBe("Unsaved edit");
    expect(api.getRepricingAuthoringPrerequisites).toHaveBeenCalledTimes(2);
  });
  it("requires a completed current-body run, invalidates it on edit and ignores a late response", async () => {
    const api = apiFixture();
    const onSave = vi.fn();
    render(<PolicyEditorDrawer api={api} initialBody={body} onSave={onSave} onClose={vi.fn()} />);
    await screen.findByLabelText("Policy name");
    fireEvent.click(screen.getByRole("button", { name: "Preview policy" }));
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "Activate policy" }) as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(screen.getByRole("button", { name: "Activate policy" }));
    expect(onSave).toHaveBeenCalledWith({ body, dryRunId: "synthetic-run" });
    fill("Policy name", "Changed");
    expect((screen.getByRole("button", { name: "Activate policy" }) as HTMLButtonElement).disabled).toBe(true);
    let resolve!: (run: RepricingDryRun) => void;
    vi.mocked(api.startRepricingDryRun).mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Preview policy" }));
    fill("Policy name", "Edited while preview starts");
    resolve(completed);
    await waitFor(() => expect(screen.getByRole("button", { name: "Preview policy" })).toBeTruthy());
    expect((screen.getByRole("button", { name: "Activate policy" }) as HTMLButtonElement).disabled).toBe(true);
  });
  it("refreshes completion through SSE and never gates revision on a preview", async () => {
    const api = apiFixture();
    const queued = { ...completed, status: "queued" as const, summary: null };
    vi.mocked(api.startRepricingDryRun).mockResolvedValue(queued);
    vi.mocked(api.getRepricingDryRun).mockResolvedValue(queued);
    render(
      <PolicyEditorDrawer api={api} initialBody={body} policyId="rpp_synthetic" onSave={vi.fn()} onClose={vi.fn()} />,
    );
    await screen.findByLabelText("Policy name");
    expect((screen.getByRole("button", { name: "Save policy" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Preview policy" }));
    await waitFor(() => expect(subscribeDurableJobStatus).toHaveBeenCalled());
    vi.mocked(api.getRepricingDryRun).mockResolvedValue(completed);
    vi.mocked(subscribeDurableJobStatus).mock.calls.at(-1)![0].onStatus({ status: "completed" });
    await screen.findByText(/Previewed .* over 1 listings/);
  });
  it("any-mode is advanced-only and requires an explicitly entered band", async () => {
    const api = apiFixture();
    const initialBody = {
      ...body,
      rules: [
        {
          ...body.rules[0]!,
          directive: { ...body.rules[0]!.directive, anchorChain: [{ source: "lowest-competing-ask" as const }] },
        },
      ],
    };
    render(<PolicyEditorDrawer api={api} initialBody={initialBody} onSave={vi.fn()} onClose={vi.fn()} />);
    await screen.findByLabelText("Policy name");
    expect(screen.queryByRole("combobox", { name: "Listing stratum" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open advanced editor" }));
    await choose("Listing stratum", "Listings of any kind");
    expect(screen.getByText("Any-kind anchors require a band")).toBeTruthy();
    const band = screen.getByLabelText("Band minimum (% of market estimate)") as HTMLInputElement;
    expect(band.value).toBe("");
    fill("Band minimum (% of market estimate)", "80");
    fireEvent.click(screen.getByRole("button", { name: "Preview policy" }));
    await waitFor(() => expect(api.startRepricingDryRun).toHaveBeenCalled());
    expect(vi.mocked(api.startRepricingDryRun).mock.calls[0]![0].rules[0]!.directive.anchorChain).toEqual([
      { source: "lowest-competing-ask", strata: "any", band: { ground: "market-estimate", minPercentOfGround: 80 } },
    ]);
  });
  it.each(["empty-rules", "invalid-floor"])(
    "domain validation details reach ValidationSummary unchanged through the real dry-run route/client: %s",
    async (kind) => {
      const api = apiFixture();
      const app = new Hono<PricingApiEnv>();
      app.use("*", async (c, next) => {
        c.set("actor", {
          sessionId: "ses_synthetic",
          tenantId: "tnt_identity",
          userId: "usr_synthetic",
          accountId: "acc_7910",
          membershipId: "mbr_synthetic",
          roleKey: "owner",
          permissions: ["pricing.manage"],
        });
        c.set("context", dryRunContext);
        return next();
      });
      app.route(
        "/account/repricing-policies/dry-runs",
        createRepricingDryRunRoutes({
          enqueueDryRun: async (input) => ({
            ...completed,
            body: validateRepricingDryRunBody(input.body, input.sellerAccountId),
          }),
          getDryRun: async () => null,
          listDryRuns: async () => [],
          listDryRunTraces: async () => [],
          listDryRunEvents: async () => [],
          waitForDryRunEvents: async () => undefined,
        }),
      );
      api.startRepricingDryRun = createPricingApiClient({
        baseUrl: "https://synthetic.test",
        fetch: async (input, init) => app.request(String(input), init),
      }).startRepricingDryRun;
      const invalid =
        kind === "empty-rules"
          ? { ...body, rules: [] }
          : {
              ...body,
              rules: body.rules.map((rule) => ({
                ...rule,
                directive: { ...rule.directive, floor: { mode: "absolute" as const, amount: "0" } },
              })),
            };
      render(<PolicyEditorDrawer api={api} initialBody={invalid} onSave={vi.fn()} onClose={vi.fn()} />);
      await screen.findByLabelText("Policy name");
      fireEvent.click(screen.getByRole("button", { name: "Preview policy" }));
      const message =
        kind === "empty-rules"
          ? "A repricing policy must define at least one rule."
          : "Floor amount must be greater than zero.";
      expect(await screen.findByText(message)).toBeTruthy();
      expect(screen.getByRole("alert").textContent).toContain(message);
    },
  );
  it("domain validation details use safe fallback for code-only and internal failures", async () => {
    const api = apiFixture();
    vi.mocked(api.startRepricingDryRun).mockRejectedValue(
      new PricingApiError(400, { error: { code: "validation_failed", message: "internal-sentinel" } }),
    );
    render(<PolicyEditorDrawer api={api} initialBody={body} onSave={vi.fn()} onClose={vi.fn()} />);
    await screen.findByLabelText("Policy name");
    fireEvent.click(screen.getByRole("button", { name: "Preview policy" }));
    await screen.findByText("The policy could not be accepted. Check your entries and try again.");
    expect(document.body.textContent).not.toContain("internal-sentinel");
  });
});
