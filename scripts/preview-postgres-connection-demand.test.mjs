import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { previewPostgresDemand } from "./lib/browser-e2e-postgres-demand.mjs";
import { repoRoot } from "./lib/repo.mjs";

const runtimeValuesPath = "infrastructure/helm/platform/runtime-values.json";
const readSource = (file) => readFileSync(path.join(repoRoot, file), "utf8");
const withRuntimeValues = (mutate) => (file) => {
  if (file !== runtimeValuesPath) return readSource(file);
  const values = JSON.parse(readSource(file));
  mutate(values);
  return JSON.stringify(values);
};
const withSource = (target, edit) => (file) => (file === target ? edit(readSource(file)) : readSource(file));
const envEntry = (values, component, name) => values.components[component].env.find((entry) => entry.name === name);
const sum = (rows) => rows.reduce((total, row) => total + row.max, 0);

describe("preview Postgres connection demand (#10022)", () => {
  it("admits every connection the preview workloads can open", () => {
    const { inventory, phaseDemand, demand, settings } = previewPostgresDemand();
    const reservations = settings.superuser_reserved_connections + settings.reserved_connections;
    const usable = settings.max_connections - reservations;
    const fits = (capacity) => capacity - reservations >= demand + 8;
    const evidence = `${JSON.stringify({ inventory, phaseDemand, demand, settings, usable, margin: usable - demand }, null, 2)}\n`;
    const evidenceDirectory = path.join(repoRoot, "artifacts", "preview-postgres");
    mkdirSync(evidenceDirectory, { recursive: true });
    writeFileSync(path.join(evidenceDirectory, "connection-demand.json"), evidence);
    process.stdout.write(evidence);

    expect(fits(settings.max_connections)).toBe(true);
    expect(usable - demand).toBeGreaterThanOrEqual(8);
    expect(settings.max_connections).toBe(50 * Math.ceil((demand + reservations + 8) / 50));
    expect(fits(100)).toBe(false);
    expect(fits(demand + reservations - 1)).toBe(false);
  });

  it("inventories each preview process from its rendered pool maximum, deduping aliases only within a process", () => {
    const { inventory, phaseDemand, demand } = previewPostgresDemand();
    const values = JSON.parse(readSource(runtimeValuesPath));
    const renderedMaximum = (component) => Number(envEntry(values, component, "DATABASE_POOL_MAX").value);
    const rows = (process, reason) =>
      inventory.filter((row) => row.process === process && (!reason || row.reason === reason));

    expect([...new Set(inventory.map((row) => row.process))].sort()).toEqual([
      "marketplace",
      "platform-api",
      "platform-api exec representative-commerce-state:production",
      "platform-bootstrap",
      "platform-worker",
      "preview-postgres snapshot",
    ]);
    for (const process of ["platform-api", "platform-worker"]) {
      const pools = rows(process, "context + control pools");
      expect(pools.every((row) => row.max === renderedMaximum(process))).toBe(true);
      // Waiter and work-signal URLs alias their context/control database inside the process.
      expect(new Set(pools.map((row) => row.pool)).size).toBe(pools.length);
    }
    const apiPools = new Set(rows("platform-api", "context + control pools").map((row) => row.pool));
    const workerPools = rows("platform-worker", "context + control pools").map((row) => row.pool);
    expect(workerPools.filter((pool) => apiPools.has(pool)).length).toBeGreaterThan(0);
    expect(rows("platform-worker", "settlement schema bootstrap beside the worker pools")).toHaveLength(1);
    expect(rows("platform-api", "default post-write token store")).toEqual([
      expect.objectContaining({ max: renderedMaximum("platform-api"), phase: "runtime" }),
    ]);
    expect(rows("marketplace", "default post-write token store")).toEqual([
      expect.objectContaining({ phase: "runtime" }),
    ]);
    expect(rows("platform-bootstrap").every((row) => row.phase === "bootstrap")).toBe(true);
    expect(inventory.filter((row) => row.reason === "projection wake relay listener")).toEqual([]);
    expect(inventory.some((row) => /scenario/i.test(row.process))).toBe(false);
    expect(inventory.every((row) => /^[\w./-]+(?::\d+)?$/.test(row.source))).toBe(true);
    expect(phaseDemand).toEqual({
      bootstrap: sum(inventory.filter((row) => row.phase === "bootstrap")),
      runtime: sum(inventory.filter((row) => row.phase === "runtime")),
    });
    expect(demand).toBe(phaseDemand.runtime);
  });

  it("raises demand for a distinct pool or a larger rendered maximum, not for an alias", () => {
    const baseline = previewPostgresDemand();
    const added = previewPostgresDemand({
      readSource: withSource("deployables/platform-worker/src/database-pools.ts", (source) =>
        source.replace(
          "return createContextPools(platformWorkerPoolRegistry, config);",
          'createPgPool("postgresql://synthetic@localhost/synthetic_distinct", { max: 7 }); return createContextPools(platformWorkerPoolRegistry, config);',
        ),
      ),
    });
    expect(added.demand).toBe(baseline.demand + 7);
    const larger = previewPostgresDemand({
      readSource: withRuntimeValues((values) => {
        const entry = envEntry(values, "platform-worker", "DATABASE_POOL_MAX");
        entry.value = String(Number(entry.value) + 1);
      }),
    });
    const workerPools = baseline.inventory.filter(
      (row) => row.process === "platform-worker" && row.reason === "context + control pools",
    );
    expect(larger.demand).toBe(baseline.demand + workerPools.length);
    const aliased = previewPostgresDemand({
      readSource: withRuntimeValues((values) => {
        expect(envEntry(values, "platform-api", "DATABASE_URL_ORDERING_WAITER")).toBeUndefined();
        values.components["platform-api"].env.push({ name: "DATABASE_URL_ORDERING_WAITER", secret: true });
      }),
    });
    expect(aliased.demand).toBe(baseline.demand);
    expect(aliased.inventory).toHaveLength(baseline.inventory.length);
  });

  it("counts relay listeners only when the worker renders the relay enabled with listener URLs", () => {
    const baseline = previewPostgresDemand();
    const values = JSON.parse(readSource(runtimeValuesPath));
    expect(envEntry(values, "platform-worker", "WORKER_PROJECTION_WAKE_RELAY_ENABLED").value).toBe("false");
    const listeners = values.components["platform-worker"].env.filter((entry) =>
      entry.name.startsWith("WORKER_LISTENER_DATABASE_URL_"),
    );
    expect(listeners.length).toBeGreaterThan(0);
    const enable = (dropListeners) =>
      withRuntimeValues((candidate) => {
        envEntry(candidate, "platform-worker", "WORKER_PROJECTION_WAKE_RELAY_ENABLED").value = "true";
        if (dropListeners) {
          candidate.components["platform-worker"].env = candidate.components["platform-worker"].env.filter(
            (entry) => !entry.name.startsWith("WORKER_LISTENER_DATABASE_URL_"),
          );
        }
      });
    const enabled = previewPostgresDemand({ readSource: enable(false) });
    expect(enabled.inventory.filter((row) => row.reason === "projection wake relay listener")).toHaveLength(
      listeners.length,
    );
    expect(enabled.demand).toBe(baseline.demand + listeners.length);
    expect(previewPostgresDemand({ readSource: enable(true) }).demand).toBe(baseline.demand);
  });

  it("refuses demand inputs it cannot account for", () => {
    expect(() =>
      previewPostgresDemand({
        readSource: withSource(".github/workflows/platform-pr.yml", (source) =>
          source.replace(
            '--runtime-env "DEPLOYMENT_ENVIRONMENT=preview"',
            '--runtime-env "DEPLOYMENT_ENVIRONMENT=preview" --runtime-env "DATABASE_POOL_MAX=2"',
          ),
        ),
      }),
    ).toThrow(
      "Preview deploy overrides a connection demand input: .github/workflows/platform-pr.yml: DATABASE_POOL_MAX",
    );
    expect(() =>
      previewPostgresDemand({
        readSource: withSource(".github/workflows/platform-merge-gate-verification.yml", (source) =>
          source.replace(
            "run representative-commerce-state:production",
            "run representative-commerce-state:production\n          kubectl exec pod -- pnpm --filter @chase-sets/app-platform-api run admin-qa-actor-fixtures:production",
          ),
        ),
      }),
    ).toThrow("Unaccounted in-pod preview command");
    expect(() =>
      previewPostgresDemand({
        readSource: withRuntimeValues((values) => {
          values.components["admin-web"].env.push({ name: "DATABASE_URL_CATALOG", secret: true });
        }),
      }),
    ).toThrow("Unaccounted preview database consumer: admin-web");
    expect(() =>
      previewPostgresDemand({
        readSource: withSource(
          "infrastructure/platform-runtime/health.ts",
          (source) => `${source}\nconst synthetic = new Pool({ max: 1 });\n`,
        ),
      }),
    ).toThrow("Unaccounted preview Postgres client constructor: infrastructure/platform-runtime/health.ts");
  });
});
