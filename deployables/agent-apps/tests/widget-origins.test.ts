import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { mcpWidgetResourceContent } from "@chase-sets/platform-runtime/mcp-widget-resources";
import { UCP_MCP_PRODUCT_CARDS_RESOURCE_URI } from "@chase-sets/platform-runtime/ucp";
import { expectUcpCapture } from "@chase-sets/platform-runtime/ucp-schema-test-support";
import { addProductCardsBundleHashes } from "../product-cards-csp";
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
      addProductCardsBundleHashes(bundled),
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
