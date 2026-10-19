// Runs one benchmark round per stack, with only that stack running against Postgres.
// Usage: node run.mjs <round> [fixedRate] [targets...]  (optional env PHASES=fixed,sat64,sat256)
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const [round = "r1", fixedRate = "150", ...targetArgs] = process.argv.slice(2);
const targets = targetArgs.length ? targetArgs : ["node", "rust"];
const results = join(here, "results", round);
mkdirSync(results, { recursive: true });
const url = "postgresql://postgres:postgres@rustbench-pg:5432/cs_24c061bb_discovery?sslmode=disable";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const docker = (...args) => spawnSync("docker", args, { encoding: "utf8" });
const log = (msg) => console.log(new Date().toISOString(), msg);
// Optional cache variant: REDIS_URL (reachable from the rustbench network) enables the
// app's Redis cache-aside; the rustbench-redis container is flushed and sampled per phase.
const redisUrl = process.env.REDIS_URL;
const appEnv = redisUrl ? ["-e", `REDIS_URL=${redisUrl}`, "-e", `CACHE_TTL_SECONDS=${process.env.CACHE_TTL_SECONDS ?? 30}`] : [];
const redisStat = () => {
  const text = docker("exec", "rustbench-redis", "redis-cli", "INFO", "stats").stdout ?? "";
  const n = (k) => Number(new RegExp(`${k}:(\\d+)`).exec(text)?.[1] ?? 0);
  const hits = n("keyspace_hits"), misses = n("keyspace_misses");
  return { hits, misses, hitRate: hits + misses ? +(hits / (hits + misses)).toFixed(3) : null };
};

function k6(name, base, envs) {
  const args = ["run", "--rm", "--network", "rustbench", "--cpus", "4", "-v", `${here}:/bench`, "-e", `BASE=${base}`];
  for (const [k, v] of Object.entries(envs)) args.push("-e", `${k}=${v}`);
  args.push("grafana/k6:latest", "run", "--quiet", "--summary-export", `/bench/results/${round}/${name}.json`, "/bench/load.js");
  const r = docker(...args);
  writeFileSync(join(results, `${name}.log`), (r.stdout ?? "") + (r.stderr ?? ""));
}

for (const t of targets) {
  docker("stop", "rb-node", "rb-rust");
  docker("rm", "rb-node", "rb-rust");
  docker("restart", "rustbench-pg");
  if (redisUrl) docker("exec", "rustbench-redis", "redis-cli", "FLUSHALL");
  await sleep(8000);
  docker("run", "-d", "--rm", "--name", `rb-${t}`, "--network", "rustbench", "--cpus", "1", "--memory", "1g", "-e", `DATABASE_URL=${url}`, ...appEnv, `rustbench-${t}`);
  await sleep(10000);
  const base = `http://rb-${t}:8080`;
  writeFileSync(join(results, `${t}-idle-mem.txt`), docker("stats", "--no-stream", "--format", "{{.MemUsage}}", `rb-${t}`).stdout);
  log(`${t} warmup`);
  k6(`${t}-warmup`, base, { MODE: "closed", VUS: "32", DURATION: "20s" });
  for (const [phase, envs] of [
    ["fixed", { MODE: "open", RATE: fixedRate, DURATION: "60s" }],
    ["sat64", { MODE: "closed", VUS: "64", DURATION: "60s" }],
    ["sat256", { MODE: "closed", VUS: "256", DURATION: "60s" }],
  ].filter(([phase]) => !process.env.PHASES || process.env.PHASES.split(",").includes(phase))) {
    log(`${t} ${phase}`);
    if (redisUrl) docker("exec", "rustbench-redis", "redis-cli", "CONFIG", "RESETSTAT");
    const sampled = [`rb-${t}`, "rustbench-pg", ...(redisUrl ? ["rustbench-redis"] : [])];
    const sampler = spawn("node", [join(here, "sample-stats.mjs"), join(results, `${t}-${phase}-stats.json`), "62", ...sampled], { stdio: "ignore", windowsHide: true });
    k6(`${t}-${phase}`, base, envs);
    if (redisUrl) writeFileSync(join(results, `${t}-${phase}-redis.json`), JSON.stringify(redisStat()));
    await new Promise((r) => (sampler.exitCode !== null ? r() : sampler.on("exit", r)));
  }
  writeFileSync(join(results, `${t}-after-mem.txt`), docker("stats", "--no-stream", "--format", "{{.MemUsage}}", `rb-${t}`).stdout);
  docker("stop", `rb-${t}`);
}
log("done");
