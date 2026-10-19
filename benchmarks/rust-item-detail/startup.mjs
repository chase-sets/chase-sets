// Startup timing: container cold start to first HTTP 200, plus the first and second
// DB-backed item-detail request, for each image. Also times Node on the host as a
// bundled build vs tsx (how platform-api starts in production).
// Usage: node startup.mjs [iterations]   (needs rustbench-pg running on network rustbench)
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..");
const iterations = Number(process.argv[2] ?? 10);
const results = join(here, "results", "startup");
mkdirSync(results, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const docker = (...args) => spawnSync("docker", args, { encoding: "utf8", windowsHide: true });
const dbInNetwork = "postgresql://postgres:postgres@rustbench-pg:5432/cs_24c061bb_discovery?sslmode=disable";
const dbOnHost = "postgresql://postgres:postgres@localhost:55432/cs_24c061bb_discovery?sslmode=disable";

async function waitFor200(url, startedAt, limitMs = 120_000) {
  while (performance.now() - startedAt < limitMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return performance.now();
    } catch {}
    await sleep(5);
  }
  throw new Error(`no 200 from ${url} within ${limitMs} ms`);
}

async function timed(url) {
  const t = performance.now();
  const res = await fetch(url);
  await res.arrayBuffer();
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return performance.now() - t;
}

// docker logs -t stamps each line from the daemon clock, so the gap between the shell's
// "start" line and the app's listening line is in-container process start to bind.
function inContainerMs(name) {
  const lines = (docker("logs", "-t", name).stdout ?? "").split(/\r?\n/).filter(Boolean);
  const at = (re) => { const l = lines.find((x) => re.test(x)); return l ? Date.parse(l.split(" ")[0]) : NaN; };
  const ns = (re) => { const l = lines.find((x) => re.test(x)); return l ? Number(l.split(" ")[0].match(/\.(\d+)Z/)[1].padEnd(9, "0").slice(3, 9)) / 1e6 : 0; };
  return at(/ start$/) && at(/listening/) ? at(/listening/) + ns(/listening/) - (at(/ start$/) + ns(/ start$/)) : null;
}

const containerRuns = [];
const skipContainers = process.env.HOST_ONLY === "1";
const commands = { node: "cd /app && exec node server.mjs", rust: "exec /usr/local/bin/app" };
for (let i = 0; i < (skipContainers ? 0 : iterations); i += 1) {
  for (const t of ["node", "rust"]) {
    docker("rm", "-f", "rb-start");
    const t0 = performance.now();
    const run = docker("run", "-d", "--name", "rb-start", "--network", "rustbench", "-p", "18310:8080", "--cpus", "1", "--memory", "1g",
      "-e", `DATABASE_URL=${dbInNetwork}`, "--entrypoint", "sh", `rustbench-${t}`, "-c", `echo start; ${commands[t]}`);
    if (run.status !== 0) throw new Error(run.stderr);
    const tRun = performance.now();
    const tHealth = await waitFor200("http://localhost:18310/health/live", t0);
    const firstItemMs = await timed("http://localhost:18310/api/discovery/items/item_5");
    const secondItemMs = await timed("http://localhost:18310/api/discovery/items/item_5");
    const mem = (docker("stats", "--no-stream", "--format", "{{.MemUsage}}", "rb-start").stdout ?? "").trim().split(" / ")[0];
    const row = { target: t, i, dockerRunMs: tRun - t0, toFirst200Ms: tHealth - t0, inContainerToListenMs: inContainerMs("rb-start"), firstItemMs, secondItemMs, memAfterFirstRequests: mem };
    containerRuns.push(row);
    console.log(JSON.stringify(row));
  }
}
docker("rm", "-f", "rb-start");

// Host runs: same server.ts, bundled vs tsx. tsx --no-cache matches a fresh pod. The
// benchmark folder is not a workspace, so tsx runs a copy placed in platform-api, which
// resolves the same packages; its ../../../ imports still reach the repo root.
const hostRuns = [];
const tsxDir = join(repo, "deployables", "platform-api", ".bench-startup");
mkdirSync(tsxDir, { recursive: true });
copyFileSync(join(here, "node", "server.ts"), join(tsxDir, "server.ts"));
const tsxCli = join(repo, "node_modules", "tsx", "dist", "cli.mjs");
const hostVariants = {
  "node-bundle": [join(here, "node", "dist", "server.mjs")],
  "node-tsx-nocache": [tsxCli, "--no-cache", join(tsxDir, "server.ts")],
  "node-tsx-cached": [tsxCli, join(tsxDir, "server.ts")],
};
for (let i = 0; i < Math.min(iterations, 5); i += 1) {
  for (const [name, args] of Object.entries(hostVariants)) {
    const t0 = performance.now();
    const child = spawn(process.execPath, args, { env: { ...process.env, PORT: "18320", DATABASE_URL: dbOnHost }, stdio: "ignore", windowsHide: true });
    try {
      const tHealth = await waitFor200("http://localhost:18320/health/live", t0);
      const firstItemMs = await timed("http://localhost:18320/api/discovery/items/item_5");
      const row = { target: name, i, toFirst200Ms: tHealth - t0, firstItemMs };
      hostRuns.push(row);
      console.log(JSON.stringify(row));
    } finally {
      child.kill();
      await new Promise((r) => (child.exitCode !== null ? r() : child.on("exit", r)));
    }
  }
}

rmSync(tsxDir, { recursive: true, force: true });
writeFileSync(join(results, skipContainers ? "host-runs.json" : "runs.json"), JSON.stringify({ containerRuns, hostRuns }, null, 1));
console.log("done");
