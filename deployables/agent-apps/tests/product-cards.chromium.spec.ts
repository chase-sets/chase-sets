import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { LATEST_PROTOCOL_VERSION, McpUiInitializeRequestSchema } from "@modelcontextprotocol/ext-apps";
import { mcpWidgetResourceContent } from "@chase-sets/platform-runtime/mcp-widget-resources";
import { UCP_MCP_PRODUCT_CARDS_RESOURCE_URI } from "@chase-sets/platform-runtime/ucp";
import captured from "./fixtures/staging-search-catalog.json" with { type: "json" };

test("renders recorded catalog results in a sandboxed MCP App @agent-apps", async ({ page }) => {
  const host = "https://host.example.test/";
  const widget = "https://widget.example.test/product-cards.html";
  const widgetWithoutDocumentCsp = `${widget}?without-document-csp`;
  const marketplace = new URL(captured.capture.endpoint).origin;
  const admittedImage = `${marketplace}/test-cards/admitted.svg`;
  const admittedScript = `${marketplace}/test-cards/admitted.js`;
  const admittedStyle = `${marketplace}/test-cards/admitted.css`;
  const foreignImage = "https://foreign.example.test/test-cards/blocked.svg";
  const widgetHtml = await readFile(new URL("../build/product-cards.html", import.meta.url), "utf8");
  const resource = mcpWidgetResourceContent(
    new Request(captured.capture.endpoint),
    UCP_MCP_PRODUCT_CARDS_RESOURCE_URI,
    widgetHtml,
    "Product Cards",
  );
  // Hosts admit these resource domains for scripts and styles too. Only the document narrows them.
  expect(resource._meta.ui.csp.resourceDomains).toContain(marketplace);
  const domains = resource._meta.ui.csp.resourceDomains.join(" ");
  const hostCsp = [
    "default-src 'none'",
    `script-src 'unsafe-inline' ${domains}`,
    `style-src 'unsafe-inline' ${domains}`,
    "font-src data:",
    `img-src ${domains}`,
  ].join("; ");

  const requests: { type: string; url: string }[] = [];
  const servedScriptAndStyle: string[] = [];
  page.on("request", (request) => requests.push({ type: request.resourceType(), url: request.url() }));
  await page.route("**/*", async (route) => {
    switch (route.request().url()) {
      case host:
        return route.fulfill({ contentType: "text/html", body: "<!doctype html><title>MCP Apps test host</title>" });
      case widget:
      case widgetWithoutDocumentCsp:
        return route.fulfill({
          contentType: "text/html",
          headers: { "content-security-policy": hostCsp },
          body:
            route.request().url() === widget
              ? resource.text
              : resource.text.replace(/<meta\s+http-equiv="Content-Security-Policy"[^>]*>/i, ""),
        });
      case admittedImage:
        return route.fulfill({
          contentType: "image/svg+xml",
          body: '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12"><rect width="12" height="12"/></svg>',
        });
      case admittedScript:
        servedScriptAndStyle.push(admittedScript);
        return route.fulfill({ contentType: "text/javascript", body: 'document.title = "External script loaded";' });
      case admittedStyle:
        servedScriptAndStyle.push(admittedStyle);
        return route.fulfill({ contentType: "text/css", body: "body { outline: 1px solid red; }" });
      default:
        return route.abort();
    }
  });

  const messages: { method: string; params?: unknown }[] = [];
  await page.exposeFunction("observeAppMessage", (message: (typeof messages)[number]) => {
    messages.push(message);
  });
  await page.goto(host);
  await page.evaluate(
    ({ widget, protocolVersion }) => {
      const frame = document.createElement("iframe");
      frame.src = widget;
      frame.sandbox.add("allow-scripts");
      window.addEventListener("message", (event) => {
        if (event.source !== frame.contentWindow) return;
        const message = event.data;
        void (window as unknown as { observeAppMessage: (message: unknown) => Promise<void> }).observeAppMessage(
          message,
        );
        if (message.method === "ui/initialize") {
          frame.contentWindow?.postMessage(
            {
              jsonrpc: "2.0",
              id: message.id,
              result: {
                protocolVersion,
                hostInfo: { name: "Sandbox host", version: "1.0.0" },
                hostCapabilities: { openLinks: {} },
                hostContext: { theme: "dark" },
              },
            },
            "*",
          );
        }
        if (message.method === "ui/open-link") {
          frame.contentWindow?.postMessage({ jsonrpc: "2.0", id: message.id, result: {} }, "*");
        }
      });
      document.body.append(frame);
    },
    { widget, protocolVersion: LATEST_PROTOCOL_VERSION },
  );
  await expect.poll(() => messages.map(({ method }) => method)).toContain("ui/notifications/initialized");
  const initialize = McpUiInitializeRequestSchema.parse(messages.find(({ method }) => method === "ui/initialize"));
  expect(initialize.params).toMatchObject({
    protocolVersion: LATEST_PROTOCOL_VERSION,
    appInfo: { name: "Chase Sets Product Cards", version: "2.0.0" },
  });

  const notify = (method: string, params: unknown) =>
    page.evaluate(
      ({ method, params }) => {
        document.querySelector("iframe")?.contentWindow?.postMessage({ jsonrpc: "2.0", method, params }, "*");
      },
      { method, params },
    );
  const frame = page.frameLocator("iframe");
  await expect(frame.locator("[data-chase-theme]")).toHaveAttribute("data-color-mode", "dark");
  await notify("ui/notifications/tool-result", captured.toolResult);
  const [pikachu, booster] = captured.toolResult.structuredContent.products;
  await expect(frame.getByText(pikachu.title, { exact: true })).toBeVisible();
  await expect(frame.getByText(booster.title, { exact: true })).toBeVisible();
  await expect(frame.locator("main .grid").first()).toHaveCSS("display", "grid");
  await expect(frame.getByRole("button", { name: "View on Chase Sets" })).toHaveCount(0);

  // The pre-fix staging capture has neither HTTPS product URLs nor media. These are separate test controls.
  const safeUrl = new URL(pikachu.url).href.replace(/^http:/, "https:");
  await notify("ui/notifications/tool-result", {
    ...captured.toolResult,
    structuredContent: {
      ...captured.toolResult.structuredContent,
      products: [
        { ...pikachu, url: safeUrl, media: [{ type: "image", url: admittedImage, alt_text: "Pikachu card" }] },
        { ...booster, url: "javascript:void(0)", media: [{ type: "image", url: foreignImage }] },
      ],
    },
  });
  await notify("ui/notifications/host-context-changed", { theme: "light" });
  await expect(frame.locator("[data-chase-theme]")).toHaveAttribute("data-color-mode", "light");
  const image = frame.getByRole("img", { name: "Pikachu card" });
  await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBe(12);
  await expect(frame.locator("img")).toHaveCount(1);
  await expect(frame.locator("a")).toHaveCount(0);
  const open = frame.getByRole("button", { name: "View on Chase Sets" });
  await expect(open).toHaveCount(1);
  await open.click();
  await expect.poll(() => messages.find(({ method }) => method === "ui/open-link")?.params).toEqual({ url: safeUrl });
  expect(messages.map(({ method }) => method)).not.toContain("tools/call");

  type Violation = Pick<SecurityPolicyViolationEvent, "blockedURI" | "effectiveDirective" | "disposition">;
  const violations: Violation[] = [];
  await page.exposeFunction("observePolicyViolation", (violation: Violation) => {
    violations.push(violation);
  });
  await frame.locator("html").evaluate(() => {
    const report = (window as unknown as { observePolicyViolation: (violation: Violation) => Promise<void> })
      .observePolicyViolation;
    document.addEventListener("securitypolicyviolation", ({ blockedURI, effectiveDirective, disposition }) => {
      void report({ blockedURI, effectiveDirective, disposition });
    });
  });
  const probeExternalResources = () =>
    frame.locator("html").evaluate(
      async (_, { admittedScript, admittedStyle }) => {
        const script = Object.assign(document.createElement("script"), { src: admittedScript });
        const style = Object.assign(document.createElement("link"), { rel: "stylesheet", href: admittedStyle });
        return Promise.all(
          [script, style].map(
            (element) =>
              new Promise<string>((resolve) => {
                element.onload = () => resolve("load");
                element.onerror = () => resolve("error");
                document.head.append(element);
              }),
          ),
        );
      },
      { admittedScript, admittedStyle },
    );
  expect(await probeExternalResources()).toEqual(["error", "error"]);
  await expect
    .poll(() => violations)
    .toEqual(
      expect.arrayContaining([
        { blockedURI: admittedScript, effectiveDirective: "script-src-elem", disposition: "enforce" },
        { blockedURI: admittedStyle, effectiveDirective: "style-src-elem", disposition: "enforce" },
      ]),
    );
  // Chromium can emit request events for CSP-blocked subresources without reaching the response route.
  expect(servedScriptAndStyle).toEqual([]);
  expect(requests.filter(({ type }) => type === "image")).toEqual([{ type: "image", url: admittedImage }]);

  // With only the simulated host policy, the same sandbox and routes must let both resources load.
  await page.locator("iframe").evaluate(async (element: HTMLIFrameElement, url) => {
    const loaded = new Promise<void>((resolve) => element.addEventListener("load", () => resolve(), { once: true }));
    element.src = url;
    await loaded;
  }, widgetWithoutDocumentCsp);
  expect(await probeExternalResources()).toEqual(["load", "load"]);
  expect(servedScriptAndStyle.sort()).toEqual([admittedStyle, admittedScript]);
});
