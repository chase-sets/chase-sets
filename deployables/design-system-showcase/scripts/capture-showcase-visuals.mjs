import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "../../..");
const outputDir = resolve(repoRoot, "artifacts/showcase-visuals");
const baseUrl = process.env.CHASE_SHOWCASE_BASE_URL ?? "http://127.0.0.1:6171";

const chromeCandidates = [
  process.env.CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser"
].filter(Boolean);

const chromePath = chromeCandidates.find((candidate) => existsSync(candidate));

if (!chromePath) {
  throw new Error("No Chrome or Edge executable found. Set CHROME_PATH to capture visuals.");
}

const routes = [
  { name: "marketplace", path: "/" },
  { name: "admin", path: "/admin" },
  { name: "checkout", path: "/checkout" },
  { name: "components", path: "/components" }
];

const viewports = [
  { name: "desktop", size: "1440,1800" },
  { name: "mobile", size: "500,1400" }
];

mkdirSync(outputDir, { recursive: true });

for (const route of routes) {
  for (const viewport of viewports) {
    const output = resolve(outputDir, `${route.name}-${viewport.name}.png`);
    const url = new URL(route.path, baseUrl).toString();
    execFileSync(chromePath, [
      "--headless=new",
      "--disable-gpu",
      "--force-device-scale-factor=1",
      `--window-size=${viewport.size}`,
      `--screenshot=${output}`,
      url
    ], { stdio: "pipe" });
    console.log(`Captured ${route.name} ${viewport.name}: ${output}`);
  }
}
