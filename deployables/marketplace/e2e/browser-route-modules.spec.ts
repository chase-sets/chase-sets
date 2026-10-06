import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test, type APIRequestContext } from "@playwright/test";
import ts from "@chase-sets/typescript-compiler-api";
import { marketplaceBrowserE2eSeedContract } from "./support/seed-contract";

const routes = [
  { entry: "account-desk-offers", path: "/account/desk/offers", input: "pointer" },
  { entry: "account-sell-list", path: "/account/sell-list", input: "keyboard" },
] as const;

async function builtRouteAsset(entry: string) {
  const directory = resolve("deployables/marketplace/build/client/assets");
  const assets = await readdir(directory);
  const matches: string[] = [];
  for (const filename of assets.filter((name) => /^manifest-.*\.js$/.test(name))) {
    const source = await readFile(resolve(directory, filename), "utf8");
    const ast = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    for (const statement of ast.statements) {
      if (!ts.isExpressionStatement(statement) || !ts.isBinaryExpression(statement.expression)) continue;
      const assignment = statement.expression;
      if (assignment.left.getText(ast) !== "window.__reactRouterManifest") continue;
      const manifest: { routes: Record<string, { id: string; module: string }> } = JSON.parse(
        assignment.right.getText(ast),
      );
      for (const route of Object.values(manifest.routes)) {
        if (route.id === `checkout/${entry}`) matches.push(route.module);
      }
    }
  }
  expect(matches, `${entry} must resolve to exactly one production-built hashed asset`).toHaveLength(1);
  expect(matches[0]).toMatch(new RegExp(`^/assets/${entry}-[^/]+\\.js$`));
  return matches[0];
}

async function builtClientGraph(request: APIRequestContext, entry: string, origin: string) {
  const pending = [new URL(entry, origin).href];
  const graph: Array<{ url: string; imports: string[]; forbidden: string[] }> = [];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const url = pending.pop()!;
    if (visited.has(url)) continue;
    visited.add(url);
    const response = await request.get(url);
    expect(response.status(), `built client asset ${url}`).toBe(200);
    const source = await response.text();
    const ast = ts.createSourceFile(url, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const imports: string[] = [];
    const visit = (node: ts.Node) => {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
      ) {
        imports.push(node.moduleSpecifier.text);
      }
      if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.arguments[0] &&
        ts.isStringLiteral(node.arguments[0])
      ) {
        imports.push(node.arguments[0].text);
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
    const forbidden = [
      "__vite-browser-external",
      "getNodeAutoInstrumentations",
      "@opentelemetry",
      "pg-protocol",
      "PostgresError",
      "catalog-seed",
      "iVBORw0KGgoAAAANSUhEUg",
      "Buffer.from",
    ].filter((marker) => source.includes(marker));
    forbidden.push(...imports.filter((specifier) => /^(?:node:|pg(?:\/|$)|@opentelemetry\/)/.test(specifier)));
    graph.push({ url, imports, forbidden });
    for (const specifier of imports) {
      expect(specifier, `client import from ${url}`).toMatch(/^(?:\.|\/)/);
      const dependency = new URL(specifier, url);
      expect(dependency.origin).toBe(origin);
      if (dependency.pathname.endsWith(".js")) pending.push(dependency.href);
    }
  }
  return graph;
}

