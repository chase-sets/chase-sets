import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { LATEST_PROTOCOL_VERSION, McpUiInitializeRequestSchema } from "@modelcontextprotocol/ext-apps";
import { mcpWidgetResourceContent } from "@chase-sets/platform-runtime/mcp-widget-resources";
import {
  UCP_MCP_CART_REVIEW_RESOURCE_URI,
  UCP_MCP_CHECKOUT_HANDOFF_RESOURCE_URI,
} from "@chase-sets/platform-runtime/ucp";

type Checkout = Readonly<{
  continue_url?: string;
  messages?: readonly { content: string }[];
  order?: { permalink_url: string };
}>;
type Fixtures = Record<
  "unpaid" | "captured" | "unavailable" | "completed" | "canceled" | "expired" | "notFound",
  Checkout
>;
type AppMessage = { method: string; params?: unknown };

const host = "https://host.example.test/";

// Handler-produced rows from the Checkout context (agent-checkout-fixtures.test.ts keeps them current).
async function readFixtures(): Promise<Fixtures> {
  const file = new URL(
    "../../../bounded-contexts/checkout/features/sessions/ui/agent-checkout-fixtures.json",
    import.meta.url,
  );
  return JSON.parse(await readFile(file, "utf8")) as Fixtures;
}

function firstMessage(checkout: Checkout): string {
  const content = checkout.messages?.[0]?.content;
  if (!content) throw new Error("Fixture row has no message.");
  return content;
}

async function openWidget(page: Page, entry: "cart-review" | "checkout-handoff", uri: string) {
  const widget = `https://widget.example.test/${entry}.html`;
  const html = await readFile(new URL(`../build/${entry}.html`, import.meta.url), "utf8");
  const resource = mcpWidgetResourceContent(new Request("https://marketplace.example/"), uri, html, entry);
  expect(resource._meta.ui.csp).toEqual({ connectDomains: [], resourceDomains: [] });
  // The host policy the empty resource domains produce; the document CSP narrows it to the bundle hashes.
  const hostCsp = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; font-src data:";

  const requests: string[] = [];
  page.on("request", (request) => requests.push(request.url()));
  await page.route("**/*", async (route) => {
    switch (route.request().url()) {
      case host:
        return route.fulfill({ contentType: "text/html", body: "<!doctype html><title>MCP Apps test host</title>" });
      case widget:
        return route.fulfill({
          contentType: "text/html",
          headers: { "content-security-policy": hostCsp },
          body: resource.text,
        });
      default:
        return route.abort();
    }
  });

  const messages: AppMessage[] = [];
  await page.exposeFunction("observeAppMessage", (message: AppMessage) => {
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

  const frame = page.frameLocator("iframe");
  const showResult = (checkout: Checkout) =>
    page.evaluate(
      (params) => {
        document
          .querySelector("iframe")
          ?.contentWindow?.postMessage({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params }, "*");
      },
      {
        structuredContent: checkout,
        content: [{ type: "text", text: JSON.stringify(checkout) }],
      },
    );
  const expectSandboxed = async () => {
    await expect(frame.locator("a")).toHaveCount(0);
    expect(messages.map(({ method }) => method)).not.toContain("tools/call");
    expect(requests.filter((url) => url !== host && url !== widget)).toEqual([]);
  };
  return { frame, messages, initialize, showResult, expectSandboxed };
}

test("renders handler checkout fixtures in the sandboxed cart review @agent-apps", async ({ page }) => {
  const fixtures = await readFixtures();
  const { frame, initialize, showResult, expectSandboxed } = await openWidget(
    page,
    "cart-review",
    UCP_MCP_CART_REVIEW_RESOURCE_URI,
  );
  expect(initialize.params).toMatchObject({
    protocolVersion: LATEST_PROTOCOL_VERSION,
    appInfo: { name: "Chase Sets Cart Review", version: "2.0.0" },
  });
  await expect(frame.locator("[data-chase-theme]")).toHaveAttribute("data-color-mode", "dark");

  await showResult(fixtures.unpaid);
  await expect(frame.getByText(firstMessage(fixtures.unpaid))).toBeVisible();
  await expect(frame.getByText("Charizard", { exact: true })).toBeVisible();
  await expect(frame.getByText("$26.49").first()).toBeVisible();
  await expect(frame.locator("main > .flex").first()).toHaveCSS("display", "flex");
  // No continue action is bound in the M1 handoff.
  await expect(frame.getByRole("button", { name: "Continue checkout" })).toHaveCount(0);

  await showResult(fixtures.notFound);
  await expect(frame.getByText("Chase Sets could not load this checkout")).toBeVisible();
  await expectSandboxed();
});

test("hands off handler checkout fixtures through ui/open-link @agent-apps", async ({ page }) => {
  const fixtures = await readFixtures();
  const { frame, messages, initialize, showResult, expectSandboxed } = await openWidget(
    page,
    "checkout-handoff",
    UCP_MCP_CHECKOUT_HANDOFF_RESOURCE_URI,
  );
  expect(initialize.params).toMatchObject({
    protocolVersion: LATEST_PROTOCOL_VERSION,
    appInfo: { name: "Chase Sets Checkout Handoff", version: "2.0.0" },
  });
  await expect(frame.locator("[data-chase-theme]")).toHaveAttribute("data-color-mode", "dark");
  const continueAction = frame.getByRole("button", { name: "Continue on Chase Sets" });
  const opened = () => messages.filter(({ method }) => method === "ui/open-link").map(({ params }) => params);

  await showResult(fixtures.unpaid);
  await expect(frame.getByText(firstMessage(fixtures.unpaid))).toBeVisible();
  await expect(frame.locator("main > .flex").first()).toHaveCSS("display", "flex");
  await continueAction.click();
  await expect.poll(opened).toEqual([{ url: fixtures.unpaid.continue_url }]);

  await showResult(fixtures.captured);
  await expect(frame.getByText("Payment is processing")).toBeVisible();
  await expect(frame.getByText("Order confirmed")).toHaveCount(0);
  await expect(continueAction).toHaveCount(0);

  await showResult(fixtures.unavailable);
  await expect(frame.getByText(firstMessage(fixtures.unavailable))).toBeVisible();
  await expect(frame.getByText("Charizard", { exact: true })).toBeVisible();
  await expect(continueAction).toHaveCount(0);

  await showResult(fixtures.completed);
  await expect(frame.getByText("Order confirmed")).toBeVisible();
  await expect(continueAction).toHaveCount(0);
  await frame.getByRole("button", { name: "View order on Chase Sets" }).click();
  await expect
    .poll(opened)
    .toEqual([{ url: fixtures.unpaid.continue_url }, { url: fixtures.completed.order?.permalink_url }]);

  for (const [row, title] of [
    ["canceled", "Checkout canceled"],
    ["expired", "Checkout expired"],
    ["notFound", "Chase Sets could not prepare this checkout"],
  ] as const) {
    await showResult(fixtures[row]);
    await expect(frame.getByText(title)).toBeVisible();
    await expect(continueAction).toHaveCount(0);
  }
  expect(opened()).toHaveLength(2);
  await expectSandboxed();
});
