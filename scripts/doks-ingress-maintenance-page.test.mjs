import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { classifyBrandFoilContent } from "./check-structure/brand-foil-sites.mjs";

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

function assertMaintenanceConfig(candidate) {
  const candidateBackend = candidate.defaultBackend;
  const candidateData = candidateBackend.extraConfigMaps[0].data;
  expect(candidate.controller.config).toMatchObject({
    "custom-http-errors": "502,503,504",
    "disable-proxy-intercept-errors": "true",
  });
  expect(candidateBackend).toMatchObject({
    enabled: true,
    replicaCount: 1,
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
  expect(candidateBackend.podAnnotations["chase-sets.com/maintenance-config-sha256"]).toBe(
    digest(sortedDataJson(candidateData)),
  );
  expect(candidateData).toEqual({
    "502.json":
      '{"status":502,"error":"bad_gateway","message":"Chase Sets is temporarily unavailable. Please try again in a minute."}\n',
    "503.json":
      '{"status":503,"error":"service_unavailable","message":"Chase Sets is temporarily unavailable. Please try again in a minute."}\n',
    "504.json":
      '{"status":504,"error":"gateway_timeout","message":"Chase Sets is temporarily unavailable. Please try again in a minute."}\n',
    "default.conf": expect.any(String),
    "maintenance.html": expect.any(String),
  });

  const config = candidateData["default.conf"];
  expect(config).toContain("error_page 502 =502 $maintenance_uri;");
  expect(config).toContain("error_page 503 =503 $maintenance_uri;");
  expect(config).toContain("error_page 504 =504 $maintenance_uri;");
  expect(config).not.toContain("proxy_intercept_errors on");
  expect(config).toContain("return 404;");
  expect(config).toContain('return 200 "ok\\n";');

  const html = candidateData["maintenance.html"];
  expect(html).toContain("Chase Sets");
  expect(html).toContain("We'll be right back");
  expect(html).toContain("Chase Sets is temporarily unavailable. Please try again in a minute.");
  expect(html).not.toMatch(/\b(?:src|href)\s*=|url\(|https?:\/\//i);
  expect(classifyBrandFoilContent(Buffer.from(html, "utf8"))).toEqual([]);

  for (const [code, error] of [
    [502, "bad_gateway"],
    [503, "service_unavailable"],
    [504, "gateway_timeout"],
  ]) {
    expect(JSON.parse(candidateData[`${code}.json`])).toEqual({
      status: code,
      error,
      message: "Chase Sets is temporarily unavailable. Please try again in a minute.",
    });
  }

  expect(candidateBackend.extraVolumes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        name: "maintenance-config",
        configMap: { name: "ingress-nginx-maintenance", items: [{ key: "default.conf", path: "default.conf" }] },
      }),
      expect.objectContaining({
        name: "maintenance-bodies",
        configMap: {
          name: "ingress-nginx-maintenance",
          items: expect.arrayContaining([
            { key: "maintenance.html", path: "maintenance.html" },
            { key: "502.json", path: "502.json" },
            { key: "503.json", path: "503.json" },
            { key: "504.json", path: "504.json" },
          ]),
        },
      }),
      expect.objectContaining({ name: "nginx-tmp", emptyDir: { medium: "Memory", sizeLimit: "16Mi" } }),
    ]),
  );
  expect(candidateBackend.extraVolumeMounts).not.toEqual(
    expect.arrayContaining([expect.objectContaining({ subPath: expect.anything() })]),
  );
}

describe("ingress maintenance default backend contract", () => {
  it("pins the controller interception policy, worker, files, and safe mounts", () => {
    assertMaintenanceConfig(values);
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
});
