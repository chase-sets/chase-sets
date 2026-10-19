import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { classifyBrandFoilContent } from "./check-structure/brand-foil-sites.mjs";
import { pinned } from "./doks-cluster-addons.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const valuesPath = path.join(root, "infrastructure/helm/doks-ingress/ingress-nginx-values.yaml");
const source = readFileSync(valuesPath, "utf8");
const values = parse(source);
const data = values.defaultBackend.extraConfigMaps[0].data;
const digest = (value) => createHash("sha256").update(value, "utf8").digest("hex");
const sortedDataJson = (configMapData) =>
  JSON.stringify(
    Object.fromEntries(
      Object.keys(configMapData)
        .sort()
        .map((key) => [key, configMapData[key]]),
    ),
  );
const message = "Chase Sets is temporarily unavailable. Please try again in a minute.";
const defaultBackendSelector = {
  "app.kubernetes.io/name": "ingress-nginx",
  "app.kubernetes.io/instance": "ingress-nginx",
  "app.kubernetes.io/component": "default-backend",
};
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function expectConfigLine(config, line) {
  expect(config).toMatch(new RegExp(`^\\s*${escapeRegExp(line)}$`, "m"));
}

function expectOrderedLines(config, lines) {
  let previous = -1;
  for (const line of lines) {
    expectConfigLine(config, line);
    const index = config.indexOf(line, previous + 1);
    expect(index).toBeGreaterThan(previous);
    previous = index;
  }
}

