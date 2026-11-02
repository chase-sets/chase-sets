// @vitest-environment jsdom
import { createHash } from "node:crypto";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChaseRoot } from "@chase-sets/design-system/theme";
import { OperatorExtensionPopup } from "../ui/extension-popup/popup";
import { probeTcgplayerSetNames, serializeSetNamesProbeReport } from "../domain/extension/set-names/probe";

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
    expect(screen.queryByLabelText("Report")).toBeNull();
    expect(screen.queryByRole("button", { name: "Copy report" })).toBeNull();
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
    for (const input of screen
      .getAllByRole("textbox")
      .filter((element) => element.getAttribute("inputmode") === "numeric")
      .slice(1))
      fireEvent.change(input, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Run probe" }));
    expect((screen.getByRole("button", { name: "Running probe…" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByLabelText("Report")).toBeNull();
    expect(screen.queryByRole("button", { name: "Copy report" })).toBeNull();
    await act(async () => resolve({ ok: true, status: 200, contentClass: "json", bytes: 10, body: validBody }));
    await waitFor(() => expect(screen.getByLabelText("Report")).toBeTruthy());
  });

  it("publishes the canonical report and hash together only after the held real digest resolves", async () => {
    const response = { ok: true, status: 200, contentClass: "json" as const, bytes: 10, body: validBody };
    const probedAt = "2026-10-27T00:00:00.000Z";
    const expectedReport = serializeSetNamesProbeReport(
      await probeTcgplayerSetNames({
        request: async () => response,
        extensionVersion: "0.1.0",
        buildCommit: "unknown",
        browserMajor: "unknown",
        probedAt,
        productLineIds: ["1"],
      }),
    );
    const expectedSha = createHash("sha256").update(expectedReport, "utf8").digest("hex");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(probedAt);
    let releaseDigest!: () => void;
    const held = new Promise<void>((resolve) => (releaseDigest = resolve));
    let digestEntered!: () => void;
    const entered = new Promise<void>((resolve) => (digestEntered = resolve));
    let digestFinished!: () => void;
    const finished = new Promise<void>((resolve) => (digestFinished = resolve));
    const realDigest = globalThis.crypto.subtle.digest.bind(globalThis.crypto.subtle);
    const digest = vi.spyOn(globalThis.crypto.subtle, "digest").mockImplementation(async (...args) => {
      digestEntered();
      await held;
      const result = await realDigest(...args);
      digestFinished();
      return result;
    });
    const request = vi.fn(async () => response);
    const copyProbeReport = vi.fn(async () => {});
    try {
      mount(request, copyProbeReport);
      for (const input of screen
        .getAllByRole("textbox")
        .filter((element) => element.getAttribute("inputmode") === "numeric")
        .slice(1))
        fireEvent.change(input, { target: { value: "" } });
      fireEvent.click(screen.getByRole("button", { name: "Run probe" }));
      await act(async () => await entered);
      expect(request).toHaveBeenCalledExactlyOnceWith("1");
      expect((screen.getByRole("button", { name: "Running probe…" }) as HTMLButtonElement).disabled).toBe(true);
      expect(screen.queryByLabelText("Report")).toBeNull();
      expect(screen.queryByText("Probe report ready")).toBeNull();
      expect(screen.queryByRole("button", { name: "Copy report" })).toBeNull();
      expect(screen.queryByText(/^Canonical report SHA-256:/)).toBeNull();
      await act(async () => {
        releaseDigest();
        await finished;
      });
      const report = screen.getByLabelText("Report") as HTMLTextAreaElement;
      expect(report.value).toBe(expectedReport);
      expect(screen.getByText("Probe report ready")).toBeTruthy();
      expect(
        screen.getByText((_, element) => element?.textContent === `Canonical report SHA-256: ${expectedSha}`),
      ).toBeTruthy();
      expect((screen.getByRole("button", { name: "Run probe" }) as HTMLButtonElement).disabled).toBe(false);
      fireEvent.click(screen.getByRole("button", { name: "Copy report" }));
      expect(copyProbeReport).toHaveBeenCalledExactlyOnceWith(expectedReport);
      expect(screen.queryByRole("alert")).toBeNull();
    } finally {
      releaseDigest();
      digest.mockRestore();
      vi.useRealTimers();
    }
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
    expect(report.value).toContain('"lifecycle": "response-receipt-before-reduction"');
    const actualReport = JSON.parse(report.value) as Parameters<typeof serializeSetNamesProbeReport>[0];
    expect(report.value).toBe(serializeSetNamesProbeReport(actualReport));
    const expectedSha = createHash("sha256").update(serializeSetNamesProbeReport(actualReport), "utf8").digest("hex");
    expect(
      screen.getByText((_, element) => element?.textContent === `Canonical report SHA-256: ${expectedSha}`),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Copy report" }));
    await waitFor(() =>
      expect(screen.getByText("Copy failed. Select and copy the report text manually.").getAttribute("role")).toBe(
        "alert",
      ),
    );
    expect(copyProbeReport).toHaveBeenCalledExactlyOnceWith(report.value);
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
