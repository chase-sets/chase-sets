export const DIGITALOCEAN_RUNTIME_TOPOLOGY_VERSION = 1;

export const retiredProfileComponentNames = ["admin-support-api", "admin-support-bootstrap", "admin-support-worker"];

export const runtimeTopologyBaselines = {
  preview: topology({
    environment: "preview",
    productionMode: null,
    apiProfile: "public",
    workerProfile: "public",
    services: ["public-web", "admin-web", "marketplace", "platform-api"],
    workers: ["platform-worker"],
    jobs: ["platform-bootstrap"],
    notes: ["Preview uses the full platform shape because it is disposable."],
  }),
  staging: topology({
    environment: "staging",
    productionMode: null,
    apiProfile: "public",
    workerProfile: "public",
    services: ["public-web", "admin-web", "marketplace", "platform-api"],
    workers: ["platform-worker"],
    jobs: ["platform-bootstrap"],
    notes: ["Staging uses the full platform shape before production promotion."],
  }),
  "production-landing": topology({
    environment: "production",
    productionMode: "landing",
    apiProfile: "landing",
    workerProfile: "landing",
    services: ["public-web", "admin-web", "platform-api"],
    workers: ["platform-worker"],
    jobs: ["platform-bootstrap"],
    notes: ["Target landing topology after the profiled platform-api/platform-worker cutover."],
  }),
  "production-proof": topology({
    environment: "production",
    productionMode: "proof",
    apiProfile: "proof",
    workerProfile: "proof",
    services: ["public-web", "admin-web", "marketplace", "platform-api"],
    workers: ["platform-worker"],
    jobs: ["platform-bootstrap"],
    notes: ["Private marketplace proof topology with provider callback and proof API exposure."],
  }),
  "production-public": topology({
    environment: "production",
    productionMode: "public",
    apiProfile: "public",
    workerProfile: "public",
    services: ["public-web", "admin-web", "marketplace", "platform-api"],
    workers: ["platform-worker"],
    jobs: ["platform-bootstrap"],
    notes: ["Full public marketplace topology after launch gates pass."],
  }),
};

export function summarizeTopologyBaseline(mode) {
  const baseline = runtimeTopologyBaselines[mode];
  if (!baseline) {
    throw new Error(`Unknown DigitalOcean runtime topology mode '${mode}'.`);
  }

  return {
    schemaVersion: DIGITALOCEAN_RUNTIME_TOPOLOGY_VERSION,
    mode,
    environment: baseline.environment,
    productionMode: baseline.productionMode,
    apiProfile: baseline.apiProfile,
    workerProfile: baseline.workerProfile,
    expectedComponents: baseline.expectedComponents,
    retiredProfileComponentNames,
    componentCount: componentCount(baseline.expectedComponents),
    instanceBudget: instanceBudget(baseline.expectedComponents),
    notes: baseline.notes,
  };
}

export function evaluateRuntimeTopology(mode, appSpec) {
  const baseline = summarizeTopologyBaseline(mode);
  const actualComponents = normalizeSpecComponents(appSpec);
  const expectedNames = new Set(componentNames(baseline.expectedComponents));
  const actualNames = componentNames(actualComponents);
  const missing = [...expectedNames].filter((name) => !actualNames.includes(name)).sort();
  const unexpected = actualNames.filter((name) => !expectedNames.has(name)).sort();
  const retiredReappeared = actualNames.filter((name) => retiredProfileComponentNames.includes(name)).sort();

  return {
    schemaVersion: DIGITALOCEAN_RUNTIME_TOPOLOGY_VERSION,
    mode,
    environment: baseline.environment,
    productionMode: baseline.productionMode,
    apiProfile: baseline.apiProfile,
    workerProfile: baseline.workerProfile,
    expectedComponents: baseline.expectedComponents,
    actualComponents,
    missing,
    unexpected,
    retiredReappeared,
    pass: missing.length === 0 && unexpected.length === 0 && retiredReappeared.length === 0,
  };
}

function topology(input) {
  return {
    environment: input.environment,
    productionMode: input.productionMode,
    apiProfile: input.apiProfile,
    workerProfile: input.workerProfile,
    expectedComponents: {
      services: input.services.map(component),
      workers: input.workers.map(component),
      jobs: input.jobs.map(component),
    },
    notes: input.notes,
  };
}

function component(name) {
  return { name, instanceCount: 1 };
}

function normalizeSpecComponents(spec) {
  return {
    services: normalizeCollection(spec?.services ?? spec?.Services ?? []),
    workers: normalizeCollection(spec?.workers ?? spec?.Workers ?? []),
    jobs: normalizeCollection(spec?.jobs ?? spec?.Jobs ?? []),
  };
}

function normalizeCollection(components) {
  return components
    .map((entry) => ({
      name: String(entry?.name ?? entry?.Name ?? ""),
      instanceCount: Number(entry?.instance_count ?? entry?.InstanceCount ?? entry?.instanceCount ?? 1),
    }))
    .filter((entry) => entry.name)
    .sort((left, right) => left.name.localeCompare(right.name));
}

function componentNames(components) {
  return [...components.services, ...components.workers, ...components.jobs]
    .map((entry) => entry.name)
    .filter(Boolean)
    .sort();
}

function componentCount(components) {
  return componentNames(components).length;
}

function instanceBudget(components) {
  return [...components.services, ...components.workers, ...components.jobs].reduce(
    (total, entry) => total + entry.instanceCount,
    0,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const mode = process.argv[2];
  if (!mode) {
    console.error("Usage: node ./scripts/digitalocean-runtime-topology.mjs <mode>");
    process.exitCode = 1;
  } else {
    console.log(JSON.stringify(summarizeTopologyBaseline(mode), null, 2));
  }
}
import { pathToFileURL } from "node:url";
