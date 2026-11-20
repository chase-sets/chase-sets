// @vitest-environment jsdom
import { File as NodeFile } from "node:buffer";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ChaseRoot } from "@chase-sets/design-system";
import { RouterLinkAdapter } from "@chase-sets/design-system/react-router";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AccountChannelsConnectionRoute, {
  action,
  loader,
} from "../../../routes/marketplace/account-channels-connection";

// The action parses the multipart submission with Node's undici, which only accepts Node's File realm.
beforeEach(() => vi.stubGlobal("File", NodeFile));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("compose-refusal-guidance", () => {
  it.each(["staged-basis-stale", "staged-basis-unavailable"])(
    "renders the Staged-ingest guidance for a %s Compose refusal",
    async (code) => {
      const api = channelsApi({ compose: () => Response.json(errorBody(code), { status: 409 }) });
      vi.stubGlobal("fetch", api.fetch);
      renderRoute();
      fireEvent.click(await screen.findByRole("button", { name: "Compose Staged batch" }));
      const guidance = await screen.findByTestId("manual-sync-staged-basis-guidance");
      expect(guidance.textContent).toContain("Ingest a newer Staged export first");
      expect(screen.queryByText("Manual sync action failed")).toBeNull();
      expect(api.posts()).toEqual(["/api/channels/connections/connection-a/manual-sync/compose"]);
    },
  );

  it.each([
    ["run-outstanding", 409],
    ["invalid-action", 400],
    ["manual-sync-unavailable", 503],
  ] as const)("keeps the generic failure banner for a %s Compose refusal", async (code, status) => {
    vi.stubGlobal("fetch", channelsApi({ compose: () => Response.json(errorBody(code), { status }) }).fetch);
    renderRoute();
    fireEvent.click(await screen.findByRole("button", { name: "Compose Staged batch" }));
    expect(await screen.findByText("Manual sync action failed")).toBeTruthy();
    expect(screen.queryByTestId("manual-sync-staged-basis-guidance")).toBeNull();
  });
});

describe("ingest-receipt-action-data", () => {
  it("renders the server probe and snapshot after a Live ingest and still revalidates the panel", async () => {
    let respond!: (response: Response) => void;
    const api = channelsApi({
      ingest: () => new Promise<Response>((resolve) => (respond = resolve)),
    });
    vi.stubGlobal("fetch", api.fetch);
    renderRoute();
    const submit = await screen.findByRole("button", { name: "Ingest Live export" });
    const fileInput = document.querySelector<HTMLInputElement>('input[type="file"]');
    expect(fileInput).not.toBeNull();
    const file = new NodeFile(["header\nrow"], "live.csv", { type: "text/csv" });
    const files = {
      0: file,
      length: 1,
      item(index: number) {
        return index === 0 ? file : null;
      },
    } as unknown as FileList;
    fireEvent.change(fileInput!, {
      target: { files },
    });
    await waitFor(() => expect(submit.matches(":disabled")).toBe(false));
    submitExport(submit);

    await waitFor(() => {
      const pending = screen.getByRole("button", { name: "Ingest Live export" });
      expect(pending.closest("form")?.getAttribute("aria-busy")).toBe("true");
      expect(pending.matches(":disabled")).toBe(false);
    });
    submitExport(submit);
    expect(api.posts()).toEqual(["/api/channels/connections/connection-a/manual-sync/ingest?surface=live"]);
    expect(screen.queryByTestId("manual-sync-ingest-receipt")).toBeNull();
    expect(api.panelReads()).toBe(1);
    respond(
      Response.json({
        surface: "live",
        probe,
        outcome: { kind: "ingested", snapshotId: "cis_live_9", snapshotGeneration: 9, parsedRowCount: 2 },
      }),
    );

    const receipt = await screen.findByTestId("manual-sync-ingest-receipt");
    expect(within(receipt).getByText("Live export ingested")).toBeTruthy();
    expect(within(receipt).getByText("Snapshot cis_live_9 · generation 9 · 2 rows")).toBeTruthy();
    expect(definitionPairs(within(receipt).getByTestId("manual-sync-ingest-probe"))).toEqual([
      ["File", "live.csv"],
      ["Bytes", "2048"],
      ["Logical rows", "2"],
      ["Header SHA-256", probe.headerSha256],
      ["Observed", "2026-10-11T12:00:00.000Z"],
    ]);
    expect(screen.queryByText("Export refused")).toBeNull();
    expect(await screen.findByText("Inbound sales visibility is live")).toBeTruthy();
    expect(api.panelReads()).toBe(2);
    expect(api.posts()).toEqual(["/api/channels/connections/connection-a/manual-sync/ingest?surface=live"]);
  });

  it("renders a refused export as a danger banner with no success", async () => {
    const api = channelsApi({
      ingest: () => Response.json({ surface: "live", probe, outcome: { kind: "refused", reason: "header-mismatch" } }),
    });
    vi.stubGlobal("fetch", api.fetch);
    renderRoute();
    submitExport(await screen.findByRole("button", { name: "Ingest Live export" }));

    const receipt = await screen.findByTestId("manual-sync-ingest-receipt");
    const refusal = within(receipt).getByTestId("manual-sync-ingest-refused");
    expect(refusal.textContent).toContain("Export refused");
    expect(refusal.textContent).toContain("header-mismatch");
    expect(within(receipt).queryByText("Live export ingested")).toBeNull();
    expect(within(receipt).queryByText(/^Snapshot /)).toBeNull();
    expect(await screen.findByText("Inbound sales visibility is live")).toBeTruthy();
    expect(api.panelReads()).toBe(2);
  });

  it("never carries export rows from an over-sharing ingest response into action data", async () => {
    vi.stubGlobal(
      "fetch",
      channelsApi({
        ingest: () =>
          Response.json({
            surface: "staged",
            probe: { ...probe, fileName: "staged.csv" },
            outcome: { kind: "ingested", snapshotId: "cis_staged_3", snapshotGeneration: 3, parsedRowCount: 1 },
            rows: [{ externalKey: "row-sentinel-987650" }],
            header: ["header-sentinel"],
          }),
      }).fetch,
    );
    const router = renderRoute();
    submitExport(await screen.findByRole("button", { name: "Ingest Staged export" }));
    await screen.findByTestId("manual-sync-ingest-receipt");
    expect(JSON.stringify(router.state.actionData)).not.toMatch(/sentinel/);
    expect(document.body.textContent).not.toMatch(/sentinel/);
  });

  it.each([
    ["an error status", () => Response.json(errorBody("export-too-large"), { status: 413 })],
    ["a malformed receipt", () => Response.json({ surface: "live", probe, outcome: { kind: "ingested" } })],
  ])("renders %s as the generic failure, never a receipt", async (_name, ingest) => {
    vi.stubGlobal("fetch", channelsApi({ ingest }).fetch);
    renderRoute();
    submitExport(await screen.findByRole("button", { name: "Ingest Live export" }));
    expect(await screen.findByText("Manual sync action failed")).toBeTruthy();
    expect(screen.queryByTestId("manual-sync-ingest-receipt")).toBeNull();
  });
});

