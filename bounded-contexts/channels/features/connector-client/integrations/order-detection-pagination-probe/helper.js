(() => {
  let invoked = false;
  let aborted = false;
  const validOrigin = () => location.href === chrome.runtime.getURL("capture.html") && window.top === window;
  async function abort() {
    if (arguments.length || !validOrigin()) return { ok: false, code: "wrong_origin" };
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
  const hash = async (text) =>
    Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
  function download(name, text) {
    if (new TextEncoder().encode(text).length > 65536) throw new Error("export_cap");
    const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function exportReceipt(receipt) {
    const text = JSON.stringify(receipt, null, 2) + "\n";
    const index =
      JSON.stringify(
        {
          format: "detection-pagination-inventory/v1",
          evidence: receipt.evidence,
          head: receipt.head,
          extensionId: receipt.extensionId,
          packageDigests: receipt.digests,
          files: { "9142-receipt.json": await hash(text) },
          removal: { extensionAbsent: false, profileDisposed: false, processesAbsent: false, extensionAbsentAt: null },
          retainedFiles: ["9142-inventory.json", "9142-receipt.json"],
        },
        null,
        2,
      ) + "\n";
    if ([text, index].some((value) => new TextEncoder().encode(value).length > 65536)) throw new Error("export_cap");
    download("9142-receipt.json", text);
    download("9142-inventory.json", index);
    return { ok: true, code: "scrubbed_export_created" };
  }
  async function run() {
    if (arguments.length || !validOrigin()) return { ok: false, code: "wrong_origin" };
    if (invoked) return { ok: false, code: "repeat_invocation" };
    invoked = true;
    let begun = false;
    try {
      if (
        !confirm(
          "One private read-only #9142 window, T0 fixed before launch, including sign-in and removal within 15 minutes? No retries or recording.",
        )
      )
        return { ok: false, code: "canceled" };
      const send = async (kind) => {
        if (aborted) throw new Error("aborted");
        const output = await chrome.runtime.sendMessage({ kind });
        if (!output?.ok) throw new Error("capture_refused");
        return output;
      };
      let output = await send("begin");
      begun = true;
      if (!output.receipt) output = await send("lookup");
      for (let index = 0; index < 8 && !output.receipt; index += 1) {
        if (
          !confirm(
            "Same approved seller/session, no disclosure or recording, and enough time remains for UI removal? No stops this window.",
          )
        ) {
          output = await send("cancel");
          break;
        }
        output = await send("page");
      }
      if (!output.receipt) output = await send("finish");
      return await exportReceipt(output.receipt);
    } catch {
      if (begun) {
        try {
          const output = await chrome.runtime.sendMessage({ kind: "abort" });
          if (output?.receipt) return await exportReceipt(output.receipt);
        } catch {
          /* No exception or input leaves the helper. */
        }
      }
      return { ok: false, code: "capture_refused" };
    }
  }
  Object.defineProperty(globalThis, "detectionPaginationCapture", { value: Object.freeze({ run, abort }) });
})();
