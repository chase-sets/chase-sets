// SSR load for both web apps, one at a time, against the same Rust API (Redis-warm).
// Usage: node run-ssr.mjs <round> [fixedRate] [apps, e.g. react,bun-express,bun-native]
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const sampler = join(here, "..", "rust-item-detail", "sample-stats.mjs");
const [round = "ssr-r1", fixedRate = "150", appsArg = "react,leptos"] = process.argv.slice(2);
const results = join(here, "results", round);
mkdirSync(results, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const docker = (...args) => spawnSync("docker", args, { encoding: "utf8" });
const log = (msg) => console.log(new Date().toISOString(), msg);
const catalog = {
  react: { name: "fsw-react", image: "fsw-react-router", port: 18401 },
  leptos: { name: "fsw-leptos", image: "fsw-leptos", port: 18402 },
  "node-webstreams": { name: "fsw-node-web", image: "fsw-react-node-web", port: 18405 },
  "node-native": { name: "fsw-node-native", image: "fsw-react-node-web", port: 18406, cmd: ["node", "server-node-native.mjs"] },
  "bun-express": { name: "fsw-bun-express", image: "fsw-react-bun", port: 18403 },
  "bun-native": { name: "fsw-bun-native", image: "fsw-react-bun", port: 18404, cmd: ["bun", "server-bun.mjs"] },
};
const apps = Object.fromEntries(appsArg.split(",").map((a) => [a, catalog[a]]));

function k6(name, base, envs) {
  const args = ["run", "--rm", "--network", "rustbench", "--cpus", "4", "-v", `${here}:/bench`, "-e", `BASE=${base}`];
  for (const [k, v] of Object.entries(envs)) args.push("-e", `${k}=${v}`);
  args.push("grafana/k6:latest", "run", "--quiet", "--summary-export", `/bench/results/${round}/${name}.json`, "/bench/ssr-load.js");
  const r = docker(...args);
  writeFileSync(join(results, `${name}.log`), (r.stdout ?? "") + (r.stderr ?? ""));
}

for (const [app, { name, image, port, cmd = [] }] of Object.entries(apps)) {
  for (const other of Object.values(catalog)) docker("rm", "-f", other.name);
  await sleep(3000);
  const started = Date.now();
  docker("run", "-d", "--name", name, "--network", "rustbench", "--cpus", "1", "--memory", "1g", "-p", `${port}:8080`, "-e", "API_BASE=http://rb-rust:8080", image, ...cmd);
  let ready = null;
  for (let i = 0; i < 400 && ready === null; i += 1) {
    try { const r = await fetch(`http://localhost:${port}/items/item_1`); if (r.ok) ready = Date.now() - started; } catch {}
    if (ready === null) await sleep(25);
  }
  await sleep(5000);
  const idle = docker("stats", "--no-stream", "--format", "{{.MemUsage}}", name).stdout.trim();
  writeFileSync(join(results, `${app}-startup.json`), JSON.stringify({ firstOkMsFromDockerRun: ready, idleMem: idle }, null, 1));
  const base = `http://${name}:8080`;
  log(`${app} warmup`);
  k6(`${app}-warmup`, base, { MODE: "closed", VUS: "32", DURATION: "20s" });
  for (const [phase, envs] of [
    ["fixed", { MODE: "open", RATE: fixedRate, DURATION: "60s" }],
    ["sat64", { MODE: "closed", VUS: "64", DURATION: "60s" }],
    ["sat256", { MODE: "closed", VUS: "256", DURATION: "60s" }],
  ]) {
    log(`${app} ${phase}`);
    const s = spawn("node", [sampler, join(results, `${app}-${phase}-stats.json`), "62", name, "rb-rust"], { stdio: "inherit" });
    k6(`${app}-${phase}`, base, envs);
    await new Promise((r) => s.on("exit", r));
  }
}
log("done");
