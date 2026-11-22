import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { mcpWidgetResourceContent } from "@chase-sets/platform-runtime/mcp-widget-resources";
import {
  UCP_MCP_CART_REVIEW_RESOURCE_URI,
  UCP_MCP_CHECKOUT_HANDOFF_RESOURCE_URI,
  UCP_MCP_PRODUCT_CARDS_RESOURCE_URI,
} from "@chase-sets/platform-runtime/ucp";
import { expectUcpCapture } from "@chase-sets/platform-runtime/ucp-schema-test-support";
import { addWidgetBundleHashes } from "../widget-csp";
import { readWidgetOrigins } from "../src/widget-origins";
import recorded from "./fixtures/staging-search-catalog.json";

describe("Agent Apps runtime inputs", () => {
  it("serves an early document CSP without external script or style sources", async () => {
    const template = await readFile(new URL("../product-cards.html", import.meta.url), "utf8");
    const script = 'document.title = "Product Cards";';
    const style = "body { margin: 0; }";
    const bundled = template.replace(
      /<script type="module" src="[^"]+"><\/script>/,
      `<script type="module">${script}</script><style>${style}</style>`,
    );
    const { text } = mcpWidgetResourceContent(
      new Request("https://marketplace.example/"),
      UCP_MCP_PRODUCT_CARDS_RESOURCE_URI,
      addWidgetBundleHashes(bundled),
      "Product Cards",
    );
    const policy = /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(text);
    expect(policy).not.toBeNull();
    expect(policy!.index).toBeLessThan(text.indexOf("<script"));
    expect(policy!.index).toBeLessThan(text.indexOf("<style"));
    const sourceHash = (value: string) => `'sha256-${createHash("sha256").update(value).digest("base64")}'`;
    expect(policy![1]?.split("; ")).toEqual([
      "default-src 'none'",
      `script-src ${sourceHash(script)}`,
      `style-src ${sourceHash(style)}`,
      "img-src https:",
      "font-src data:",
      "base-uri 'none'",
      "form-action 'none'",
    ]);
  });

  it.each([
    ["cart-review", UCP_MCP_CART_REVIEW_RESOURCE_URI],
    ["checkout-handoff", UCP_MCP_CHECKOUT_HANDOFF_RESOURCE_URI],
  ])("serves the %s document unchanged with hashed bundles and no external sources", async (entry, uri) => {
    const template = await readFile(new URL(`../${entry}.html`, import.meta.url), "utf8");
    const script = `document.title = "${entry}";`;
    const style = "main { margin: 0; }";
    const bundled = addWidgetBundleHashes(
      template.replace(
        /<script type="module" src="[^"]+"><\/script>/,
        `<script type="module">${script}</script><style>${style}</style>`,
      ),
    );
    const content = mcpWidgetResourceContent(new Request("https://marketplace.example/"), uri, bundled, entry);
    expect(content.text).toBe(bundled);
    expect(content.text).not.toContain("chase-sets-public-origins");
    expect(content._meta.ui.csp).toEqual({ connectDomains: [], resourceDomains: [] });
    const policy = /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(content.text);
    expect(policy!.index).toBeLessThan(content.text.indexOf("<script"));
    const sourceHash = (value: string) => `'sha256-${createHash("sha256").update(value).digest("base64")}'`;
    expect(policy![1]?.split("; ")).toEqual([
      "default-src 'none'",
      `script-src ${sourceHash(script)}`,
      `style-src ${sourceHash(style)}`,
      "font-src data:",
      "base-uri 'none'",
      "form-action 'none'",
    ]);
  });

  it("refuses a widget document whose CSP cannot cover its bundles", () => {
    const policy = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'sha256-BUNDLED_SCRIPT'; style-src 'sha256-BUNDLED_STYLE'" />`;
    const script = "<script>void 0;</script>";
    const style = "<style>main{}</style>";
    expect(() => addWidgetBundleHashes(`${script}${style}`)).toThrow("Widget document CSP is missing.");
    for (const html of [`${policy}${style}`, `${policy}${script}${script}${style}`, `${script}${policy}${style}`]) {
      expect(() => addWidgetBundleHashes(html)).toThrow("Widget document CSP needs one bundled script");
    }
  });

  it("fails closed when the served widget has no valid origin metadata", () => {
    const origin = "https://marketplace.example";
    expect(readWidgetOrigins(encodeURIComponent(JSON.stringify([origin])))).toEqual([origin]);
    for (const content of [undefined, "", "%", "[]", "42", JSON.stringify([origin, "http://foreign.example"])]) {
      expect(readWidgetOrigins(content)).toEqual([]);
    }
  });

  it("keeps the recorded staging result on the pinned catalog contract", () => {
    expectUcpCapture(recorded.toolResult.structuredContent, { operation: "search_catalog", kind: "resource" });
    expect(recorded.toolResult.structuredContent.products).toHaveLength(2);
    expect(recorded.capture.releaseSha).toMatch(/^[a-f0-9]{40}$/);
  });
});