const probe = {
  fileName: "live.csv",
  byteSize: 2048,
  logicalRows: 2,
  headerSha256: "a".repeat(64),
  observedAt: "2026-10-11T12:00:00.000Z",
};

function submitExport(button: HTMLElement) {
  const form = button.closest("form");
  if (!form) throw new Error("export form is missing");
  fireEvent.submit(form);
}

function definitionPairs(list: HTMLElement) {
  return [...list.querySelectorAll("dt")].map((term) => [term.textContent, term.nextElementSibling?.textContent]);
}

function errorBody(code: string) {
  return { error: { code, message: code } };
}

function channelsApi(handlers: Readonly<{ compose?: () => Response; ingest?: () => Response | Promise<Response> }>) {
  const calls: { method: string; path: string }[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    const path = `${url.pathname}${url.search}`;
    calls.push({ method, path });
    if (url.pathname.endsWith("/manual-sync/compose"))
      return handlers.compose?.() ?? new Response(null, { status: 500 });
    if (url.pathname.endsWith("/manual-sync/ingest")) return handlers.ingest?.() ?? new Response(null, { status: 500 });
    if (url.pathname.endsWith("/manual-sync"))
      return Response.json(panel(calls.filter((call) => call.path.endsWith("/manual-sync")).length > 1));
    if (url.pathname.endsWith("/connector-pairing"))
      return Response.json({
        state: "unpaired",
        pairingId: null,
        revision: null,
        codeExpiresAt: null,
        lastSeenAt: null,
      });
    if (url.pathname.endsWith("/outbound-operations")) return Response.json(operationLog());
    if (url.pathname.endsWith("/attention"))
      return Response.json({ connectionId: "connection-a", healthState: "healthy", health: [], manual: null });
    if (url.pathname.endsWith("/drift")) return Response.json({ kind: "not-yet-observed" });
    if (url.pathname.endsWith("/connections/connection-a")) return Response.json(connection());
    return Response.json({ actor: actor() });
  });
  return {
    fetch,
    posts: () => calls.filter((call) => call.method === "POST").map((call) => call.path),
    panelReads: () => calls.filter((call) => call.method === "GET" && call.path.endsWith("/manual-sync")).length,
  };
}

function renderRoute() {
  const router = createMemoryRouter(
    [{ path: "/account/channels/:connectionId", loader, action, Component: AccountChannelsConnectionRoute }],
    { initialEntries: ["/account/channels/connection-a"] },
  );
  render(
    <ChaseRoot linkComponent={RouterLinkAdapter}>
      <RouterProvider router={router} />
    </ChaseRoot>,
  );
  return router;
}

function actor() {
  return {
    sessionId: "session-a",
    tenantId: "tenant-a",
    userId: "user-a",
    accountId: "acc-owner",
    membershipId: "membership-a",
    roleKey: "owner",
    permissions: ["channels.view", "channels.manage"],
  };
}

function connection() {
  return {
    connectionId: "connection-a",
    providerKey: "tcgplayer",
    environment: "production",
    status: "active",
    createdAt: "2026-10-11T11:00:00.000Z",
    allowedActions: ["pause", "disconnect"],
  };
}

function panel(revalidated: boolean) {
  return {
    connection: connection(),
    inboundCoverage: revalidated ? { state: "live", reason: null } : { state: "dark", reason: "no-inbound-authority" },
    run: null,
    actions: ["ingest-live", "ingest-staged", "compose"],
    leaseCountdownMs: null,
    requestedListingCount: 0,
    composedListingCount: 0,
    attentionReason: null,
    verificationCandidate: null,
  };
}

function operationLog() {
  return {
    connection: connection(),
    log: { items: [], completeness: { kind: "complete", total: 0 } },
    summary: {
      completeness: { kind: "complete", total: 0 },
      succeeded: 0,
      failed: 0,
      pending: 0,
      inFlight: 0,
      blocked: 0,
      inlineEventToProviderAckMs: { p50: null, p95: null, p99: null },
      claimedEventToProviderAckMs: { p50: null, p95: null, p99: null },
    },
  };
}
