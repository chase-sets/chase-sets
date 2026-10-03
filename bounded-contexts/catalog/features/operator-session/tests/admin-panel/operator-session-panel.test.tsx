// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CatalogProviderDetailRoute, { loader } from "../../../../routes/admin/catalog-provider-detail";
import { buildCatalogPrimaryWorkbenchReadModelForSurface } from "../../../source-observations/ui/primary-workbench-read-model";
import { OperatorSessionPanel } from "../../ui/admin-panel/operator-session-panel";
import {
  absentMetadata,
  activeGrant,
  browserExpiresAt,
  clearedMetadata,
  createControlledHttp,
  flatForbidden,
  grantPath,
  hostForbidden,
  hostileMarker,
  inactiveGrant,
  metadataPath,
  payoutNestedStepUp,
  stepUpRequired,
  storedMetadata,
  syntheticGrant,
  type ControlledHttp,
} from "./controlled-http";

const mocks = vi.hoisted(() => ({ resolveActor: vi.fn(), loadHealthSurface: vi.fn() }));

vi.mock("@chase-sets/platform-runtime/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@chase-sets/platform-runtime/auth")>()),
  resolveActorFromAuthApi: mocks.resolveActor,
}));
vi.mock("../../../../support/route-support/admin-integrations/integrations-loader-support", () => ({
  loadHealthSurface: mocks.loadHealthSurface,
}));
vi.mock("../../../../support/request-support/api-client", () => ({
  createCatalogRequestApiClient: () => ({}),
}));

const signInHref = "/catalog/sign-in?returnTo=%2Fcatalog%2Fproviders%2Ftcgplayer";
let http: ControlledHttp;
let writeText: ReturnType<typeof vi.fn>;

