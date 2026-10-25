import { createServer } from "vite";
import tailwindcss from "@tailwindcss/vite";
import { expect, test } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { createWorkspaceSourceAliases } from "../../../../scripts/workspace-source-aliases.mjs";

const root = resolve(import.meta.dirname, "../../../..");
const entry = fileURLToPath(
  new URL(
    "../../../../bounded-contexts/catalog/features/operator-session/tests/operator-extension-popup-screenshots-entry.tsx",
    import.meta.url,
  ),
).replaceAll("\\", "/");

test("captures the four synthetic popup component states @tcgplayer-operator-extension", async ({ page }, testInfo) => {
  page.on("pageerror", (error) => console.log(`Synthetic popup pageerror: ${error.stack ?? error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") console.log(`Synthetic popup console error: ${message.text()}`);
  });
  const server = await createServer({
    root,
    configFile: false,
    appType: "custom",
    resolve: { alias: createWorkspaceSourceAliases() },
    plugins: [tailwindcss()],
    server: { host: "127.0.0.1", port: 0, fs: { allow: [root] } },
  });
  server.middlewares.use(async (request, response, next) => {
    if (!request.url?.startsWith("/synthetic-operator-popup.html")) return next();
    response.setHeader("content-type", "text/html");
    response.end(
      await server.transformIndexHtml(
        request.url,
        `<!doctype html><html><head><title>Synthetic SetNames popup</title></head><body><div id="root"></div><script type="module" src="/@fs/${entry}"></script></body></html>`,
      ),
    );
  });
  console.log(`Synthetic popup fixture entry: ${entry}`);
  await server.listen();
  console.log("Synthetic popup server listening");
  try {
    const address = server.httpServer!.address();
    if (typeof address !== "object" || address === null) throw new Error("loopback server missing");
    const origin = `http://127.0.0.1:${address.port}`;
    console.log(`Synthetic popup origin: ${origin}`);
    await page.route("**/*", (route) => (route.request().url().startsWith(origin) ? route.continue() : route.abort()));
    for (const state of ["empty", "loading", "error", "success"]) {
      console.log(`Synthetic popup goto: ${state}`);
      await page.goto(`${origin}/synthetic-operator-popup.html?state=${state}`, { waitUntil: "commit" });
      console.log(`Synthetic popup committed: ${state}`);
      await page.screenshot({ path: testInfo.outputPath(`popup-debug-${state}.png`), fullPage: true });
      if ((await page.getByRole("heading", { name: "TCGplayer SetNames probe" }).count()) === 0) {
        await testInfo.attach(`popup-debug-${state}.html`, {
          body: await page.content(),
          contentType: "text/html",
        });
      }
      await expect(page.getByRole("heading", { name: "TCGplayer SetNames probe" })).toBeVisible();
      if (state === "empty") {
        for (const input of await page.locator('input[inputmode="numeric"]').all()) await input.fill("");
        await expect(page.getByText("Enter at least one product-line id to run the probe.")).toBeVisible();
        await expect(page.getByRole("button", { name: "Run probe" })).toBeDisabled();
      } else {
        await page.getByRole("button", { name: "Run probe" }).click();
        if (state === "loading") await expect(page.getByRole("button", { name: "Running probe…" })).toBeDisabled();
        if (state === "error") await expect(page.getByRole("alert")).toContainText("http-not-success");
        if (state === "success") {
          await expect(page.getByLabel("Report", { exact: true })).toBeVisible();
          await expect(page.getByText("Canonical report SHA-256:")).toBeVisible();
          await expect(page.getByRole("button", { name: "Copy report" })).toBeVisible();
        }
      }
      const screenshot = testInfo.outputPath(`popup-${state}.png`);
      await page.screenshot({ path: screenshot, fullPage: true });
      await testInfo.attach(`popup-${state}.png`, { path: screenshot, contentType: "image/png" });
    }
  } finally {
    await server.close();
  }
});
