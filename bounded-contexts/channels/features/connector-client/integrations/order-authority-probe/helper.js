(() => {
  let invoked = false;
  let aborted = false;
  const REFUSALS = new Set([
    "canceled",
    "date_filter_mismatch",
    "count_surface_mismatch",
    "display_unsettled",
    "bracket_changed",
    "count_input_invalid",
  ]);
  function ownPage() {
    return location.href === chrome.runtime.getURL("capture.html") && window.top === window;
  }
  async function abort() {
    if (arguments.length || !ownPage()) return { ok: false, code: "wrong_origin" };
    aborted = true;
    try {
      return await chrome.runtime.sendMessage({ kind: "abort" });
    } catch {
      return { ok: false, code: "capture_refused" };
    }
  }
  addEventListener(
    "pagehide",
    () => {
      if (invoked) void abort();
    },
    { once: true },
  );
  async function hash(text) {
    return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
  }
  function download(name, text) {
    const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function countRecord(searchRange, after) {
    const portalLabel = searchRange === "LastTwoYears" ? "Last 2 years" : "Last 90 days";
    if (
      after &&
      !confirm(
        "The worker response has ended. HUMAN: load a fresh Orders view now. Continue only after that fresh load; no agents, screenshots or page output.",
      )
    )
      throw new Error("canceled");
    let dateFilter = prompt(
      `Expected range: ${portalLabel} (${searchRange}). Confirm the visible date filter as LastTwoYears or LastThreeMonths BEFORE reading any count. Cancel stops.`,
    );
    if (dateFilter === null) throw new Error("canceled");
    const reprompted = dateFilter !== searchRange;
    if (reprompted) {
      dateFilter = prompt(
        `Restore ${portalLabel} in the portal once, wait for it to settle, then confirm the visible date filter. Cancel stops.`,
      );
      if (dateFilter === null) throw new Error("canceled");
      if (dateFilter !== searchRange) throw new Error("date_filter_mismatch");
    }
    let label = prompt(
      "Transcribe ONLY the label adjacent to the count you intend to read. Do not read the count yet. Cancel stops.",
    );
    try {
      if (label === null) throw new Error("canceled");
      if (label.trim().replace(/\s+/g, " ").toLowerCase() !== "ready to ship")
        throw new Error("count_surface_mismatch");
    } finally {
      label = null;
    }
    if (
      !confirm(
        after
          ? "Has this post-response fresh Orders load (and any explicit range restoration) settled?"
          : "Has the selected Orders display settled?",
      )
    )
      throw new Error("display_unsettled");
    if (
      !confirm(
        "Has the seller, session and Orders display remained unchanged, except for the explicit range restoration above?",
      )
    )
      throw new Error("bracket_changed");
    let input = prompt(
      `Record that adjacent quick-filter count ONCE now, under ${portalLabel}. Digits only. Exclude all-orders, pagination and search totals; Cancel stops.`,
    );
    try {
      if (input === null) throw new Error("canceled");
      if (!/^\d{1,9}$/.test(input)) throw new Error("count_input_invalid");
      return {
        count: Number(input),
        dateFilter,
        reprompted,
        countSurface: "ready-to-ship-quick-filter",
        observedAt: new Date(Date.now()).toISOString(),
        settled: true,
        unchanged: true,
      };
    } finally {
      input = null;
    }
  }
  async function exportReceipt(receipt) {
    const text = JSON.stringify(receipt, null, 2) + "\n";
    const inventory = {
      format: "order-authority-inventory/v4",
      evidence: receipt.evidence,
      probe: receipt.probe,
      head: receipt.head,
      extensionId: chrome.runtime.id,
      files: { "selector-receipt.json": await hash(text) },
      packageDigests: receipt.digests,
      removal: {
        extensionAbsent: false,
        extensionAbsentAt: null,
        profileDisposed: false,
        confirmation: "pending-operator-removal",
      },
      retainedFiles: ["selector-receipt.json", "selector-inventory.json"],
    };
    download("selector-receipt.json", text);
    download("selector-inventory.json", JSON.stringify(inventory, null, 2) + "\n");
    return { ok: true, code: "scrubbed_export_created" };
  }
  async function run() {
    if (arguments.length || !ownPage()) return { ok: false, code: "wrong_origin" };
    if (invoked) return { ok: false, code: "repeat_invocation" };
    invoked = true;
    let begun = false;
    let finished = false;
    const send = async (message) => {
      if (aborted) throw new Error("aborted");
      const response = await chrome.runtime.sendMessage(message);
      if (!response?.ok) throw new Error("capture_refused");
      return response;
    };
    const terminal = async (response) => {
      finished = true;
      return exportReceipt(response.receipt);
    };
    try {
      if (
        !confirm(
          "HUMAN ONLY: one selector lifecycle with pre-launch T0, including sign-in and removal within T0+15 minutes? Preparation grants no execution; no raw recording or retries.",
        )
      )
        return { ok: false, code: "canceled" };
      const begin = await send({ kind: "begin" });
      begun = true;
      if (begin.receipt) return terminal(begin);
      const lookup = await send({ kind: "lookup" });
      if (lookup.receipt) return terminal(lookup);
      for (let index = 0; index < 2; index += 1) {
        const searchRange = index === 0 ? "LastTwoYears" : "LastThreeMonths";
        const search = await send({ kind: "search", ...countRecord(searchRange, false) });
        if (search.receipt) return terminal(search);
        const counts = await send({
          kind: "counts",
          ...countRecord(searchRange, true),
          sameSession: confirm("Same seller and approved session throughout this bracket? Session loss stops."),
        });
        if (counts.receipt) return terminal(counts);
        if (counts.code !== "fallback_available") break;
      }
      return terminal(await send({ kind: "finish" }));
    } catch (error) {
      if (begun && !finished) {
        try {
          const response = await chrome.runtime.sendMessage(
            error?.message === "canceled"
              ? { kind: "cancel" }
              : { kind: "abort", reason: REFUSALS.has(error?.message) ? error.message : "aborted" },
          );
          if (response?.receipt) return await terminal(response);
        } catch {
          /* Only bounded failure codes leave the helper. */
        }
      }
      return { ok: false, code: error?.message === "canceled" ? "canceled" : "capture_refused" };
    }
  }
  Object.defineProperty(globalThis, "orderAuthorityCapture", { value: Object.freeze({ run, abort }) });
})();
