// Loads every page an app serves at a fixed address (each `#[route("..", get = ..)]` without a
// parameter) twice: on a phone (390 px) without JavaScript and on a desktop (1280 px) with it, and
// reports each load whose page is wider than the screen (with the element furthest out), that
// answers 400 or more, that does not load, or that logs a console error. It only reads, so run it
// against a dev system with synthetic data. Files that are not pages (CSV, XML, the manifest), live
// streams and downloads are left out.
// Usage: node scripts/sweep.mjs <admin|marketplace|public> <pilot-url> [state-file]   (state from scripts/sign-in.mjs)
// Exits 1 when a page overflows; a status or a console error is reported for a person to judge,
// since some are by design (a page that needs a parameter answers 400 or 404 without one).
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const [app, base, stateFile] = process.argv.slice(2);
if (!["admin", "marketplace", "public"].includes(app) || !base) {
  console.error("usage: node scripts/sweep.mjs <admin|marketplace|public> <pilot-url> [state-file]");
  process.exit(2);
}
const src = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", app, "src");
const code = readdirSync(src, { recursive: true })
  .filter((file) => String(file).endsWith(".rs") && !String(file).endsWith("tests.rs"))
  .map((file) => readFileSync(path.join(src, String(file)), "utf8"))
  .join("\n");
const notPages = /\.(csv|svg|ico|xml|txt|json|webmanifest|js)$|\/live$|\/export$|\/download|^\/sign-out$|^\/ucp\//;
const pages = [
  ...new Set(
    [...code.matchAll(/#\[route\(\s*"([^"]+)"\s*,([^\]]*)\]/g)]
      .filter(([, address, methods]) => /\bget\s*=/.test(methods) && !address.includes("{") && !notPages.test(address))
      .map(([, address]) => address),
  ),
].sort();

const browser = await chromium.launch();
const problems = [];
let overflowing = 0;
for (const [width, javaScriptEnabled] of [
  [390, false],
  [1280, true],
]) {
  const context = await browser.newContext({
    viewport: { width, height: 900 },
    javaScriptEnabled,
    ...(stateFile ? { storageState: stateFile } : {}),
  });
  for (const address of pages) {
    const page = await context.newPage();
    const errors = [];
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text().slice(0, 140));
    });
    const load = { width, javaScript: javaScriptEnabled, address };
    try {
      const response = await page.goto(base + address, { waitUntil: "load", timeout: 45_000 });
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      if (overflow > 0) {
        overflowing += 1;
        load.overflow = overflow;
        load.widest = await page.evaluate(() => {
          let widest = null;
          for (const element of document.querySelectorAll("body *")) {
            const right = element.getBoundingClientRect().right;
            if (right > document.documentElement.clientWidth + 1 && (!widest || right > widest.right)) {
              widest = { right, tag: element.tagName, class: String(element.className).slice(0, 60) };
            }
          }
          return widest;
        });
      }
      if (response.status() >= 400) load.status = response.status();
      if (new URL(page.url()).pathname !== address) load.landed = new URL(page.url()).pathname;
      if (errors.length) load.errors = errors;
    } catch (error) {
      load.failed = error.message.split("\n")[0].slice(0, 140);
    }
    if (load.overflow || load.status || load.errors || load.failed) problems.push(load);
    await page.close();
  }
  await context.close();
}
await browser.close();
console.log(`${app}: ${pages.length} pages, ${pages.length * 2} loads, ${overflowing} wider than the screen`);
for (const load of problems) console.log(JSON.stringify(load));
process.exit(overflowing ? 1 : 0);
