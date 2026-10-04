(() => {
  let invoked = false;
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
  async function run() {
    if (arguments.length || location.href !== chrome.runtime.getURL("capture.html"))
      return { ok: false, code: "wrong_origin" };
    if (invoked) return { ok: false, code: "repeat_invocation" };
    invoked = true;
    try {
      const begun = await chrome.runtime.sendMessage({ kind: "begin" });
      if (!begun?.ok) return { ok: false, code: "preparation_refused" };
      let orderNumber = null;
      if (confirm("One read-only capture in the host-created isolated profile? No retries or raw network recording.")) {
        orderNumber = prompt(
          "Enter one known order number. This input is transient and must not be entered in the console.",
        );
      }
      let response;
      try {
        response = await chrome.runtime.sendMessage(
          orderNumber?.trim() ? { kind: "capture", orderNumber } : { kind: "cancel" },
        );
      } finally {
        orderNumber = null;
      }
      if (!response?.ok || !response.receipt) return { ok: false, code: "capture_refused" };
      const text = JSON.stringify(response.receipt, null, 2) + "\n";
      const inventory = {
        format: "order-authority-inventory/v1",
        evidence: response.receipt.evidence,
        head: response.receipt.head,
        extensionId: chrome.runtime.id,
        files: { "8607-receipt.json": await hash(text) },
        packageDigests: response.receipt.digests,
        removal: { extensionAbsent: false, profileDisposed: false, confirmation: "pending-operator-removal" },
        retainedFiles: ["8607-receipt.json", "8607-inventory.json"],
      };
      download("8607-receipt.json", text);
      download("8607-inventory.json", JSON.stringify(inventory, null, 2) + "\n");
      return { ok: true, code: "scrubbed_export_created" };
    } catch {
      return { ok: false, code: "capture_refused" };
    }
  }
  Object.defineProperty(globalThis, "orderAuthorityCapture", { value: Object.freeze({ run }) });
})();
