// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CatalogProviderDetailRoute, { loader } from "../../../../routes/admin/catalog-provider-detail";
import { buildCatalogPrimaryWorkbenchReadModelForSurface } from "../../../source-observations/ui/primary-workbench-read-model";
import { operatorExtensionId } from "../../domain/extension/protocol";
import type { OperatorExtensionHandoffResult } from "../../ui/admin-panel/operator-extension-handoff";
import { OperatorSessionPanel } from "../../ui/admin-panel/operator-session-panel";
import {
  deferred,
  flushUntil,
  receivingEndDoesNotExist,
  stubSendMessage,
  watchDomForSecret,
  type Deferred,
} from "./controlled-extension";
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
  syntheticGrantB,
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
const initialDocumentStyles = {
  html: document.documentElement.style.cssText,
  body: document.body.style.cssText,
};
let http: ControlledHttp;
let writeText: ReturnType<typeof vi.fn>;

beforeEach(() => {
  // JSDOM has no layout: clientWidth=0 invents a viewport-wide inset scrollbar.
  // Model this fixture's scrollbar-free viewport, keeping the real dialog lifecycle.
  vi.spyOn(document.documentElement, "clientWidth", "get").mockImplementation(() => window.innerWidth);
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

afterEach(async () => {
  // A failed fake-timer window must not leave the next test on fake time.
  vi.useRealTimers();
  try {
    await cleanupRenderedUi();
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  }
});

async function cleanupRenderedUi() {
  cleanup();
  // Base UI restores scroll locking on a timer after React has unmounted.
  // Let that owned cleanup finish instead of carrying it into the next test.
  await waitFor(expectDocumentStylesRestored);
}

function expectDocumentStylesRestored() {
  expect(document.documentElement.style.cssText).toBe(initialDocumentStyles.html);
  expect(document.body.style.cssText).toBe(initialDocumentStyles.body);
}

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

async function renderProviderRoute(path = "/catalog/providers/tcgplayer") {
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
  // Flush the initial loader, metadata read and dialog subscriptions before
  // exposing the route fixture to interactions, not merely its visible DOM.
  await act(async () => {
    render(<RouterProvider router={router} />);
  });
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

async function waitForSettledDisconnect(panel: HTMLElement) {
  await waitFor(() => {
    const disconnect = within(panel).getByRole("button", { name: "Disconnect" });
    expect(disconnect).toHaveAttribute("aria-haspopup", "dialog");
    expect(disconnect).toHaveAttribute("aria-expanded", "false");
  });
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
      await waitForSettledDisconnect(panel);
      const capture = normalizedMarkup(panel);
      expect(capture).toContain('aria-haspopup="dialog"');
      expect(capture).toContain('aria-expanded="false"');
      markup.push(capture);
      cleanup();
    }
    expect(markup[0]).toBe(markup[1]);
  });

  it("captures unreadable stored custody before the Disconnect trigger settles", async () => {
    const unreadable = storedMetadata(3, { custodyAvailable: false, grant: activeGrant });
    http.reply("GET", metadataPath, 200, unreadable);
    render(<OperatorSessionPanel />);
    const panel = await findPanel();
    let early = "";

    await waitFor(() => {
      expect(within(panel).queryByText("Loading operator session…")).toBeNull();
      expect(within(panel).queryByRole("button", { name: "Disconnect" })).toBeTruthy();
      early = normalizedMarkup(panel);
    });

    expect(early).not.toContain('aria-haspopup="dialog"');
    await waitForSettledDisconnect(panel);
    const settled = normalizedMarkup(panel);
    expect(settled).toContain('aria-haspopup="dialog"');
    expect(settled).toContain('aria-expanded="false"');
    expect(early).not.toBe(settled);
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
  it("settles the initial loader and metadata before route interactions", async () => {
    http.reply("GET", metadataPath, 200, storedMetadata(1));
    const router = await renderProviderRoute();

    expect(router.state.initialized).toBe(true);
    const panel = document.querySelector<HTMLElement>("[data-catalog-operator-session-panel]");
    if (!panel) throw new Error("the initial provider route has not committed its panel");
    expect(within(panel).queryByText("Loading operator session…")).toBeNull();
    const disconnect = within(panel).getByRole("button", { name: "Disconnect" });
    disconnect.focus();
    fireEvent.click(disconnect);
    const dialog = await findDialog();
    expect(accessibleTitle(dialog)).toBe("Disconnect the stored session?");
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitForDialogClosed();
    await waitFor(() => expect(document.activeElement).toBe(disconnect));
    expect(http.requests).toEqual([`GET ${metadataPath}`]);
  });

  it("shows the section to a platform-admin actor on TCGplayer", async () => {
    http.reply("GET", metadataPath, 200, absentMetadata());
    await renderProviderRoute();

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
    await renderProviderRoute();

    const page = await findProviderPage();
    expect(page.textContent).toContain("tcgplayer");
    expect(page.querySelector("[data-catalog-operator-session-panel]")).toBeNull();
    expect(page.textContent).not.toContain("Operator session");
    expect(mocks.resolveActor).toHaveBeenCalledTimes(1);
    expect(http.requests).toEqual([]);
  });

  it("hides the section from a platform-admin actor on another provider", async () => {
    await renderProviderRoute("/catalog/providers/tcgdex");

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
    const router = await renderProviderRoute();
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
    await renderProviderRoute();
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
    await renderProviderRoute();
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
    await renderProviderRoute();
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
    await renderProviderRoute();
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
    await renderProviderRoute();
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
      await renderProviderRoute();
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
    const router = await renderProviderRoute();
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
    const router = await renderProviderRoute();
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
    await renderProviderRoute();
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
    await renderProviderRoute();
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
    await renderProviderRoute();
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
    const router = await renderProviderRoute();
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
    const router = await renderProviderRoute();
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
    await renderProviderRoute();
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
      await renderProviderRoute();
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
  it("releases an open dialog's scroll lock and focus before mounting the next provider route", async () => {
    http.reply("GET", metadataPath, 200, storedMetadata(1));
    await renderProviderRoute();
    const panel = await findPanel();
    const disconnect = await within(panel).findByRole("button", { name: "Disconnect" });
    disconnect.focus();
    fireEvent.click(disconnect);
    const dialog = await findDialog();
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    await waitFor(() => expect(document.body.style.cssText).not.toBe(initialDocumentStyles.body));

    await cleanupRenderedUi();
    expectDocumentStylesRestored();
    expect(document.querySelector("[data-base-ui-portal]")).toBeNull();
    expect(document.activeElement).toBe(document.body);

    http.reply("GET", metadataPath, 200, storedMetadata(1));
    await renderProviderRoute();
    const nextPanel = await findPanel();
    const nextDisconnect = await within(nextPanel).findByRole("button", { name: "Disconnect" });
    nextDisconnect.focus();
    fireEvent.click(nextDisconnect);
    const nextDialog = await findDialog();
    expect(accessibleTitle(nextDialog)).toBe("Disconnect the stored session?");
    await waitFor(() => expect(nextDialog.contains(document.activeElement)).toBe(true));
    fireEvent.click(within(nextDialog).getByRole("button", { name: "Cancel" }));
    await waitForDialogClosed();
    await waitFor(() => expect(document.activeElement).toBe(nextDisconnect));
    expect(http.requests).toEqual([`GET ${metadataPath}`, `GET ${metadataPath}`]);
  });

  it("names every control, moves focus into the Disconnect dialog and back, and announces the grant", async () => {
    http.reply("GET", metadataPath, 200, storedMetadata(1, { grant: activeGrant }));
    await renderProviderRoute();
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

const pairedAnnouncement = "Paired with extension.";
const notConfirmedNotice = "Automatic pairing was not confirmed. You can paste this grant into the extension.";
const handoffMessage = (grant: string) => [operatorExtensionId, { action: "pair-handoff", grant }];
const mintedBody = (grant: string) => ({ grant, idleExpiresAt: activeGrant.idleExpiresAt });

function spyConsole() {
  return [vi.spyOn(console, "error"), vi.spyOn(console, "warn"), vi.spyOn(console, "log")];
}

// Every sink outside the rendered grant display: loader/router state, storage,
// cookies, the URL and the console.
function expectGrantAbsentFromSinks(
  router: ReturnType<typeof createMemoryRouter>,
  consoleCalls: ReturnType<typeof spyConsole>,
  grant: string,
) {
  const sinks = [
    JSON.stringify(router.state),
    JSON.stringify({ ...localStorage }),
    JSON.stringify({ ...sessionStorage }),
    document.cookie,
    window.location.href,
    JSON.stringify(consoleCalls.map((spy) => spy.mock.calls)),
  ];
  for (const sink of sinks) expect(sink).not.toContain(grant);
}

describe("#9574 AC1 Admin pair handoff after a successful mint", () => {
  it("sends the minted grant once and drops it unrendered on a timely paired reply", async () => {
    const consoleCalls = spyConsole();
    const exposures = watchDomForSecret(syntheticGrant);
    const reply = deferred<unknown>();
    const sendMessage = stubSendMessage(() => reply.promise);
    http.reply("GET", metadataPath, 200, absentMetadata());
    const router = await renderProviderRoute();
    const panel = await findPanel();
    const mint = http.defer("POST", grantPath);

    fireEvent.click(await within(panel).findByRole("button", { name: "Pair extension" }));
    expect(sendMessage).not.toHaveBeenCalled();
    await act(async () => mint.reply(200, mintedBody(syntheticGrant)));
    await flushUntil(() => sendMessage.mock.calls.length > 0, "the handoff send");

    // Awaiting the acknowledgement: still pairing, grant unrendered, no refresh yet.
    expect(sendMessage.mock.calls).toEqual([handoffMessage(syntheticGrant)]);
    expect(within(panel).getByRole("button", { name: "Pairing the operator extension" })).toBeTruthy();
    expect(panel.querySelector("[data-operator-session-grant]")).toBeNull();
    expect(http.requests).toEqual([`GET ${metadataPath}`, `POST ${grantPath}`]);

    http.reply("GET", metadataPath, 200, absentMetadata({ grant: activeGrant }));
    await act(async () => reply.resolve({ outcome: "paired" }));

    const announcement = await within(panel).findByText(pairedAnnouncement);
    expect(announcement.getAttribute("role")).toBe("status");
    await waitFor(() => expect(within(panel).getByText("Active")).toBeTruthy());
    expect(http.requests).toEqual([`GET ${metadataPath}`, `POST ${grantPath}`, `GET ${metadataPath}`]);
    expect(panel.querySelector("[data-operator-session-grant]")).toBeNull();
    expect(within(panel).queryByRole("button", { name: "Copy" })).toBeNull();
    expect(within(panel).getByRole("button", { name: "Disconnect" })).toBeTruthy();
    expect(panel.textContent).not.toContain(notConfirmedNotice);
    expect(writeText).not.toHaveBeenCalled();
    expect(exposures()).toEqual([]);
    expect(document.documentElement.outerHTML).not.toContain(syntheticGrant);
    expectGrantAbsentFromSinks(router, consoleCalls, syntheticGrant);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["a 403 refusal", (h: ControlledHttp) => h.reply("POST", grantPath, 403, flatForbidden)],
    ["a step-up refusal", (h: ControlledHttp) => h.reply("POST", grantPath, 400, stepUpRequired)],
    ["a malformed grant", (h: ControlledHttp) => h.reply("POST", grantPath, 200, mintedBody(`${hostileMarker}!`))],
    ["a network failure", (h: ControlledHttp) => h.networkFailure("POST", grantPath)],
  ])("sends nothing when the mint fails with %s", async (_label, arrange) => {
    const sendMessage = stubSendMessage(async () => ({ outcome: "paired" }));
    http.reply("GET", metadataPath, 200, absentMetadata());
    await renderProviderRoute();
    const panel = await findPanel();

    arrange(http);
    http.reply("GET", metadataPath, 200, absentMetadata());
    fireEvent.click(await within(panel).findByRole("button", { name: "Pair extension" }));
    await within(panel).findByRole("alert");
    await waitFor(() => expect(http.requests).toHaveLength(3));

    expect(sendMessage).not.toHaveBeenCalled();
    expect(panel.textContent).not.toContain(pairedAnnouncement);
    expect(panel.querySelector("[data-operator-session-grant]")).toBeNull();
  });

  it("sends nothing for a mint that completes after a reused-route remount", async () => {
    const sendMessage = stubSendMessage(async () => ({ outcome: "paired" }));
    http.reply("GET", metadataPath, 200, absentMetadata());
    const router = await renderProviderRoute();
    const panel = await findPanel();
    const mint = http.defer("POST", grantPath);
    fireEvent.click(await within(panel).findByRole("button", { name: "Pair extension" }));

    http.reply("GET", metadataPath, 200, absentMetadata());
    await act(() => router.navigate("/catalog/providers/tcgplayer?profileVersion=2026.06.04"));
    await within(await findPanel()).findByRole("button", { name: "Pair extension" });
    await act(async () => mint.reply(200, mintedBody(syntheticGrant)));
    await flushUntil(() => http.requests.length === 3, "the remounted read");

    expect(sendMessage).not.toHaveBeenCalled();
    expect(document.body.innerHTML).not.toContain(syntheticGrant);
    expect((await findPanel()).textContent).not.toContain(pairedAnnouncement);
  });
});

describe("#9574 AC2 not-confirmed fallback to the once-shown grant", () => {
  // Each arrangement returns the sendMessage spy, or null when no runtime exists.
  const runtimeless = (chrome: object | null) => () => {
    if (chrome) vi.stubGlobal("chrome", chrome);
    return null;
  };
  it.each<[string, () => ReturnType<typeof stubSendMessage> | null]>([
    ["no chrome global", runtimeless(null)],
    ["chrome without runtime", runtimeless({})],
    ["a runtime without sendMessage", runtimeless({ runtime: {} })],
    [
      "a receiving-end-does-not-exist rejection",
      () => stubSendMessage(async () => Promise.reject(new Error(receivingEndDoesNotExist))),
    ],
    [
      "a synchronous throw",
      () =>
        stubSendMessage(() => {
          throw new TypeError(hostileMarker);
        }),
    ],
    ["a callback-only runtime", () => stubSendMessage(() => undefined)],
    ["a refused reply", () => stubSendMessage(async () => ({ outcome: "refused" }))],
    ["an undefined reply", () => stubSendMessage(async () => undefined)],
    [
      "a paired reply with an extra field",
      () => stubSendMessage(async () => ({ outcome: "paired", status: hostileMarker })),
    ],
    ["an unknown outcome", () => stubSendMessage(async () => ({ outcome: "Paired" }))],
    ["a bare paired string", () => stubSendMessage(async () => "paired")],
    ["an array reply", () => stubSendMessage(async () => [{ outcome: "paired" }])],
  ])(
    "shows the grant, Dismiss and the not-confirmed notice after %s, with no retry or re-mint",
    async (_label, arrange) => {
      const consoleCalls = spyConsole();
      const sendMessage = arrange();
      http.reply("GET", metadataPath, 200, absentMetadata());
      const router = await renderProviderRoute();
      const panel = await findPanel();

      http.reply("POST", grantPath, 200, mintedBody(syntheticGrant));
      http.reply("GET", metadataPath, 200, absentMetadata({ grant: activeGrant }));
      fireEvent.click(await within(panel).findByRole("button", { name: "Pair extension" }));
      const grantRegion = await findGrantRegion(panel);

      expect(within(grantRegion).getByText(syntheticGrant)).toBeTruthy();
      expect(within(grantRegion).getByText(notConfirmedNotice)).toBeTruthy();
      expect(within(grantRegion).getByRole("button", { name: "Copy" })).toBeTruthy();
      expect(within(grantRegion).getByRole("button", { name: "Dismiss grant" })).toBeTruthy();
      await waitFor(() =>
        expect(http.requests).toEqual([`GET ${metadataPath}`, `POST ${grantPath}`, `GET ${metadataPath}`]),
      );
      expect(panel.textContent).not.toMatch(/not received|Paired with extension/i);
      expect(document.body.innerHTML).not.toContain(hostileMarker);
      if (sendMessage) expect(sendMessage.mock.calls).toEqual([handoffMessage(syntheticGrant)]);
      expectGrantAbsentFromSinks(router, consoleCalls, syntheticGrant);
      expect(JSON.stringify(consoleCalls.map((spy) => spy.mock.calls))).not.toContain(hostileMarker);
    },
  );

  it("keeps the grant unrendered for 15 seconds, then falls back and discards the late paired reply", async () => {
    const exposures = watchDomForSecret(syntheticGrant);
    const reply = deferred<unknown>();
    const sendMessage = stubSendMessage(() => reply.promise);
    http.reply("GET", metadataPath, 200, absentMetadata());
    await renderProviderRoute();
    const panel = await findPanel();
    await within(panel).findByRole("button", { name: "Pair extension" });

    http.reply("POST", grantPath, 200, mintedBody(syntheticGrant));
    http.reply("GET", metadataPath, 200, absentMetadata({ grant: activeGrant }));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    fireEvent.click(within(panel).getByRole("button", { name: "Pair extension" }));
    await flushUntil(() => sendMessage.mock.calls.length > 0, "the handoff send");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(14_999);
    });
    expect(panel.querySelector("[data-operator-session-grant]")).toBeNull();
    expect(within(panel).getByRole("button", { name: "Pairing the operator extension" })).toBeTruthy();
    expect(http.requests).toEqual([`GET ${metadataPath}`, `POST ${grantPath}`]);
    expect(exposures()).toEqual([]);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    vi.useRealTimers();
    const grantRegion = await findGrantRegion(panel);
    expect(within(grantRegion).getByText(notConfirmedNotice)).toBeTruthy();
    await waitFor(() => expect(http.requests).toHaveLength(3));

    await act(async () => reply.resolve({ outcome: "paired" }));
    expect(panel.querySelector("[data-operator-session-grant]")).toBe(grantRegion);
    expect(within(grantRegion).getByText(syntheticGrant)).toBeTruthy();
    expect(panel.textContent).not.toContain(pairedAnnouncement);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(http.requests).toEqual([`GET ${metadataPath}`, `POST ${grantPath}`, `GET ${metadataPath}`]);
  });

  it("discards a paired reply that arrives after the panel remounts on navigation", async () => {
    const reply = deferred<unknown>();
    const sendMessage = stubSendMessage(() => reply.promise);
    http.reply("GET", metadataPath, 200, absentMetadata());
    const router = await renderProviderRoute();
    const panel = await findPanel();
    http.reply("POST", grantPath, 200, mintedBody(syntheticGrant));
    fireEvent.click(await within(panel).findByRole("button", { name: "Pair extension" }));
    await flushUntil(() => sendMessage.mock.calls.length > 0, "the handoff send");

    http.reply("GET", metadataPath, 200, absentMetadata());
    await act(() => router.navigate("/catalog/providers/tcgplayer?profileVersion=2026.06.04"));
    const remounted = await findPanel();
    await within(remounted).findByRole("button", { name: "Pair extension" });
    await act(async () => reply.resolve({ outcome: "paired" }));

    expect(remounted.textContent).not.toContain(pairedAnnouncement);
    expect(remounted.querySelector("[data-operator-session-grant]")).toBeNull();
    expect(document.body.innerHTML).not.toContain(syntheticGrant);
    expect(http.requests).toEqual([`GET ${metadataPath}`, `POST ${grantPath}`, `GET ${metadataPath}`]);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });
});

// The injected adapter isolates the panel's own 15-second bound and its
// invalidation from the Chrome runtime shapes covered above.
describe("#9574 AC2 late handoff replies after fallback or invalidation", () => {
  type PendingHandoff = Readonly<{ grant: string; reply: Deferred<OperatorExtensionHandoffResult> }>;

  async function renderWithPendingHandoffs() {
    const handoffs: PendingHandoff[] = [];
    const extensionHandoff = vi.fn((grant: string) => {
      const reply = deferred<OperatorExtensionHandoffResult>();
      handoffs.push({ grant, reply });
      return reply.promise;
    });
    http.reply("GET", metadataPath, 200, absentMetadata());
    const view = render(<OperatorSessionPanel extensionHandoff={extensionHandoff} />);
    const panel = await findPanel();
    await within(panel).findByRole("button", { name: "Pair extension" });
    return { view, panel, handoffs, extensionHandoff };
  }

  async function pair(panel: HTMLElement, handoffs: PendingHandoff[], grant: string) {
    const sent = handoffs.length + 1;
    http.reply("POST", grantPath, 200, mintedBody(grant));
    http.reply("GET", metadataPath, 200, absentMetadata({ grant: activeGrant }));
    fireEvent.click(within(panel).getByRole("button", { name: "Pair extension" }));
    await flushUntil(() => handoffs.length === sent, "the handoff send");
  }

  async function pairUntilTimeout(panel: HTMLElement, handoffs: PendingHandoff[], grant: string) {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await pair(panel, handoffs, grant);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    vi.useRealTimers();
    return findGrantRegion(panel);
  }

  it("keeps a fallen-back grant displayed when its late paired reply arrives", async () => {
    const { panel, handoffs, extensionHandoff } = await renderWithPendingHandoffs();
    const grantRegion = await pairUntilTimeout(panel, handoffs, syntheticGrant);

    await act(async () => handoffs[0]!.reply.resolve("paired"));
    expect(within(grantRegion).getByText(syntheticGrant)).toBeTruthy();
    expect(within(grantRegion).getByText(notConfirmedNotice)).toBeTruthy();
    expect(panel.textContent).not.toContain(pairedAnnouncement);
    expect(extensionHandoff.mock.calls).toEqual([[syntheticGrant]]);
    expect(http.requests.filter((request) => request.startsWith("POST"))).toHaveLength(1);
  });

  it("never resurrects a dismissed grant on a late reply", async () => {
    const { panel, handoffs } = await renderWithPendingHandoffs();
    const grantRegion = await pairUntilTimeout(panel, handoffs, syntheticGrant);
    fireEvent.click(within(grantRegion).getByRole("button", { name: "Dismiss grant" }));
    await waitFor(() => expect(http.requests).toHaveLength(3));

    await act(async () => handoffs[0]!.reply.resolve("paired"));
    expect(panel.querySelector("[data-operator-session-grant]")).toBeNull();
    expect(document.body.innerHTML).not.toContain(syntheticGrant);
    expect(panel.textContent).not.toContain(pairedAnnouncement);
    expect(http.requests).toHaveLength(3);
  });

  it("never resurrects the grant or claims pairing on a late reply after Disconnect", async () => {
    const { panel, handoffs } = await renderWithPendingHandoffs();
    await pairUntilTimeout(panel, handoffs, syntheticGrant);
    await waitFor(() => expect(http.requests).toHaveLength(3));
    http.reply("DELETE", metadataPath, 200, { outcome: "cleared", revision: 1 });
    http.reply("GET", metadataPath, 200, clearedMetadata(1, { grant: inactiveGrant }));
    await confirmDisconnect(panel);
    expect(await within(panel).findByText("Stored session cleared. The record is now revision 1.")).toBeTruthy();

    await act(async () => handoffs[0]!.reply.resolve("paired"));
    expect(panel.querySelector("[data-operator-session-grant]")).toBeNull();
    expect(document.body.innerHTML).not.toContain(syntheticGrant);
    expect(panel.textContent).not.toContain(pairedAnnouncement);
    expect(within(panel).getByText("Stored session cleared. The record is now revision 1.")).toBeTruthy();
  });

  it("never drops or claims a newer mutation's grant on an older late reply", async () => {
    const { panel, handoffs, extensionHandoff } = await renderWithPendingHandoffs();
    await pairUntilTimeout(panel, handoffs, syntheticGrant);
    await waitFor(() => expect(http.requests).toHaveLength(3));

    // The newer handoff is still pending when the older paired reply lands.
    await pair(panel, handoffs, syntheticGrantB);
    expect(panel.querySelector("[data-operator-session-grant]")).toBeNull();
    await act(async () => handoffs[0]!.reply.resolve("paired"));
    expect(within(panel).getByRole("button", { name: "Pairing the operator extension" })).toBeTruthy();
    expect(panel.textContent).not.toContain(pairedAnnouncement);

    await act(async () => handoffs[1]!.reply.resolve("not-confirmed"));
    const grantRegion = await findGrantRegion(panel);
    expect(within(grantRegion).getByText(syntheticGrantB)).toBeTruthy();
    expect(within(grantRegion).getByText(notConfirmedNotice)).toBeTruthy();
    expect(document.body.innerHTML).not.toContain(syntheticGrant);
    expect(extensionHandoff.mock.calls).toEqual([[syntheticGrant], [syntheticGrantB]]);
    expect(http.requests.filter((request) => request.startsWith("POST"))).toHaveLength(2);
  });

  it("never hides a newer fallback grant on an older late reply", async () => {
    const { panel, handoffs } = await renderWithPendingHandoffs();
    await pairUntilTimeout(panel, handoffs, syntheticGrant);
    await waitFor(() => expect(http.requests).toHaveLength(3));
    await pair(panel, handoffs, syntheticGrantB);
    await act(async () => handoffs[1]!.reply.resolve("not-confirmed"));
    const grantRegion = await findGrantRegion(panel);

    await act(async () => handoffs[0]!.reply.resolve("paired"));
    expect(panel.querySelector("[data-operator-session-grant]")).toBe(grantRegion);
    expect(within(grantRegion).getByText(syntheticGrantB)).toBeTruthy();
    expect(panel.textContent).not.toContain(pairedAnnouncement);
  });

  it.each([
    ["while awaiting the reply", false],
    ["after the fallback", true],
  ])("changes nothing when the reply lands after unmount %s", async (_label, fallBack) => {
    const consoleCalls = spyConsole();
    const { view, panel, handoffs } = await renderWithPendingHandoffs();
    if (fallBack) await pairUntilTimeout(panel, handoffs, syntheticGrant);
    else await pair(panel, handoffs, syntheticGrant);
    view.unmount();

    await act(async () => handoffs[0]!.reply.resolve("paired"));
    expect(document.body.innerHTML).not.toContain(syntheticGrant);
    expect(document.body.textContent).not.toContain(pairedAnnouncement);
    expect(consoleCalls.flatMap((spy) => spy.mock.calls)).toEqual([]);
    expect(http.requests.filter((request) => request.startsWith("POST"))).toHaveLength(1);
  });

  it("falls back when the injected adapter rejects, without surfacing the rejection", async () => {
    const consoleCalls = spyConsole();
    const { panel, handoffs } = await renderWithPendingHandoffs();
    await pair(panel, handoffs, syntheticGrant);

    await act(async () => handoffs[0]!.reply.reject(new Error(`${hostileMarker} ${syntheticGrant}`)));
    const grantRegion = await findGrantRegion(panel);
    expect(within(grantRegion).getByText(notConfirmedNotice)).toBeTruthy();
    expect(document.body.innerHTML).not.toContain(hostileMarker);
    expect(JSON.stringify(consoleCalls.map((spy) => spy.mock.calls))).not.toContain(syntheticGrant);
  });
});
