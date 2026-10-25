// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChaseRoot } from "@chase-sets/design-system/theme";
import { OperatorExtensionPopup } from "../ui/extension-popup/popup";

afterEach(() => cleanup());

const status = { paired: false, state: "unpaired" as const, lastOutcome: null, lastPushedAt: null, serverRevision: 0 };
const validBody = {
  errors: [],
  results: [
    {
      setNameId: 1,
      categoryId: 1,
      name: "Synthetic Set",
      cleanSetName: "Synthetic Set",
      urlName: "synthetic-set",
      abbreviation: "SYN",
      releaseDate: "2026-01-01",
      isSupplemental: false,
      active: true,
    },
  ],
};

function mount(setNameRequest = vi.fn(), copyProbeReport?: (text: string) => Promise<void>) {
  return render(
    <ChaseRoot>
      <OperatorExtensionPopup
        request={vi.fn().mockResolvedValue(status)}
        setNameRequest={setNameRequest}
        copyProbeReport={copyProbeReport}
      />
    </ChaseRoot>,
  );
}

describe("TCGplayer SetNames popup states", () => {
  it("starts empty only after all product-line inputs are cleared and disables Run", async () => {
    mount();
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "Run probe" }) as HTMLButtonElement).disabled).toBe(false),
    );
    for (const input of screen
      .getAllByRole("textbox")
      .filter((element) => element.getAttribute("inputmode") === "numeric"))
      fireEvent.change(input, { target: { value: "" } });
    expect(screen.getByText("Enter at least one product-line id to run the probe.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Run probe" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("renders loading while a run is pending", async () => {
    let resolve!: (value: {
      ok: true;
      status: number;
      contentClass: "json";
      bytes: number;
      body: typeof validBody;
    }) => void;
    const request = vi.fn(() => new Promise((done) => (resolve = done))).mockName("setNamesRequest");
    mount(request);
    fireEvent.click(screen.getByRole("button", { name: "Run probe" }));
    expect((screen.getByRole("button", { name: "Running probe…" }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => resolve({ ok: true, status: 200, contentClass: "json", bytes: 10, body: validBody }));
  });

  it("shows a localized copy failure and a canonical report textarea and hash", async () => {
    const request = vi.fn(async () => ({
      ok: true,
      status: 200,
      contentClass: "json" as const,
      bytes: 10,
      body: validBody,
    }));
    const copyProbeReport = vi.fn(async () => {
      throw new Error("clipboard unavailable");
    });
    mount(request, copyProbeReport);
    fireEvent.click(screen.getByRole("button", { name: "Run probe" }));
    await waitFor(() => expect(screen.getByLabelText("Report")).toBeTruthy(), { timeout: 10_000 });
    const report = screen.getByLabelText("Report") as HTMLTextAreaElement;
    expect(report.value.endsWith("\n")).toBe(true);
    expect(screen.getByText(/Canonical report SHA-256:/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Copy report" }));
    await waitFor(() =>
      expect(screen.getByText("Copy failed. Select and copy the report text manually.")).toBeTruthy(),
    );
    expect(copyProbeReport).toHaveBeenCalled();
  });

  it("renders fixed qualification reason codes as the error state", async () => {
    const request = vi.fn(async () => ({
      ok: false,
      status: null,
      contentClass: "unknown" as const,
      bytes: 0,
      body: null,
      code: "timeout" as const,
    }));
    mount(request);
    fireEvent.click(screen.getByRole("button", { name: "Run probe" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("timeout"), { timeout: 10_000 });
  });
});