for (const route of routes) {
  test(`${route.entry} evaluates its production module graph @marketplace-checkout`, async ({
    browser,
    baseURL,
  }, testInfo) => {
    expect(baseURL).toBeTruthy();
    const context = await browser.newContext({ baseURL });
    try {
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto("/health/ready");
      const origin = new URL(page.url()).origin;
      const asset = await builtRouteAsset(route.entry);
      const graph = await builtClientGraph(context.request, asset, origin);
      await testInfo.attach("built-client-graph", {
        body: JSON.stringify(graph, null, 2),
        contentType: "application/json",
      });
      const imported = await page.evaluate(async (url) => {
        const module = await import(url);
        return typeof module.default === "function";
      }, new URL(asset, origin).href);
      await testInfo.attach("route-module-evaluation", {
        body: JSON.stringify({
          sourceHead: process.env.OPERATOR_EVIDENCE_SOURCE_HEAD ?? null,
          asset,
          imported,
          errors,
        }),
        contentType: "application/json",
      });
      expect(imported).toBe(true);
      expect(errors).toEqual([]);
      expect(graph.flatMap(({ url, forbidden }) => forbidden.map((marker) => ({ url, marker })))).toEqual([]);
    } finally {
      await context.close();
    }
  });

  test(`${route.entry} hydrates populated guest line review with ${route.input} @marketplace-checkout`, async ({
    page,
    context,
    baseURL,
  }, testInfo) => {
    expect(baseURL).toBeTruthy();
    const guest = `anon_${randomUUID()}`;
    await context.addCookies([
      { name: "chase_sets_anonymous_sell_list", value: guest, url: baseURL!, httpOnly: true, sameSite: "Lax" },
    ]);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    await page.goto(`${marketplaceBrowserE2eSeedContract.itemDetail.selectedProductRoutePath}&market=sell`);
    await page
      .getByRole("button", { name: /Selected product.*Save the selected product for Sell List review/ })
      .click();
    const add = page.getByRole("button", { name: "Add product to Sell List", exact: true });
    await expect(add).toBeVisible();
    await add.click();
    await expect(page).toHaveURL(/\/account\/sell-list/);
    let lineId: string | null = null;
    try {
      const readback = await context.request.get("/api/marketplace/guest/sell-list", {
        headers: { "x-checkout-anonymous-sell-list-id": guest },
      });
      expect(readback.status()).toBe(200);
      const saved: {
        items: Array<{ line_id: string; catalog_catalog_item_id: string; item_title: string; quantity: number }>;
      } = await readback.json();
      expect(saved.items).toHaveLength(1);
      lineId = saved.items[0].line_id;
      expect(saved.items[0]).toMatchObject({
        catalog_catalog_item_id: marketplaceBrowserE2eSeedContract.itemDetail.catalogItemId,
        item_title: "Charizard",
        quantity: 1,
      });
      const response = await page.goto(route.path);
      expect(response?.status()).toBe(200);
      expect(new URL(page.url()).pathname).toBe(route.path);
      await expect(page.getByRole("heading", { name: "Sell List", exact: true })).toBeVisible();
      const review = page.getByRole("button", { name: "Review Charizard offers and terms", exact: true });
      await expect(review).toHaveCount(1);
      await expect(page.getByRole("dialog")).toHaveCount(0);
      if (route.input === "pointer") await review.click();
      else {
        await review.focus();
        await expect(review).toBeFocused();
        await page.keyboard.press("Enter");
      }
      const dialog = page.getByRole("dialog", { name: "Charizard offers and terms", exact: true });
      await expect(dialog).toBeVisible();
      await expect(
        dialog
          .locator("dt")
          .filter({ hasText: /^Quantity$/ })
          .locator("..")
          .locator("dd"),
      ).toHaveText("1");
      const identity = dialog.locator('input[name="lineId"]');
      await expect(identity).toHaveCount(1);
      await expect(identity).toHaveValue(lineId);
      await testInfo.attach("hydrated-populated-review", {
        body: JSON.stringify({
          sourceHead: process.env.OPERATOR_EVIDENCE_SOURCE_HEAD ?? null,
          route: route.path,
          guest,
          lineId,
          input: route.input,
          errors,
        }),
        contentType: "application/json",
      });
      await testInfo.attach("populated-review", { body: await page.screenshot(), contentType: "image/png" });
      expect(errors).toEqual([]);
      await dialog.getByRole("button", { name: "Remove", exact: true }).click();
      await expect(page.getByText("Your Sell List is empty", { exact: true })).toBeVisible();
      lineId = null;
      expect(errors).toEqual([]);
    } finally {
      if (lineId) {
        const cleanup = await context.request.post(route.path, {
          form: { intent: "remove-sell-list-line", lineId },
        });
        expect(cleanup.ok(), "remove only the isolated guest's test line").toBe(true);
      }
    }
  });
}
