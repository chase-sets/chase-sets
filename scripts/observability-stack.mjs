import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const command = process.argv[2] ?? "urls";
const rootDir = fileURLToPath(new URL("../", import.meta.url));
const composeArgs = ["compose", "-f", "docker-compose.dev.yml"];
const services = ["otel-collector", "prometheus", "loki", "tempo", "grafana"];

function run(commandName, args) {
  const result = spawnSync(commandName, args, {
    stdio: "inherit",
    shell: process.platform === "win32",
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
  console.log("Observability stack");
  console.log("  Grafana:      http://localhost:3000");
  console.log("  Prometheus:   http://localhost:9090");
  console.log("  Loki:         http://localhost:3100");
  console.log("  Tempo:        http://localhost:3200");
  console.log("  OTLP HTTP:    http://localhost:4318");
  console.log("  OTLP gRPC:    localhost:4317");
  console.log("");
  console.log("Local Grafana credentials default to admin/admin.");
  console.log("");
}

if (command === "up") {
  mkdirSync(path.join(rootDir, "artifacts", "observability"), { recursive: true });
  run("docker", [...composeArgs, "--profile", "observability", "up", "-d", ...services]);
  printUrls();
} else if (command === "down") {
  run("docker", [...composeArgs, "stop", ...services]);
  run("docker", [...composeArgs, "rm", "-f", ...services]);
} else if (command === "open") {
  printUrls();
  openUrl("http://localhost:3000");
} else if (command === "urls") {
  printUrls();
} else {
  console.error(`Unknown observability command "${command}". Use up, down, open, or urls.`);
  process.exitCode = 1;
}
