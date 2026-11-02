// What one change to a catalog list costs the tab that shows it: the bytes the tab receives
// (server-sent event data and the fetches it makes because of the change) and the main-thread
// time of the update, in the pilot and in admin-web. One tab watches the dimensions list
// filtered to the run's prefix; another creates a dimension through the pilot. It writes to the
// dev sandbox's data. Runs `runs` changes per app and prints the medians.
// Usage: node scripts/measure-live.mjs pilot=http://localhost:7790 admin-web=http://localhost:7752 [runs=5] [state=...]
import { chromium } from "@playwright/test";

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.split("=")));
const pilot = args.pilot ?? "http://localhost:7790";
const runs = Number(args.runs ?? 5);
const stateFile = args.state ?? "../../artifacts/corten-pilot/admin-state.json";
const targets = Object.entries({ pilot, "admin-web": args["admin-web"] }).filter(([, url]) => url);
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const browser = await chromium.launch();
const ctx = await browser.newContext({ storageState: stateFile });
const other = await ctx.newPage();
other.setDefaultTimeout(30_000);
const result = {};

for (const [name, base] of targets) {
  const prefix = `m_${Date.now().toString(36)}`;
  const watch = await ctx.newPage();
  watch.setDefaultTimeout(60_000);
  const cdp = await ctx.newCDPSession(watch);
  await cdp.send("Network.enable");
  await cdp.send("Performance.enable");
  let sse = 0;
  const fetched = new Map();
  cdp.on("Network.eventSourceMessageReceived", (e) => (sse += Buffer.byteLength(e.data) + e.eventName.length));
  cdp.on("Network.requestWillBeSent", (e) => e.type === "Fetch" && fetched.set(e.requestId, 0));
  cdp.on(
    "Network.dataReceived",
    (e) => fetched.has(e.requestId) && fetched.set(e.requestId, fetched.get(e.requestId) + e.dataLength),
  );
  await watch.goto(`${base}/catalog/dimensions?search=${prefix}`);
  await watch.waitForLoadState("load");
  await watch.waitForTimeout(2_000);
  const samples = [];
  for (let i = 0; i < runs; i++) {
    const key = `${prefix}_${i}`;
    const metric = async () =>
      Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map((m) => [m.name, m.value]));
    sse = 0;
    fetched.clear();
    const before = await metric();
    await other.goto(`${pilot}/catalog/dimensions`);
    await other.getByRole("button", { name: "New Dimension" }).click();
    const dialog = other.locator("#catalog-create-dialog");
    await dialog.getByLabel("Key").fill(key);
    await dialog.getByLabel("Name").fill(`Measure ${key}`);
    await dialog.getByLabel("Value Kind").selectOption("ordered");
    const started = Date.now();
    await dialog.getByRole("button", { name: "Create" }).click();
    await watch.getByRole("row", { name: new RegExp(key) }).waitFor();
    const shown = Date.now() - started;
    await watch.waitForTimeout(1_500); // the rest of the update settles
    const after = await metric();
    const fetchBytes = [...fetched.values()].reduce((a, b) => a + b, 0);
    samples.push({
      shown,
      sse,
      fetches: fetched.size,
      fetchBytes,
      scriptMs: Math.round((after.ScriptDuration - before.ScriptDuration) * 1000),
      taskMs: Math.round((after.TaskDuration - before.TaskDuration) * 1000),
    });
  }
  await watch.close();
  const med = (k) => median(samples.map((s) => s[k]));
  result[name] = {
    runs,
    samples,
    median: {
      shownMs: med("shown"),
      sseBytes: med("sse"),
      fetches: med("fetches"),
      fetchBytes: med("fetchBytes"),
      scriptMs: med("scriptMs"),
      taskMs: med("taskMs"),
    },
  };
  console.log(name, JSON.stringify(result[name].median));
}

await browser.close();
console.log(JSON.stringify(result, null, 2));
