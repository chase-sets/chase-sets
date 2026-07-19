import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { writeJsonRecord } from "./lib/output-file.mjs";

const schemaVersion = "deployment-contract/v3";
const runtimeValuesPath = new URL("../infrastructure/helm/platform/runtime-values.json", import.meta.url);

function readOption(argv, name, fallback = "") {
  const prefix = `${name}=`;
  const inline = argv.find((value) => value.startsWith(prefix));
  if (inline) {
    return inline.slice(prefix.length);
  }
  const index = argv.indexOf(name);
  return index >= 0 ? (argv[index + 1] ?? fallback) : fallback;
}

function parseBoolean(value, name) {
  if (value === true || value === "true") return true;
  if (value === false || value === "false" || value === "" || value === undefined) return false;
  throw new Error(`${name} must be true or false.`);
}

function runtimeValues() {
  const values = JSON.parse(readFileSync(runtimeValuesPath, "utf8"));
  if (values.schemaVersion !== "platform-runtime-values/v1") {
    throw new Error("The checked-in platform runtime values use an unsupported schema.");
  }
  return values;
}

function componentDatabaseKeys(component) {
  return (component.env ?? [])
    .filter(
      (entry) => entry.secretKey && /^(BOOTSTRAP_)?(DATABASE_URL_|PLATFORM_CONTROL_DATABASE_URL)/.test(entry.secretKey),
    )
    .map((entry) => entry.secretKey)
    .sort();
}

export function renderDeploymentContract(input) {
  const values = runtimeValues();
  const environment = String(input.environment ?? "").trim();
  if (!["staging", "production"].includes(environment)) {
    throw new Error("Deployment contract environment must be staging or production.");
  }

  const runtimeProfile =
    environment === "staging" ? "public" : String(input.productionRuntimeProfileOverride || "landing").trim();
  if (!["landing", "proof", "public"].includes(runtimeProfile)) {
    throw new Error("Production runtime profile must be landing, proof, or public.");
  }

  const bootstrapOwner = String(input.bootstrapOwnerOverride || "doks").trim();
  if (bootstrapOwner !== "doks") {
    throw new Error("DOKS is the only supported bootstrap owner.");
  }

  const marketplacePublicEnabled =
    environment === "staging" || parseBoolean(input.productionMarketplacePublicEnabled, "production marketplace");
  if (environment === "production" && (runtimeProfile === "public") !== marketplacePublicEnabled) {
    throw new Error("Production public runtime profile and marketplace exposure must move together.");
  }

  const components = values.components;
  const activeComponents = Object.keys(components).sort();
  const requiredComponents = [
    "admin-web",
    "marketplace",
    "platform-api",
    "platform-bootstrap",
    "platform-worker",
    "public-web",
  ];
  const missingComponents = requiredComponents.filter((name) => !activeComponents.includes(name));
  if (missingComponents.length > 0) {
    throw new Error(`DOKS runtime values are missing components: ${missingComponents.join(", ")}.`);
  }

  const contract = {
    schemaVersion,
    environment,
    runtimeOwner: "doks",
    bootstrapOwner,
    runtimeProfile,
    marketplacePublicEnabled,
    rolloutMode: parseBoolean(input.argoRolloutsEnabled, "argo rollouts") ? "doks-argo-rollouts" : "doks-helm",
    controlPlanes: {
      doks: {
        runtimeMode: "primary",
        bootstrapMode: "active",
        activeComponents,
      },
    },
    databaseUrlKeys: {
      runtime: componentDatabaseKeys(components["platform-api"]),
      worker: componentDatabaseKeys(components["platform-worker"]),
      bootstrap: componentDatabaseKeys(components["platform-bootstrap"]),
    },
    result: "pass",
    errors: [],
  };

  return contract;
}

export function deploymentContractMarkdown(contract) {
  return [
    `## ${contract.environment === "production" ? "Production" : "Staging"} deployment contract`,
    "",
    `- Runtime owner: \`${contract.runtimeOwner}\``,
    `- Bootstrap owner: \`${contract.bootstrapOwner}\``,
    `- Runtime profile: \`${contract.runtimeProfile}\``,
    `- Rollout mode: \`${contract.rolloutMode}\``,
    `- DOKS components: ${contract.controlPlanes.doks.activeComponents.join(", ")}`,
    "",
  ].join("\n");
}

async function main(argv) {
  const environment = readOption(argv, "--environment");
  const contract = renderDeploymentContract({
    environment,
    bootstrapOwnerOverride: readOption(argv, "--bootstrap-owner-override"),
    productionRuntimeProfileOverride: readOption(argv, "--production-runtime-profile-override"),
    productionMarketplacePublicEnabled: readOption(argv, "--production-marketplace-public-enabled"),
    argoRolloutsEnabled: readOption(argv, "--argo-rollouts-enabled"),
  });

  const out = readOption(argv, "--out");
  if (out) {
    await writeJsonRecord(out, contract);
  }
  const githubSummary = readOption(argv, "--github-summary");
  if (githubSummary) {
    await writeFile(githubSummary, deploymentContractMarkdown(contract), { encoding: "utf8", flag: "a" });
  }
  console.log(JSON.stringify(contract));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
