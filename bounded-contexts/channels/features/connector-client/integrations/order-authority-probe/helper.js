(() => {
  const BUCKETS = ["Shipped - In Transit", "Shipped - Delivered", "Completed - Paid", "Canceled"];
  let invoked = false;
  let aborted = false;
  let privateSelections;
  async function abort() {
    if (arguments.length || location.href !== chrome.runtime.getURL("capture.html") || window.top !== window)
      return { ok: false, code: "wrong_origin" };
    aborted = true;
    privateSelections?.forEach((selection) => {
      selection.orderNumber = null;
    });
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
  function countRecord(searchRange, after = false) {
    const portalLabel = searchRange === "LastTwoYears" ? "Last 2 years" : "Last 90 days";
    let dateFilter = prompt(
      `Expected date filter: ${portalLabel} (${searchRange}). Confirm the visible filter as LastTwoYears or LastThreeMonths before reading the count. No identifiers; Cancel stops.`,
    );
    if (dateFilter === null) throw new Error("canceled");
    const reprompted = dateFilter !== searchRange;
    if (reprompted) {
      dateFilter = prompt(`Re-select ${portalLabel} in the portal, then confirm the visible filter`);
      if (dateFilter === null) throw new Error("canceled");
      if (dateFilter !== searchRange) {
        if (!after) throw new Error("date_filter_mismatch");
        return {
          count: null,
          dateFilter: ["LastTwoYears", "LastThreeMonths"].includes(dateFilter) ? dateFilter : null,
          reprompted,
        };
      }
    }
    const input = prompt(
      `Confirmed date filter: ${portalLabel} (${searchRange}). Record the visible Orders Ready to Ship quick-filter count now, once. Digits only; Cancel stops.`,
    );
    if (input === null || !/^\d{1,9}$/.test(input)) throw new Error("canceled");
    return { count: Number(input), dateFilter, reprompted };
  }
  async function exportReceipt(receipt) {
    const text = JSON.stringify(receipt, null, 2) + "\n";
    const inventory = {
      format: "order-authority-inventory/v3",
      evidence: receipt.evidence,
      head: receipt.head,
      extensionId: chrome.runtime.id,
      files: { "8838-receipt.json": await hash(text) },
      packageDigests: receipt.digests,
      removal: { extensionAbsent: false, profileDisposed: false, confirmation: "pending-operator-removal" },
      retainedFiles: ["8838-receipt.json", "8838-inventory.json"],
    };
    download("8838-receipt.json", text);
    download("8838-inventory.json", JSON.stringify(inventory, null, 2) + "\n");
    return { ok: true, code: "scrubbed_export_created" };
  }
  async function run() {
    if (arguments.length || location.href !== chrome.runtime.getURL("capture.html") || window.top !== window)
      return { ok: false, code: "wrong_origin" };
    if (invoked) return { ok: false, code: "repeat_invocation" };
    invoked = true;
    const started = Date.now();
    const selections = [];
    privateSelections = selections;
    let begun = false;
    let finished = false;
    const send = async (message) => {
      if (aborted) throw new Error("aborted");
      if (Date.now() - started >= 900000) throw new Error("deadline");
      const response = await chrome.runtime.sendMessage(message);
      if (!response?.ok) throw new Error("capture_refused");
      return response;
    };
    try {
      if (
        !confirm(
          "One read-only capture in the approved isolated founder session, within 15 minutes including input/removal? No retries or raw recording.",
        )
      )
        return { ok: false, code: "canceled" };
      const begin = await send({ kind: "begin" });
      begun = true;
      if (begin.receipt) {
        finished = true;
        return exportReceipt(begin.receipt);
      }
      const lookup = await send({ kind: "lookup" });
      if (lookup.receipt) {
        finished = true;
        return exportReceipt(lookup.receipt);
      }
      let qualification;
      for (let index = 0; index < 2; index += 1) {
        const searchRange = index === 0 ? "LastTwoYears" : "LastThreeMonths";
        const before = countRecord(searchRange);
        const search = await send({ kind: "search", ...before });
        if (search.receipt) {
          finished = true;
          return exportReceipt(search.receipt);
        }
        const after = countRecord(searchRange, true);
        qualification = await send({
          kind: "counts",
          ...after,
          sameSession: confirm("Same seller and approved session throughout this count bracket? Session loss stops."),
        });
        if (qualification.receipt) {
          finished = true;
          return exportReceipt(qualification.receipt);
        }
        if (qualification.code !== "fallback_available") break;
      }
      for (const listStatus of BUCKETS) {
        if (!confirm(`Is a privately selected ${listStatus} order available? No means absent/unqualified.`)) {
          selections.push({ listStatus, orderNumber: null });
          continue;
        }
        let orderNumber = prompt(
          `Privately enter the ${listStatus} order number. Never console/URL input; Cancel/blank stops.`,
        );
        try {
          if (!orderNumber?.trim()) throw new Error("canceled");
          selections.push({ listStatus, orderNumber });
        } finally {
          orderNumber = null;
        }
      }
      const response = await send({ kind: "capture", selections });
      finished = true;
      return exportReceipt(response.receipt);
    } catch (error) {
      if (begun && !finished) {
        try {
          const response = await chrome.runtime.sendMessage({
            kind: error?.message === "canceled" ? "cancel" : "abort",
          });
          if (response?.receipt) return await exportReceipt(response.receipt);
        } catch {
          /* Only scrubbed failure codes leave the helper. */
        }
      }
      return { ok: false, code: error?.message === "canceled" ? "canceled" : "capture_refused" };
    } finally {
      selections.forEach((selection) => {
        selection.orderNumber = null;
      });
      selections.length = 0;
      privateSelections = undefined;
    }
  }
  Object.defineProperty(globalThis, "orderAuthorityCapture", { value: Object.freeze({ run, abort }) });
})();
