import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createTransport, holdOrigin } from "../fixtures/restart-probe/transport.js";

export type FixtureOptions = {
  orderingMutant: boolean;
  deleteOnStartup: boolean;
  registry: string[];
  permissions: string[];
};

export const candidateOptions: FixtureOptions = {
  orderingMutant: false,
  deleteOnStartup: false,
  registry: [holdOrigin],
  permissions: [`${holdOrigin}/*`],
};

export function buildFixture(destination: string, options: FixtureOptions, listeningOrigin: string) {
  if (listeningOrigin !== holdOrigin) throw new Error("Hold origin must be bound before fixture build");
  const manifest = {
    manifest_version: 3,
    name: "SYNTHETIC restart boundary probe",
    version: "1.0.0",
    background: { service_worker: "worker.js", type: "module" },
    permissions: ["alarms", "storage"],
    host_permissions: options.permissions,
    content_security_policy: { extension_pages: "script-src 'self'; object-src 'none'" },
  };
  createTransport(manifest, options.registry);
  mkdirSync(destination, { recursive: true });
  for (const file of ["worker.js", "transport.js", "observer.html"]) {
    copyFileSync(resolve(import.meta.dirname, "../fixtures/restart-probe", file), resolve(destination, file));
  }
  writeFileSync(resolve(destination, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(resolve(destination, "options.js"), `export const options = ${JSON.stringify(options)};\n`);
}
