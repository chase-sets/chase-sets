import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { isOperatorManifest, operatorExtensionId, operatorManifest, operatorPublicKey } from "../src/manifest-contract";

describe("operator-extension-manifest-contract", () => {
  it("pins a distinct public identity and exact least-authority MV3 capabilities", () => {
    const digest = createHash("sha256").update(Buffer.from(operatorPublicKey, "base64")).digest("hex").slice(0, 32);
    const id = [...digest].map((digit) => String.fromCharCode(97 + Number.parseInt(digit, 16))).join("");
    expect(id).toBe(operatorExtensionId);
    expect(id).not.toBe("ebnhngdhefamkdjajldafonajgkadfhh");
    expect(operatorManifest.permissions).toEqual(["cookies", "storage", "alarms"]);
    expect(operatorManifest.host_permissions).toEqual([
      "https://store.tcgplayer.com/*",
      "https://admin.staging.chasesets.com/*",
      "https://admin.chasesets.com/*",
    ]);
    expect(operatorManifest.content_security_policy).toEqual({
      extension_pages: "script-src 'self'; object-src 'none'",
      sandbox: "sandbox allow-scripts; script-src 'self'; object-src 'none'",
    });
    expect(isOperatorManifest(operatorManifest)).toBe(true);
  });
  it.each([
    { permissions: ["cookies", "storage", "alarms", "webRequest"] },
    { permissions: ["identity"] },
    { content_scripts: [{ matches: ["<all_urls>"], js: ["inject.js"] }] },
    { externally_connectable: { matches: ["*://*/*"] } },
    { host_permissions: ["<all_urls>"] },
    { host_permissions: ["https://*.tcgplayer.com/*"] },
    { host_permissions: ["https://api.chasesets.com/*"] },
    { key: "seller-key" },
    { update_url: "https://update.attacker.test" },
    { web_accessible_resources: ["sandbox.html"] },
    { content_security_policy: { sandbox: "sandbox allow-scripts allow-same-origin" } },
  ])("rejects authority expansion %j", (mutation) => {
    expect(isOperatorManifest({ ...operatorManifest, ...mutation })).toBe(false);
  });
  it("uses only facade bootstraps and fixed cookie adapter arguments", () => {
    const source = (name: string) => readFileSync(resolve(import.meta.dirname, `../src/${name}.ts`), "utf8");
    expect(source("background")).toContain(
      'chrome.cookies.get({ name: operatorCookieName, url: operatorCookieUrl, storeId: "0" })',
    );
    expect(source("background")).not.toMatch(/getAll|storage\.sync|console\./);
    expect(source("popup")).toContain("installOperatorBridge");
    expect(source("popup")).not.toMatch(/storage|cookies|fetch|innerHTML/);
    expect(source("sandbox")).toContain("renderOperatorExtensionPopup");
    expect(source("sandbox")).not.toMatch(/chrome\.|storage|cookies|fetch/);
  });
});
