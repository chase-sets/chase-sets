import { describe, expect, it } from "vitest";
import { hasRetiredAdminVerifiedChip } from "./admin-shell-smoke-assertions.mjs";

describe("admin shell deployed smoke assertions", () => {
  it("detects the retired verified SellerBadge shell treatment", () => {
    const html = `
      <div class="inline-flex items-center gap-2 rounded-full border border-muted bg-elevated px-3 py-1.5 text-sm">
        <span><svg aria-hidden="true"></svg><span>Access</span></span>
        <span class="inline-flex rounded-tokenMd border px-2.5 py-1 text-xs font-semibold">Verified</span>
      </div>
    `;

    expect(hasRetiredAdminVerifiedChip(html)).toBe(true);
  });

  it("allows unrelated page data and copy containing Verified", () => {
    const html = `
      <main>
        <table><tbody><tr><td>Verified Operations account</td></tr></tbody></table>
        <script>window.__data = { label: "Verified trade" };</script>
      </main>
    `;

    expect(hasRetiredAdminVerifiedChip(html)).toBe(false);
  });

  it("does not reject a non-shell badge with Verified text", () => {
    const html = `
      <span class="inline-flex rounded-tokenMd border px-2.5 py-1 text-xs font-semibold">Verified</span>
    `;

    expect(hasRetiredAdminVerifiedChip(html)).toBe(false);
  });
});
