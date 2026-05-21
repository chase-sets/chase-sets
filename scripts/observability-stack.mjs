import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { applySandboxEnv, buildDockerComposeArgs, ensureWorktreeSandboxEnvironment } from "./lib/sandbox.mjs";

const command = process.argv[2] ?? "urls";
const rootDir = fileURLToPath(new URL("../", import.meta.url));
const { sandbox, env: sandboxEnv } = ensureWorktreeSandboxEnvironment({ rootDir });
applySandboxEnv(sandboxEnv);
const composeArgs = buildDockerComposeArgs(sandbox);
const services = ["otel-collector", "prometheus", "loki", "tempo", "grafana"];

function run(commandName, args) {
  const result = spawnSync(commandName, args, {
    stdio: "inherit",
    shell: process.platform === "win32",
    env: {
      ...process.env,
      ...sandboxEnv,
    },
    windowsHide: true,
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function openUrl(url) {
  if (process.platform === "win32") {
    run("cmd", ["/d", "/s", "/c", "start", "", url]);
    return;
  }

  if (process.platform === "darwin") {
    run("open", [url]);
    return;
  }

  run("xdg-open", [url]);
}

function printUrls() {
  console.log("");
  console.log(`Observability stack (${sandbox.id})`);
  console.log(`  Grafana:      ${sandbox.urls.grafana}`);
  console.log(`  Prometheus:   ${sandbox.urls.prometheus}`);
  console.log(`  Loki:         ${sandbox.urls.loki}`);
  console.log(`  Tempo:        ${sandbox.urls.tempo}`);
  console.log(`  OTLP HTTP:    ${sandbox.urls.otelHttp}`);
  console.log(`  OTLP gRPC:    ${sandbox.urls.otelGrpc}`);
  console.log("");
  console.log("Local Grafana credentials default to admin/admin.");
  console.log("");
}

if (command === "up") {
  mkdirSync(sandbox.observabilityArtifactsPath, { recursive: true });
  run("docker", [...composeArgs, "--profile", "observability", "up", "-d", ...services]);
  printUrls();
} else if (command === "down") {
  run("docker", [...composeArgs, "stop", ...services]);
  run("docker", [...composeArgs, "rm", "-f", ...services]);
} else if (command === "open") {
  printUrls();
  openUrl(sandbox.urls.grafana);
} else if (command === "urls") {
  printUrls();
} else {
  console.error(`Unknown observability command "${command}". Use up, down, open, or urls.`);
  process.exitCode = 1;
}
