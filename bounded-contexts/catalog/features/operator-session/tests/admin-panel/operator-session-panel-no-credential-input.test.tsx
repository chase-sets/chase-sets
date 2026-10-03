// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OperatorSessionPanel } from "../../ui/admin-panel/operator-session-panel";
import {
  absentMetadata,
  activeGrant,
  clearedMetadata,
  createControlledHttp,
  grantPath,
  metadataPath,
  stepUpRequired,
  storedMetadata,
  syntheticGrant,
  type ControlledHttp,
} from "./controlled-http";

let http: ControlledHttp;

beforeEach(() => {
  http = createControlledHttp();
  vi.stubGlobal("fetch", http.fetch);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// The whole document is inspected so the portalled Disconnect dialog is covered.
function expectNoCredentialEntry(state: string) {
  const entries = document.querySelectorAll(
    "input, textarea, select, [contenteditable]:not([contenteditable='false'])",
  );
  expect(
    [...entries].map((entry) => entry.outerHTML),
    state,
  ).toEqual([]);
}

async function mountWith(body: unknown, status = 200) {
  http.reply("GET", metadataPath, status, body);
  render(<OperatorSessionPanel />);
  const heading = await screen.findByRole("heading", { name: "Operator session" });
  const panel = heading.closest("section") as HTMLElement;
  await waitFor(() => expect(within(panel).queryByText("Loading operator session…")).toBeNull());
  return panel;
}

describe("operator-session-panel-no-credential-input", () => {
  it("renders no text, password or textarea entry while loading", () => {
    http.defer("GET", metadataPath);
    render(<OperatorSessionPanel />);

    expect(screen.getByText("Loading operator session…")).toBeTruthy();
    expectNoCredentialEntry("loading");
  });

  it.each([
    ["absent", absentMetadata()],
    ["stored", storedMetadata(1, { grant: activeGrant })],
    ["unreadable stored", storedMetadata(1, { custodyAvailable: false })],
    ["cleared", clearedMetadata(2)],
  ])("renders no credential entry for %s custody", async (state, body) => {
    await mountWith(body);
    expectNoCredentialEntry(state);
  });

  it("renders no credential entry when metadata is unavailable", async () => {
    await mountWith({ code: "custody-unavailable" }, 503);
    expect(screen.getByText("Operator session unavailable")).toBeTruthy();
    expectNoCredentialEntry("unavailable");
  });

  it("renders no credential entry while pairing, with a grant shown, or with the Disconnect dialog open", async () => {
    const panel = await mountWith(storedMetadata(1));
    const mint = http.defer("POST", grantPath);
    fireEvent.click(within(panel).getByRole("button", { name: "Pair extension" }));
    expectNoCredentialEntry("pairing");

    http.reply("GET", metadataPath, 200, storedMetadata(1, { grant: activeGrant }));
    await act(async () => mint.reply(200, { grant: syntheticGrant, idleExpiresAt: activeGrant.idleExpiresAt }));
    await waitFor(() => expect(panel.querySelector("[data-operator-session-grant]")).not.toBeNull());
    expectNoCredentialEntry("grant shown");

    fireEvent.click(within(panel).getByRole("button", { name: "Disconnect" }));
    await screen.findByRole("alertdialog");
    expectNoCredentialEntry("dialog open");
  });

  it("renders no credential entry beside a step-up refusal", async () => {
    const panel = await mountWith(absentMetadata());
    http.reply("POST", grantPath, 400, stepUpRequired);
    http.reply("GET", metadataPath, 200, absentMetadata());
    fireEvent.click(within(panel).getByRole("button", { name: "Pair extension" }));

    expect(await within(panel).findByRole("link", { name: "Sign in again" })).toBeTruthy();
    expectNoCredentialEntry("step-up");
  });
});