function assertMaintenanceConfig(candidate) {
  const candidateBackend = candidate.defaultBackend;
  expect(pinned.ingressNginx.version).toBe("4.11.3");
  expect(pinned.ingressNginx.releaseName).toBe("ingress-nginx");
  expect(candidate.controller.config).toEqual({
    "use-proxy-protocol": "false",
    "use-forwarded-headers": "false",
    "ssl-redirect": "true",
    "custom-http-errors": "502,503,504",
    "disable-proxy-intercept-errors": "true",
    "log-format-upstream":
      '$remote_addr - $remote_user [$time_local] "$request_method $uri $server_protocol" $status $body_bytes_sent "$http_user_agent" $request_length $request_time [$proxy_upstream_name] [$proxy_alternative_upstream_name] $upstream_addr $upstream_response_length $upstream_response_time $upstream_status $req_id',
    "error-log-path": "/dev/null",
  });
  expect(candidateBackend).toMatchObject({
    enabled: true,
    replicaCount: 2,
    minAvailable: 1,
    port: 8080,
    image: {
      registry: "docker.io",
      image: "nginxinc/nginx-unprivileged",
      tag: "1.30.4-alpine",
      digest: "sha256:adf5042a17f4ecdd200c595fa9ffd1be37efb18f89a830bd1a00e4ab4d59d42c",
      runAsUser: 101,
      runAsNonRoot: true,
      allowPrivilegeEscalation: false,
      readOnlyRootFilesystem: true,
      seccompProfile: { type: "RuntimeDefault" },
    },
    serviceAccount: { automountServiceAccountToken: false },
    resources: { requests: { cpu: "10m", memory: "32Mi" } },
  });
  expect(candidateBackend.topologySpreadConstraints).toHaveLength(1);
  for (const constraint of candidateBackend.topologySpreadConstraints) {
    expect(constraint).toMatchObject({
      maxSkew: 1,
      topologyKey: "kubernetes.io/hostname",
      whenUnsatisfiable: "ScheduleAnyway",
    });
    expect(constraint.labelSelector).toEqual({ matchLabels: defaultBackendSelector });
    expect(constraint).not.toHaveProperty("matchExpressions");
  }

  expect(candidateBackend.extraConfigMaps).toHaveLength(1);
  expect(candidateBackend.extraConfigMaps[0].name).toBe("ingress-nginx-maintenance");
  const candidateData = candidateBackend.extraConfigMaps[0].data;
  expect(candidateBackend.podAnnotations["chase-sets.com/maintenance-config-sha256"]).toBe(
    digest(sortedDataJson(candidateData)),
  );
  expect(candidateData).toEqual({
    "502.json": `{"status":502,"error":"bad_gateway","message":"${message}"}\n`,
    "503.json": `{"status":503,"error":"service_unavailable","message":"${message}"}\n`,
    "504.json": `{"status":504,"error":"gateway_timeout","message":"${message}"}\n`,
    "default.conf": expect.any(String),
    "maintenance.html": expect.any(String),
  });

  const config = candidateData["default.conf"];
  expectOrderedLines(config, [
    "map $http_x_format $maintenance_format {",
    "default json;",
    String.raw`~*(^|,)\s*(application/json|text/event-stream)(\s*\x3B[^,]*)?(,|$) json;`,
    String.raw`~*(^|,)\s*text/html[^,]*\x3B\s*q=0(?:\.0*)?(?:\s*,|$) json;`,
    String.raw`~*(^|,)\s*text/html(?:\s*\x3B[^,]*)?(,|$) html;`,
    "}",
    'map "$http_x_code:$maintenance_format" $maintenance_uri {',
    '"502:html" /maintenance.html;',
    '"503:html" /maintenance.html;',
    '"504:html" /maintenance.html;',
    '"502:json" /502.json;',
    '"503:json" /503.json;',
    '"504:json" /504.json;',
    "}",
  ]);
  for (const line of [
    "error_page 502 =502 $maintenance_uri;",
    "error_page 503 =503 $maintenance_uri;",
    "error_page 504 =504 $maintenance_uri;",
    "if ($http_x_code = 502) { return 502; }",
    "if ($http_x_code = 503) { return 503; }",
    "if ($http_x_code = 504) { return 504; }",
    "return 404;",
    'return 200 "ok\\n";',
  ]) {
    expectConfigLine(config, line);
  }
  expect(config.match(/^\s*add_header Retry-After 60 always;$/gm)).toHaveLength(2);
  expect(config.match(/^\s*add_header Cache-Control no-store always;$/gm)).toHaveLength(2);
  for (const [start, end] of [
    ["location = /maintenance.html {", "location ~ ^/(502|503|504)\\.json$ {"],
    ["location ~ ^/(502|503|504)\\.json$ {", "location / {"],
  ]) {
    const startIndex = config.indexOf(start);
    const endIndex = config.indexOf(end, startIndex + start.length);
    const block = startIndex >= 0 && endIndex >= 0 ? config.slice(startIndex, endIndex) : undefined;
    expect(block).toBeDefined();
    expect(block).toContain("internal;");
    expect(block).toContain("add_header Retry-After 60 always;");
    expect(block).toContain("add_header Cache-Control no-store always;");
  }
  expectConfigLine(config, "default_type text/html;");
  expectConfigLine(config, "charset utf-8;");

  const html = candidateData["maintenance.html"];
  expect(html).toContain("<div>Chase Sets</div>");
  expect(html).toContain("<h1>We'll be right back</h1>");
  expect(html).toContain(`<p>${message}</p>`);
  expect(html).toContain("max-width: 32rem");
  for (const token of [
    "--background: #f7f5f1",
    "--card: #ffffff",
    "--foreground: #211d33",
    "--text-secondary: #4d4763",
    "--border: #e6e2d9",
    "--radius-lg: 0.75rem",
    "--space-8: 2rem",
    "--space-6: 1.5rem",
  ]) {
    expect(html).toContain(token);
  }
  expect(html).not.toMatch(/<script\b|\bsrc\s*=|\bhref\s*=|url\(|https?:\/\//i);
  expect(classifyBrandFoilContent(Buffer.from(html, "utf8"))).toEqual([]);

  for (const [code, error] of [
    [502, "bad_gateway"],
    [503, "service_unavailable"],
    [504, "gateway_timeout"],
  ]) {
    expect(JSON.parse(candidateData[`${code}.json`])).toEqual({ status: code, error, message });
  }

  expect(candidateBackend.extraVolumes).toEqual([
    {
      name: "maintenance-config",
      configMap: { name: "ingress-nginx-maintenance", items: [{ key: "default.conf", path: "default.conf" }] },
    },
    {
      name: "maintenance-bodies",
      configMap: {
        name: "ingress-nginx-maintenance",
        items: [
          { key: "maintenance.html", path: "maintenance.html" },
          { key: "502.json", path: "502.json" },
          { key: "503.json", path: "503.json" },
          { key: "504.json", path: "504.json" },
        ],
      },
    },
    { name: "nginx-tmp", emptyDir: { medium: "Memory", sizeLimit: "16Mi" } },
  ]);
  expect(candidateBackend.extraVolumeMounts).toEqual([
    { name: "maintenance-config", mountPath: "/etc/nginx/conf.d", readOnly: true },
    { name: "maintenance-bodies", mountPath: "/opt/chase-sets-maintenance", readOnly: true },
    { name: "nginx-tmp", mountPath: "/tmp" },
  ]);
}

describe("ingress maintenance default backend contract", () => {
  it("pins controller policy, worker, files, negotiation, headers, and safe mounts", () => {
    assertMaintenanceConfig(values);
  });

  it("logs the default backend query-free with no error log", () => {
    const config = data["default.conf"];
    const server = config.slice(config.indexOf("server {"));
    expectConfigLine(
      config,
      "log_format maintenance_pathname '$request_method $uri $status $http_x_code $http_x_request_id';",
    );
    expectConfigLine(config, "access_log /dev/stdout maintenance_pathname;");
    expect(server).toMatch(/^\s*access_log\s+[^;]+;$/m);
    expect(server).toMatch(/^\s*error_log\s+\/dev\/null;$/m);
    expect(config.match(/\$[a-z_]+/g)).toEqual(
      expect.arrayContaining(["$request_method", "$uri", "$status", "$http_x_code", "$http_x_request_id"]),
    );
    expect(config.match(/\$[a-z_]+/g)).not.toContain("$request");
    expect(config).not.toMatch(
      /\$(?:request_uri|args|query_string|is_args|arg_[a-z_]+|http_referer|http_x_original_uri)\b/,
    );
  });

  it("rejects a one-byte payload mutant with its stale digest", () => {
    const mutant = parse(source);
    mutant.defaultBackend.extraConfigMaps[0].data["503.json"] = data["503.json"].replace("minute", "minutes");
    expect(() => assertMaintenanceConfig(mutant)).toThrow();
  });

  it("rejects an interception-enabled mutant", () => {
    const mutant = parse(source);
    mutant.controller.config["disable-proxy-intercept-errors"] = "false";
    expect(() => assertMaintenanceConfig(mutant)).toThrow();
  });

  it("rejects a missing /tmp mount", () => {
    const mutant = parse(source);
    mutant.defaultBackend.extraVolumeMounts = mutant.defaultBackend.extraVolumeMounts.filter(
      ({ name }) => name !== "nginx-tmp",
    );
    expect(() => assertMaintenanceConfig(mutant)).toThrow();
  });

  it("rejects HTML-first format precedence", () => {
    const mutant = parse(source);
    const config = mutant.defaultBackend.extraConfigMaps[0].data["default.conf"];
    const htmlLine = String.raw`~*(^|,)\s*text/html(?:\s*\x3B[^,]*)?(,|$) html;`;
    mutant.defaultBackend.extraConfigMaps[0].data["default.conf"] = config
      .replace(new RegExp(`^\\s*${htmlLine}\\s*$`, "m"), "")
      .replace(/^(\s*)default json;$/m, `$1${htmlLine}\n$1default json;`);
    expect(() => assertMaintenanceConfig(mutant)).toThrow();
  });

  it("rejects a missing HTML charset", () => {
    const mutant = parse(source);
    mutant.defaultBackend.extraConfigMaps[0].data["default.conf"] = mutant.defaultBackend.extraConfigMaps[0].data[
      "default.conf"
    ].replace(/^\s*charset utf-8;\s*$/m, "");
    expect(() => assertMaintenanceConfig(mutant)).toThrow();
  });

  it("rejects a single maintenance replica", () => {
    const mutant = parse(source);
    mutant.defaultBackend.replicaCount = 1;
    expect(() => assertMaintenanceConfig(mutant)).toThrow();
  });

  it("rejects a selector-removed spread constraint", () => {
    const mutant = parse(source);
    delete mutant.defaultBackend.topologySpreadConstraints[0].labelSelector;
    expect(() => assertMaintenanceConfig(mutant)).toThrow();
  });

  it("rejects an empty labelSelector spread constraint", () => {
    const mutant = parse(source);
    mutant.defaultBackend.topologySpreadConstraints[0].labelSelector = {};
    expect(() => assertMaintenanceConfig(mutant)).toThrow();
  });

  it("rejects an empty matchLabels spread constraint", () => {
    const mutant = parse(source);
    mutant.defaultBackend.topologySpreadConstraints[0].labelSelector = { matchLabels: {} };
    expect(() => assertMaintenanceConfig(mutant)).toThrow();
  });

  it("rejects a changed selector label value", () => {
    const mutant = parse(source);
    mutant.defaultBackend.topologySpreadConstraints[0].labelSelector = {
      matchLabels: { ...defaultBackendSelector, "app.kubernetes.io/name": "not-ingress-nginx" },
    };
    expect(() => assertMaintenanceConfig(mutant)).toThrow();
  });

  it("rejects a second selector-less spread constraint", () => {
    const mutant = parse(source);
    mutant.defaultBackend.topologySpreadConstraints.push({
      maxSkew: 1,
      topologyKey: "kubernetes.io/hostname",
      whenUnsatisfiable: "ScheduleAnyway",
    });
    expect(() => assertMaintenanceConfig(mutant)).toThrow();
  });
});