beforeEach(() => {
  http = createControlledHttp();
  vi.stubGlobal("fetch", http.fetch);
  writeText = vi.fn(async () => undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  mocks.resolveActor.mockResolvedValue(actor("platform-admin"));
  mocks.loadHealthSurface.mockImplementation(async ({ request }: { request: Request }) => ({
    readModel: providerReadModel(request.url),
    requestUrl: request.url,
    commandFeedback: null,
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function actor(roleKey: string, userId = "user-synthetic-1") {
  return {
    sessionId: "session-synthetic",
    tenantId: "tenant-synthetic",
    userId,
    accountId: "account-synthetic",
    membershipId: `membership-${userId}`,
    roleKey,
    permissions: ["catalog.view", "catalog.manage"],
  };
}

// A provider with no profiles yet keeps the real page composition while
// rendering far fewer workbench sections around the panel.
function providerReadModel(requestUrl: string) {
  return buildCatalogPrimaryWorkbenchReadModelForSurface("health", {
    requestUrl,
    scopes: { items: [], total: 0, count: 0 },
    profileReviews: { items: [], total: 0, count: 0 },
    controlPlaneOverview: null,
    canManageCatalog: true,
  });
}

function renderProviderRoute(path = "/catalog/providers/tcgplayer") {
  const router = createMemoryRouter(
    [
      {
        path: "/catalog/providers/:providerKey",
        element: <CatalogProviderDetailRoute />,
        loader,
        HydrateFallback: () => null,
      },
    ],
    { initialEntries: [path] },
  );
  render(<RouterProvider router={router} />);
  return router;
}

// Route tests render the whole provider-detail page, so waits anchor on cheap
// attribute selectors; role and name assertions stay scoped to small subtrees
// instead of walking the page's accessibility tree on every poll.
async function findBySelector(selector: string) {
  return waitFor(() => {
    const element = document.querySelector<HTMLElement>(selector);
    if (!element) throw new Error(`${selector} is not rendered`);
    return element;
  });
}

const findPanel = () => findBySelector("[data-catalog-operator-session-panel]");
const findProviderPage = () => findBySelector("[data-catalog-provider-detail]");
const findDialog = () => findBySelector('[role="alertdialog"]');

async function waitForDialogClosed() {
  await waitFor(() => expect(document.querySelector('[role="alertdialog"]')).toBeNull());
}

function accessibleTitle(element: HTMLElement) {
  return document.getElementById(element.getAttribute("aria-labelledby") ?? "")?.textContent;
}

async function findGrantRegion(panel: HTMLElement) {
  return waitFor(() => {
    const region = panel.querySelector<HTMLElement>("[data-operator-session-grant]");
    if (!region) throw new Error("grant display is not shown");
    return region;
  });
}

async function renderPanelWith(body: unknown, status = 200) {
  http.reply("GET", metadataPath, status, body);
  render(<OperatorSessionPanel />);
  const panel = await findPanel();
  await waitFor(() => expect(within(panel).queryByText("Loading operator session…")).toBeNull());
  return panel;
}

async function confirmDisconnect(panel: HTMLElement) {
  fireEvent.click(within(panel).getByRole("button", { name: "Disconnect" }));
  const dialog = await findDialog();
  expect(accessibleTitle(dialog)).toBe("Disconnect the stored session?");
  fireEvent.click(within(dialog).getByRole("button", { name: "Disconnect" }));
  await waitForDialogClosed();
}

function normalizedMarkup(element: HTMLElement) {
  return element.outerHTML.replace(/ (id|aria-labelledby|aria-describedby|aria-controls)="[^"]*"/g, "");
}

describe("AC1 operator session metadata states", () => {
  it("shows absent custody at revision 0 with pairing and no Disconnect", async () => {
    const panel = await renderPanelWith(absentMetadata());

    expect(within(panel).getByText("No stored session")).toBeTruthy();
    expect(within(panel).queryByText("Stored session cleared")).toBeNull();
    expect(within(panel).getByText("Revision").nextElementSibling?.textContent).toBe("0");
    expect(within(panel).getByText("Custody available").nextElementSibling?.textContent).toBe("Yes");
    expect(within(panel).getByText("No grant")).toBeTruthy();
    expect(within(panel).queryByText("Stored at")).toBeNull();
    expect(within(panel).getByRole("button", { name: "Pair extension" })).toBeTruthy();
    expect(within(panel).queryByRole("button", { name: "Disconnect" })).toBeNull();
  });

  it("shows stored custody at revision 1 with its own instants and break-glass Disconnect", async () => {
    const panel = await renderPanelWith(storedMetadata(1));

    expect(within(panel).getByText("Revision").nextElementSibling?.textContent).toBe("1");
    expect(within(panel).getByText("Stored at").nextElementSibling?.textContent).toBe("Sep 30, 2026, 12:00 PM UTC");
    expect(within(panel).getByText("Browser expiry").nextElementSibling?.textContent).toBe(
      "Dec 30, 2026, 12:00 PM UTC",
    );
    expect(within(panel).queryByText("No stored session")).toBeNull();
    expect(within(panel).queryByText(/cannot be read with the current key/)).toBeNull();
    expect(within(panel).getByRole("button", { name: "Disconnect" })).toBeTruthy();
  });

  it("keeps cleared custody at its retained revision across a reload, never resetting to absent", async () => {
    const panel = await renderPanelWith(clearedMetadata(2));
    expect(within(panel).getByText("Stored session cleared")).toBeTruthy();
    expect(within(panel).getByText(/record is kept at revision 2\./)).toBeTruthy();
    expect(within(panel).getByText("Revision").nextElementSibling?.textContent).toBe("2");
    expect(within(panel).queryByText("No stored session")).toBeNull();
    expect(within(panel).queryByRole("button", { name: "Disconnect" })).toBeNull();
    cleanup();

    const reloaded = await renderPanelWith(clearedMetadata(2));
    expect(within(reloaded).getByText("Stored session cleared")).toBeTruthy();
    expect(within(reloaded).getByText("Revision").nextElementSibling?.textContent).toBe("2");
    expect(within(reloaded).queryByText("No stored session")).toBeNull();
    expect(http.requests).toEqual([`GET ${metadataPath}`, `GET ${metadataPath}`]);
  });

  it.each([
    ["null", null, "None"],
    ["past", "2026-01-01T00:00:00.000Z", "Jan 1, 2026, 12:00 AM UTC"],
  ])(
    "renders a %s browser expiry as the instant only, without inferring provider validity",
    async (_label, expiry, text) => {
      const panel = await renderPanelWith(storedMetadata(1, { browserExpiresAt: expiry }));

      expect(within(panel).getByText("Browser expiry").nextElementSibling?.textContent).toBe(text);
      expect(panel.textContent).not.toMatch(/expired|valid|healthy/i);
    },
  );

  it("renders unreadable stored custody identically for the env-configured and env-absent scenario labels", async () => {
    // Synthetic scenario labels only: the closed DTO carries no environment
    // field, so both scenarios serve the identical response.
    const unreadable = storedMetadata(3, { custodyAvailable: false, grant: activeGrant });
    const markup: string[] = [];
    for (const scenario of ["environment session configured", "no environment session configured"]) {
      const panel = await renderPanelWith(unreadable);
      expect(within(panel).getByText("Revision").nextElementSibling?.textContent).toBe("3");
      expect(within(panel).getByText("Stored at").nextElementSibling?.textContent).toBe("Sep 30, 2026, 12:00 PM UTC");
      expect(within(panel).getByText("Custody available").nextElementSibling?.textContent).toBe("No");
      expect(within(panel).getByText(/cannot be read with the current key/)).toBeTruthy();
      expect(within(panel).getByRole("button", { name: "Disconnect" })).toBeTruthy();
      expect(panel.textContent, scenario).not.toMatch(/fallback (is )?(active|in use)|using the environment/i);
      markup.push(normalizedMarkup(panel));
      cleanup();
    }
    expect(markup[0]).toBe(markup[1]);
  });

  it.each([
    ["absent", absentMetadata({ custodyAvailable: false }), "No stored session"],
    ["cleared", clearedMetadata(2, { custodyAvailable: false }), "Stored session cleared"],
  ])(
    "shows %s custody without a write key as unavailable custody, not unreadable custody",
    async (_label, body, title) => {
      const panel = await renderPanelWith(body);

      expect(within(panel).getByText(title)).toBeTruthy();
      expect(within(panel).getByText("Custody available").nextElementSibling?.textContent).toBe("No");
      expect(within(panel).queryByText(/cannot be read with the current key/)).toBeNull();
    },
  );

  it("shows grant none, active and inactive metadata without inferring revoked or expired", async () => {
    const none = await renderPanelWith(storedMetadata(1));
    expect(within(none).getByText("No grant")).toBeTruthy();
    expect(within(none).queryByText("Created")).toBeNull();
    cleanup();

    const active = await renderPanelWith(storedMetadata(1, { grant: activeGrant }));
    expect(within(active).getByText("Active")).toBeTruthy();
    expect(within(active).getByText("Created").nextElementSibling?.textContent).toBe("Sep 29, 2026, 8:00 AM UTC");
    expect(within(active).getByText("Last used").nextElementSibling?.textContent).toBe("Sep 30, 2026, 12:00 PM UTC");
    expect(within(active).getByText("Idle expiry").nextElementSibling?.textContent).toBe("Oct 29, 2026, 8:00 AM UTC");
    expect(within(active).queryByText(/can no longer be used/)).toBeNull();
    cleanup();

    const inactive = await renderPanelWith(clearedMetadata(2, { grant: inactiveGrant }));
    expect(within(inactive).getByText("Inactive")).toBeTruthy();
    expect(within(inactive).getByText(/can no longer be used/)).toBeTruthy();
    expect(inactive.textContent).not.toMatch(/revoked|expired/i);
    expect(within(inactive).getByRole("button", { name: "Disconnect" })).toBeTruthy();
  });

  it.each([
    ["503 custody-unavailable", 503, { code: "custody-unavailable" }],
    ["403 host envelope", 403, hostForbidden],
    ["missing field", 200, { revision: 1, storedAt: null, browserExpiresAt: null, custodyAvailable: true }],
    ["unknown top-level field", 200, { ...absentMetadata(), session: hostileMarker }],
    ["nested unknown grant field", 200, storedMetadata(1, { grant: { ...activeGrant, revokedAt: null } as never })],
    ["mixed malformed grant", 200, storedMetadata(1, { grant: { ...activeGrant, active: "yes" } as never })],
    ["date-only instant", 200, storedMetadata(1, { storedAt: "2026-09-30" })],
    ["offset instant", 200, storedMetadata(1, { browserExpiresAt: "2026-12-30T12:00:00+00:00" })],
    ["unsafe revision", 200, storedMetadata(2 ** 53)],
    ["negative revision", 200, clearedMetadata(-1)],
    ["string revision", 200, { ...absentMetadata(), revision: "0" }],
    ["stored instants at revision 0", 200, storedMetadata(0)],
    ["expiry without stored session", 200, clearedMetadata(2, { browserExpiresAt })],
    ["array body", 200, [absentMetadata()]],
  ])("treats %s as unavailable, never empty", async (_label, status, body) => {
    const panel = await renderPanelWith(body, status);

    expect(within(panel).getByText("Operator session unavailable")).toBeTruthy();
    expect(within(panel).queryByText("No stored session")).toBeNull();
    expect(within(panel).queryByText("Revision")).toBeNull();
    expect(panel.textContent).not.toContain(hostileMarker);
  });

  it("treats a non-JSON body and a network failure as unavailable", async () => {
    http.replyText("GET", metadataPath, 200, `<html>${hostileMarker}</html>`);
    render(<OperatorSessionPanel />);
    expect(await screen.findByText("Operator session unavailable")).toBeTruthy();
    cleanup();

    http.networkFailure("GET", metadataPath);
    render(<OperatorSessionPanel />);
    expect(await screen.findByText("Operator session unavailable")).toBeTruthy();
    expect(document.body.textContent).not.toContain(hostileMarker);
  });
});

describe("AC2 gating through the provider-detail route", () => {
  it("shows the section to a platform-admin actor on TCGplayer", async () => {
    http.reply("GET", metadataPath, 200, absentMetadata());
    renderProviderRoute();

    const panel = await findPanel();
    expect(within(panel).getByRole("heading", { name: "Operator session" })).toBeTruthy();
    expect((await findProviderPage()).contains(panel)).toBe(true);
    await waitFor(() => expect(http.requests).toEqual([`GET ${metadataPath}`]));
  });

  it.each([
    ["a non-platform-admin actor", () => mocks.resolveActor.mockResolvedValue(actor("catalog-admin"))],
    ["an anonymous request", () => mocks.resolveActor.mockResolvedValue(null)],
    ["a failed actor resolution", () => mocks.resolveActor.mockRejectedValue(new Error(hostileMarker))],
  ])("hides the section from %s on TCGplayer", async (_label, arrange) => {
    arrange();
    renderProviderRoute();

    const page = await findProviderPage();
    expect(page.textContent).toContain("tcgplayer");
    expect(page.querySelector("[data-catalog-operator-session-panel]")).toBeNull();
    expect(page.textContent).not.toContain("Operator session");
    expect(mocks.resolveActor).toHaveBeenCalledTimes(1);
    expect(http.requests).toEqual([]);
  });

  it("hides the section from a platform-admin actor on another provider", async () => {
    renderProviderRoute("/catalog/providers/tcgdex");

    const page = await findProviderPage();
    expect(page.textContent).toContain("tcgdex");
    expect(page.querySelector("[data-catalog-operator-session-panel]")).toBeNull();
    expect(page.textContent).not.toContain("Operator session");
    expect(mocks.resolveActor).not.toHaveBeenCalled();
    expect(http.requests).toEqual([]);
  });
});

describe("AC3 pair and Disconnect through the mounted provider-detail route", () => {
  it("mints, refreshes metadata without re-reading the secret, then Disconnect drops the grant", async () => {
    http.reply("GET", metadataPath, 200, absentMetadata());
    const router = renderProviderRoute();
    const panel = await findPanel();
    const mint = http.defer("POST", grantPath);

    fireEvent.click(await within(panel).findByRole("button", { name: "Pair extension" }));
    const busyPair = within(panel).getByRole("button", { name: "Pairing the operator extension" });
    expect(busyPair.getAttribute("aria-busy")).toBe("true");
    expect((busyPair as HTMLButtonElement).disabled).toBe(true);
    expect(
      within(panel)
        .getAllByRole("status")
        .some((region) => region.textContent === "Pairing…"),
    ).toBe(true);

    http.reply("GET", metadataPath, 200, absentMetadata({ grant: activeGrant }));
    await act(async () => mint.reply(200, { grant: syntheticGrant, idleExpiresAt: activeGrant.idleExpiresAt }));
    const grantRegion = await findGrantRegion(panel);
    expect(within(grantRegion).getByText(syntheticGrant)).toBeTruthy();
    expect(within(grantRegion).getByText("Idle expiry Oct 29, 2026, 8:00 AM UTC")).toBeTruthy();
    await waitFor(() => expect(within(panel).getByText("Active")).toBeTruthy());
    fireEvent.click(within(grantRegion).getByRole("button", { name: "Copy" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(syntheticGrant));
    expect(JSON.stringify(router.state.loaderData)).not.toContain(syntheticGrant);
    expect(router.state.location.search + router.state.location.hash).not.toContain(syntheticGrant);

    http.reply("DELETE", metadataPath, 200, { outcome: "unchanged", revision: 0 });
    http.reply("GET", metadataPath, 200, absentMetadata({ grant: inactiveGrant }));
    await confirmDisconnect(panel);

    expect(panel.querySelector("[data-operator-session-grant]")).toBeNull();
    expect(document.body.innerHTML).not.toContain(syntheticGrant);
    await waitFor(() => expect(within(panel).getByText("Inactive")).toBeTruthy());
    expect(within(panel).getByText(/revision 0 is unchanged/)).toBeTruthy();
    expect(http.requests).toEqual([
      `GET ${metadataPath}`,
      `POST ${grantPath}`,
      `GET ${metadataPath}`,
      `DELETE ${metadataPath}`,
      `GET ${metadataPath}`,
    ]);
  });

  it.each([
    ["cleared", storedMetadata(1), "Stored session cleared. The record is now revision 2."],
    ["unchanged", clearedMetadata(2, { grant: activeGrant }), /revision 2 is unchanged/],
  ] as const)("reports a %s Disconnect with the returned revision", async (outcome, before, message) => {
    http.reply("GET", metadataPath, 200, before);
    renderProviderRoute();
    const panel = await findPanel();
    await within(panel).findByRole("button", { name: "Disconnect" });

    http.reply("DELETE", metadataPath, 200, { outcome, revision: 2 });
    http.reply("GET", metadataPath, 200, clearedMetadata(2, { grant: inactiveGrant }));
    await confirmDisconnect(panel);

    expect(await within(panel).findByText(message)).toBeTruthy();
    await waitFor(() => expect(within(panel).getByText("Stored session cleared")).toBeTruthy());
    expect(within(panel).getByText("Revision").nextElementSibling?.textContent).toBe("2");
  });

  it("shows a 409 conflict with the newer stored session and requires a fresh confirmation", async () => {
    http.reply("GET", metadataPath, 200, storedMetadata(3));
    renderProviderRoute();
    const panel = await findPanel();
    await within(panel).findByRole("button", { name: "Disconnect" });

    http.reply("DELETE", metadataPath, 409, { outcome: "stale-revision", revision: 4 });
    http.reply("GET", metadataPath, 200, storedMetadata(4, { storedAt: "2026-10-01T09:30:00.000Z" }));
    await confirmDisconnect(panel);

    expect(await within(panel).findByText(/it is now revision 4\. Review the refreshed status/)).toBeTruthy();
    await waitFor(() =>
      expect(within(panel).getByText("Stored at").nextElementSibling?.textContent).toBe("Oct 1, 2026, 9:30 AM UTC"),
    );
    expect(within(panel).queryByText(/Stored session cleared/)).toBeNull();
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(http.requests.filter((request) => request.startsWith("DELETE"))).toHaveLength(1);

    http.reply("DELETE", metadataPath, 200, { outcome: "cleared", revision: 5 });
    http.reply("GET", metadataPath, 200, clearedMetadata(5));
    await confirmDisconnect(panel);
    expect(await within(panel).findByText("Stored session cleared. The record is now revision 5.")).toBeTruthy();
    expect(http.requests.filter((request) => request.startsWith("DELETE"))).toHaveLength(2);
  });

  it.each([
    [
      "a 503 after revocation",
      (h: ControlledHttp) => h.reply("DELETE", metadataPath, 503, { code: "custody-unavailable" }),
    ],
    ["a network failure", (h: ControlledHttp) => h.networkFailure("DELETE", metadataPath)],
    ["a malformed success", (h: ControlledHttp) => h.reply("DELETE", metadataPath, 200, { outcome: "cleared" })],
  ])("never claims completion after %s and keeps an unavailable refresh", async (_label, arrange) => {
    http.reply("GET", metadataPath, 200, storedMetadata(1, { grant: activeGrant }));
    renderProviderRoute();
    const panel = await findPanel();
    await within(panel).findByRole("button", { name: "Disconnect" });

    arrange(http);
    http.reply("GET", metadataPath, 503, { code: "custody-unavailable" });
    await confirmDisconnect(panel);

    expect(await within(panel).findByText(/Disconnect did not finish/)).toBeTruthy();
    expect(await within(panel).findByText("Operator session unavailable")).toBeTruthy();
    expect(panel.textContent).not.toMatch(
      /Stored session cleared|is unchanged|environment session if one is configured/,
    );
    expect(panel.textContent).not.toContain(hostileMarker);
    expect(http.requests.filter((request) => request.startsWith("DELETE"))).toHaveLength(1);
  });

  it("names the revision limit when Disconnect stops after revocation", async () => {
    http.reply("GET", metadataPath, 200, storedMetadata(1));
    renderProviderRoute();
    const panel = await findPanel();
    await within(panel).findByRole("button", { name: "Disconnect" });

    http.reply("DELETE", metadataPath, 503, { code: "revision-exhausted" });
    http.reply("GET", metadataPath, 200, storedMetadata(1, { grant: inactiveGrant }));
    await confirmDisconnect(panel);

    expect(await within(panel).findByText(/Disconnect did not finish/)).toBeTruthy();
    expect(within(panel).getByText(/reached its revision limit/)).toBeTruthy();
    await waitFor(() => expect(within(panel).getByText("Inactive")).toBeTruthy());
  });

  it("keeps break-glass Disconnect available after key loss", async () => {
    http.reply("GET", metadataPath, 200, storedMetadata(1, { custodyAvailable: false }));
    renderProviderRoute();
    const panel = await findPanel();

    expect(await within(panel).findByText(/cannot be read with the current key/)).toBeTruthy();
    http.reply("DELETE", metadataPath, 200, { outcome: "cleared", revision: 2 });
    http.reply("GET", metadataPath, 200, clearedMetadata(2, { custodyAvailable: false }));
    await confirmDisconnect(panel);

    expect(await within(panel).findByText("Stored session cleared. The record is now revision 2.")).toBeTruthy();
  });

  describe.each([
    ["Pair", "POST", grantPath],
    ["Disconnect", "DELETE", metadataPath],
  ] as const)("%s refusal envelopes", (action, method, path) => {
    async function attempt(status: number, body: unknown) {
      http.reply("GET", metadataPath, 200, storedMetadata(1));
      renderProviderRoute();
      const panel = await findPanel();
      await within(panel).findByRole("button", { name: "Disconnect" });
      http.reply(method, path, status, body);
      http.reply("GET", metadataPath, 200, storedMetadata(1));
      if (action === "Pair") fireEvent.click(within(panel).getByRole("button", { name: "Pair extension" }));
      else await confirmDisconnect(panel);
      await within(panel).findByRole("alert");
      await waitFor(() => expect(http.requests).toHaveLength(3));
      return panel;
    }

    it("offers sign-in with the literal same-origin return for the flat 400 step_up_required", async () => {
      const panel = await attempt(400, stepUpRequired);

      expect(within(panel).getByRole("alert").textContent).toBe("This action needs a recent sign-in.");
      const link = within(panel).getByRole("link", { name: "Sign in again" });
      expect(link.getAttribute("href")).toBe(signInHref);
      expect(new URL(link.getAttribute("href")!, "https://admin.example").origin).toBe("https://admin.example");
      expect(panel.textContent).not.toMatch(/did not finish/);
    });

    it("does not treat the payout-style nested step_up_required envelope as step-up", async () => {
      const panel = await attempt(400, payoutNestedStepUp);

      expect(within(panel).queryByText("This action needs a recent sign-in.")).toBeNull();
      expect(within(panel).queryByRole("link", { name: "Sign in again" })).toBeNull();
      expect(panel.textContent).not.toContain(hostileMarker);
    });

    it.each([
      ["host authorization_forbidden", hostForbidden],
      ["flat forbidden", flatForbidden],
    ])("shows the %s 403 as an error with no sign-in link", async (_label, body) => {
      const panel = await attempt(403, body);

      expect(within(panel).getByRole("alert").textContent).toBe(
        "This action is not permitted for your current access.",
      );
      expect(within(panel).queryByRole("link")).toBeNull();
      expect(panel.textContent).not.toContain(hostileMarker);
    });
  });

  it("discards a late mint after a reused-route navigation", async () => {
    http.reply("GET", metadataPath, 200, absentMetadata());
    const router = renderProviderRoute();
    const panel = await findPanel();
    const mint = http.defer("POST", grantPath);
    fireEvent.click(await within(panel).findByRole("button", { name: "Pair extension" }));

    http.reply("GET", metadataPath, 200, absentMetadata());
    await act(() => router.navigate("/catalog/providers/tcgplayer?profileVersion=2026.06.04"));
    const remounted = await findPanel();
    await within(remounted).findByRole("button", { name: "Pair extension" });
    await act(async () => mint.reply(200, { grant: syntheticGrant, idleExpiresAt: activeGrant.idleExpiresAt }));

    await waitFor(() =>
      expect(http.requests).toEqual([`GET ${metadataPath}`, `POST ${grantPath}`, `GET ${metadataPath}`]),
    );
    expect(document.body.innerHTML).not.toContain(syntheticGrant);
    expect(within(await findPanel()).queryByRole("button", { name: "Copy" })).toBeNull();
  });

  it("discards a late mint after the loader revalidates to a different actor", async () => {
    http.reply("GET", metadataPath, 200, absentMetadata());
    const router = renderProviderRoute();
    const panel = await findPanel();
    const mint = http.defer("POST", grantPath);
    fireEvent.click(await within(panel).findByRole("button", { name: "Pair extension" }));

    mocks.resolveActor.mockResolvedValue(actor("platform-admin", "user-synthetic-2"));
    http.reply("GET", metadataPath, 200, absentMetadata());
    await act(() => router.revalidate());
    expect(mocks.resolveActor).toHaveBeenCalledTimes(2);
    expect(router.state.loaderData["0"]?.operatorSessionActorKey).toBe("user-synthetic-2:membership-user-synthetic-2");
    await waitFor(() => expect(http.requests).toHaveLength(3));
    await act(async () => mint.reply(200, { grant: syntheticGrant, idleExpiresAt: activeGrant.idleExpiresAt }));

    await within(await findPanel()).findByRole("button", { name: "Pair extension" });
    expect(document.body.innerHTML).not.toContain(syntheticGrant);
    expect(within(await findPanel()).queryByRole("button", { name: "Copy" })).toBeNull();
  });

  it("blocks Disconnect while a mint is in flight", async () => {
    http.reply("GET", metadataPath, 200, storedMetadata(1));
    renderProviderRoute();
    const panel = await findPanel();
    await within(panel).findByRole("button", { name: "Disconnect" });
    const mint = http.defer("POST", grantPath);

    fireEvent.click(within(panel).getByRole("button", { name: "Pair extension" }));
    const disconnect = within(panel).getByRole("button", { name: "Disconnect" }) as HTMLButtonElement;
    expect(disconnect.disabled).toBe(true);
    fireEvent.click(disconnect);
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();

    http.reply("GET", metadataPath, 200, storedMetadata(1, { grant: activeGrant }));
    await act(async () => mint.reply(200, { grant: syntheticGrant, idleExpiresAt: activeGrant.idleExpiresAt }));
    await waitFor(() => expect(within(panel).getByText("Active")).toBeTruthy());
    expect(http.requests).toEqual([`GET ${metadataPath}`, `POST ${grantPath}`, `GET ${metadataPath}`]);
  });

  it("discards a metadata read that completes after a newer Disconnect", async () => {
    http.reply("GET", metadataPath, 200, storedMetadata(1));
    renderProviderRoute();
    const panel = await findPanel();
    await within(panel).findByRole("button", { name: "Disconnect" });

    http.reply("POST", grantPath, 200, { grant: syntheticGrant, idleExpiresAt: activeGrant.idleExpiresAt });
    const staleRead = http.defer("GET", metadataPath);
    fireEvent.click(within(panel).getByRole("button", { name: "Pair extension" }));
    await waitFor(() => expect(http.requests).toHaveLength(3));

    http.reply("DELETE", metadataPath, 200, { outcome: "cleared", revision: 2 });
    http.reply("GET", metadataPath, 200, clearedMetadata(2, { grant: inactiveGrant }));
    await confirmDisconnect(panel);
    await waitFor(() => expect(within(panel).getByText("Inactive")).toBeTruthy());

    await act(async () => staleRead.reply(200, storedMetadata(1, { grant: activeGrant })));
    expect(within(panel).getByText("Stored session cleared")).toBeTruthy();
    expect(within(panel).queryByText("Active")).toBeNull();
    expect(document.body.innerHTML).not.toContain(syntheticGrant);
  });

  it("dismissal drops the grant and its copy action, and later refreshes never restore it", async () => {
    http.reply("GET", metadataPath, 200, absentMetadata());
    renderProviderRoute();
    const panel = await findPanel();
    http.reply("POST", grantPath, 200, { grant: syntheticGrant, idleExpiresAt: activeGrant.idleExpiresAt });
    const postMintRead = http.defer("GET", metadataPath);
    fireEvent.click(await within(panel).findByRole("button", { name: "Pair extension" }));
    const grantRegion = await findGrantRegion(panel);

    fireEvent.click(within(grantRegion).getByRole("button", { name: "Dismiss grant" }));
    expect(panel.querySelector("[data-operator-session-grant]")).toBeNull();
    expect(document.activeElement).toBe(within(panel).getByRole("button", { name: "Pair extension" }));
    await act(async () => postMintRead.reply(200, absentMetadata({ grant: activeGrant })));

    await waitFor(() => expect(within(panel).getByText("Active")).toBeTruthy());
    expect(document.body.innerHTML).not.toContain(syntheticGrant);
    expect(within(await findPanel()).queryByRole("button", { name: "Copy" })).toBeNull();
  });

  it("keeps hostile response and exception text out of every sink except the active grant display", async () => {
    const consoleCalls = [vi.spyOn(console, "error"), vi.spyOn(console, "warn"), vi.spyOn(console, "log")];
    http.reply("GET", metadataPath, 200, absentMetadata());
    const router = renderProviderRoute();
    const panel = await findPanel();

    http.reply("POST", grantPath, 200, {
      grant: `${hostileMarker} is not a grant`,
      idleExpiresAt: activeGrant.idleExpiresAt,
    });
    http.reply("GET", metadataPath, 200, absentMetadata());
    fireEvent.click(await within(panel).findByRole("button", { name: "Pair extension" }));
    await waitFor(() => expect(http.requests).toHaveLength(3));
    expect((await within(panel).findByRole("alert")).textContent).toMatch(/could not be completed/);

    http.networkFailure("POST", grantPath);
    http.reply("GET", metadataPath, 200, absentMetadata());
    fireEvent.click(within(panel).getByRole("button", { name: "Pair extension" }));
    await waitFor(() => expect(http.requests).toHaveLength(5));
    expect((await within(panel).findByRole("alert")).textContent).toMatch(/could not be completed/);

    http.reply("POST", grantPath, 200, { grant: syntheticGrant, idleExpiresAt: activeGrant.idleExpiresAt });
    http.reply("GET", metadataPath, 200, absentMetadata({ grant: activeGrant }));
    fireEvent.click(within(panel).getByRole("button", { name: "Pair extension" }));
    const grantRegion = await findGrantRegion(panel);

    const html = document.body.innerHTML;
    expect(html).not.toContain(hostileMarker);
    expect(html.split(syntheticGrant)).toHaveLength(2);
    expect(grantRegion.innerHTML).toContain(syntheticGrant);
    const sinks = [
      JSON.stringify(router.state),
      JSON.stringify({ ...localStorage }),
      JSON.stringify({ ...sessionStorage }),
      document.cookie,
      window.location.href,
      JSON.stringify(consoleCalls.map((spy) => spy.mock.calls)),
    ];
    for (const sink of sinks) {
      expect(sink).not.toContain(syntheticGrant);
      expect(sink).not.toContain(hostileMarker);
    }
  });
});

// Disconnect eligibility is what the panel knows remains to revoke or clear,
// not whether the latest metadata read succeeded.
describe("AC3 break-glass eligibility through the mounted provider-detail route", () => {
  // The post-mint read is scripted only after the initial read has consumed
  // its reply, so both GETs stay in order.
  async function pairFromAbsent<T>(arrangeRefresh: () => T) {
    http.reply("GET", metadataPath, 200, absentMetadata());
    const router = renderProviderRoute();
    const panel = await findPanel();
    await within(panel).findByRole("button", { name: "Pair extension" });
    expect(within(panel).queryByRole("button", { name: "Disconnect" })).toBeNull();

    http.reply("POST", grantPath, 200, { grant: syntheticGrant, idleExpiresAt: activeGrant.idleExpiresAt });
    const refresh = arrangeRefresh();
    fireEvent.click(within(panel).getByRole("button", { name: "Pair extension" }));
    const grantRegion = await findGrantRegion(panel);
    await waitFor(() =>
      expect(http.requests).toEqual([`GET ${metadataPath}`, `POST ${grantPath}`, `GET ${metadataPath}`]),
    );
    return { router, panel, grantRegion, refresh };
  }

  function expectNoRevisionFact(panel: HTMLElement) {
    expect(within(panel).getByText("Operator session unavailable")).toBeTruthy();
    expect(within(panel).queryByText("Revision")).toBeNull();
  }

  it.each(["validated", "pending", "unavailable"] as const)(
    "keeps Disconnect for a minted grant whose metadata refresh is %s, including after dismissal",
    async (refresh) => {
      const { router, panel, grantRegion } = await pairFromAbsent(() => {
        if (refresh === "validated") http.reply("GET", metadataPath, 200, absentMetadata({ grant: activeGrant }));
        if (refresh === "pending") http.defer("GET", metadataPath);
        if (refresh === "unavailable") http.reply("GET", metadataPath, 503, { code: "custody-unavailable" });
      });
      if (refresh === "validated") await waitFor(() => expect(within(panel).getByText("Active")).toBeTruthy());
      if (refresh === "pending") expect(within(panel).getByText("No stored session")).toBeTruthy();
      if (refresh === "unavailable") {
        await within(panel).findByText("Operator session unavailable");
        expectNoRevisionFact(panel);
      }
      expect(within(panel).getByRole("button", { name: "Disconnect" })).toBeTruthy();

      fireEvent.click(within(grantRegion).getByRole("button", { name: "Dismiss grant" }));
      expect(panel.querySelector("[data-operator-session-grant]")).toBeNull();
      expect(document.body.innerHTML).not.toContain(syntheticGrant);
      expect(JSON.stringify(router.state)).not.toContain(syntheticGrant);
      expect(within(panel).getByRole("button", { name: "Disconnect" })).toBeTruthy();
      if (refresh === "unavailable") expectNoRevisionFact(panel);
    },
  );

  it.each([
    ["pending", "succeeds", 200, { outcome: "unchanged", revision: 0 }],
    ["unavailable", "stops after revocation", 503, { code: "custody-unavailable" }],
  ] as const)(
    "a confirmed Disconnect while the post-mint refresh is %s drops the grant once and %s",
    async (refresh, _result, status, body) => {
      const { panel, refresh: postMintRead } = await pairFromAbsent(() => {
        if (refresh === "pending") return http.defer("GET", metadataPath);
        http.reply("GET", metadataPath, 503, { code: "custody-unavailable" });
        return null;
      });
      const deleted = http.defer("DELETE", metadataPath);

      await confirmDisconnect(panel);
      expect(panel.querySelector("[data-operator-session-grant]")).toBeNull();
      expect(within(panel).queryByRole("button", { name: "Copy" })).toBeNull();
      expect(document.body.innerHTML).not.toContain(syntheticGrant);

      http.reply("GET", metadataPath, 503, { code: "custody-unavailable" });
      await act(async () => deleted.reply(status, body));
      await within(panel).findByText("Operator session unavailable");
      expect(http.requests).toEqual([
        `GET ${metadataPath}`,
        `POST ${grantPath}`,
        `GET ${metadataPath}`,
        `DELETE ${metadataPath}`,
        `GET ${metadataPath}`,
      ]);
      expectNoRevisionFact(panel);
      if (status === 200) {
        // A confirmed revoke-all and clear leaves nothing known to Disconnect.
        expect(within(panel).getByText(/revision 0 is unchanged/)).toBeTruthy();
        expect(within(panel).queryByRole("button", { name: "Disconnect" })).toBeNull();
      } else {
        // An incomplete Disconnect is not completion, so break-glass remains.
        expect(within(panel).getByText(/Disconnect did not finish/)).toBeTruthy();
        expect(within(panel).getByRole("button", { name: "Disconnect" })).toBeTruthy();
      }

      if (postMintRead) {
        await act(async () => postMintRead.reply(200, absentMetadata({ grant: activeGrant })));
        expect(within(panel).queryByText("Active")).toBeNull();
        expectNoRevisionFact(panel);
      }
    },
  );

  it("retains last-known stored custody after a refused Pair and a failed refresh", async () => {
    http.reply("GET", metadataPath, 200, storedMetadata(1, { custodyAvailable: false }));
    renderProviderRoute();
    const panel = await findPanel();
    await within(panel).findByRole("button", { name: "Disconnect" });

    http.reply("POST", grantPath, 403, flatForbidden);
    http.reply("GET", metadataPath, 503, { code: "custody-unavailable" });
    fireEvent.click(within(panel).getByRole("button", { name: "Pair extension" }));
    await within(panel).findByText("Operator session unavailable");
    expect(within(panel).getByRole("alert").textContent).toBe("This action is not permitted for your current access.");
    expectNoRevisionFact(panel);
    expect(within(panel).getByRole("button", { name: "Disconnect" })).toBeTruthy();

    http.reply("DELETE", metadataPath, 200, { outcome: "cleared", revision: 2 });
    http.reply("GET", metadataPath, 200, clearedMetadata(2, { custodyAvailable: false }));
    await confirmDisconnect(panel);
    expect(await within(panel).findByText("Stored session cleared. The record is now revision 2.")).toBeTruthy();
    expect(http.requests.filter((request) => request.startsWith("DELETE"))).toHaveLength(1);
  });

  it.each([
    [
      "cleared",
      200,
      { outcome: "cleared", revision: 2 },
      "Stored session cleared. The record is now revision 2.",
      false,
    ],
    ["stale-revision", 409, { outcome: "stale-revision", revision: 2 }, /it is now revision 2\./, true],
  ] as const)(
    "reconciles Disconnect from a confirmed %s outcome when the next refresh fails",
    async (_outcome, status, body, message, retained) => {
      http.reply("GET", metadataPath, 200, storedMetadata(1));
      renderProviderRoute();
      const panel = await findPanel();
      await within(panel).findByRole("button", { name: "Disconnect" });

      http.reply("DELETE", metadataPath, status, body);
      http.reply("GET", metadataPath, 503, { code: "custody-unavailable" });
      await confirmDisconnect(panel);

      expect(await within(panel).findByText(message)).toBeTruthy();
      await within(panel).findByText("Operator session unavailable");
      expect(within(panel).queryByRole("button", { name: "Disconnect" }) !== null).toBe(retained);
      expect(http.requests.filter((request) => request.startsWith("DELETE"))).toHaveLength(1);
    },
  );
});

describe("AC5 accessibility", () => {
  it("names every control, moves focus into the Disconnect dialog and back, and announces the grant", async () => {
    http.reply("GET", metadataPath, 200, storedMetadata(1, { grant: activeGrant }));
    renderProviderRoute();
    const panel = await findPanel();
    const disconnect = await within(panel).findByRole("button", { name: "Disconnect" });
    expect(within(panel).getByRole("button", { name: "Pair extension" })).toBeTruthy();

    disconnect.focus();
    fireEvent.click(disconnect);
    const dialog = await findDialog();
    expect(accessibleTitle(dialog)).toBe("Disconnect the stored session?");
    expect(within(dialog).getByText(/does not sign you out of TCGplayer/)).toBeTruthy();
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitForDialogClosed();
    await waitFor(() => expect(document.activeElement).toBe(disconnect));
    expect(http.requests).toEqual([`GET ${metadataPath}`]);

    http.reply("POST", grantPath, 200, { grant: syntheticGrant, idleExpiresAt: activeGrant.idleExpiresAt });
    http.reply("GET", metadataPath, 200, storedMetadata(1, { grant: activeGrant }));
    fireEvent.click(within(panel).getByRole("button", { name: "Pair extension" }));
    await waitFor(() =>
      expect(
        within(panel)
          .getAllByRole("status")
          .some((region) => region.textContent === "A new extension grant is ready to copy. It is shown once."),
      ).toBe(true),
    );
    const grantRegion = panel.querySelector<HTMLElement>("[data-operator-session-grant]")!;
    expect(within(grantRegion).getByRole("heading", { name: "New extension grant" })).toBeTruthy();
    expect(within(grantRegion).getByRole("button", { name: "Copy" })).toBeTruthy();
    expect(within(grantRegion).getByRole("button", { name: "Dismiss grant" })).toBeTruthy();
  });
});
