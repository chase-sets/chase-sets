import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { BundleRecord, FileDigest, ReplacementArm, StagingRecord } from "../../support/replacement-record";

// SYNTHETIC public key for #9257 only; its private half was never retained. It pins one extension id for A and B.
export const syntheticReplacementKey =
  "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAi0W2OCpoUWq7IgNRIplT73KICQKFkTSFmp1UapZJusszvg8fWNl58PM6bI7SXFvShBWR6nvl3b+GUgyQpq/l12YNOuk8IGON5KiyTGlw5UWbVtEfso+f60mdXWZmc+rcOLau7G7FYcL/jDnY077EcXO+MSkpe3M3xnRm+ok777CsBVFGmUckNFT51ZsNelSkDkrSYZVhI3Q/dKrckWNDdt3Ph8SP4tTslUEoiEhIZ0rTZo+nb8d4KRNItnu4oXCwnCx4fCxsDeD5Pk1UWez1Os1MrMoIwm8oT2JqfXIhwMSpyGb2R/QVxLYmnqEGdmPDqPxtSqxbPeVSZDV9ajpnswIDAQAB";

const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

// Chromium derives an extension id from the first 16 bytes of SHA256(key DER), one a-p letter per hex digit.
export function extensionIdForKey(key: string) {
  return [...sha256(Buffer.from(key, "base64")).slice(0, 32)]
    .map((digit) => String.fromCharCode(97 + Number.parseInt(digit, 16)))
    .join("");
}

export const syntheticReplacementKeySha256 = sha256(Buffer.from(syntheticReplacementKey, "base64"));

export function fileDigests(directory: string): FileDigest[] {
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const path = resolve(entry.parentPath, entry.name);
      const bytes = readFileSync(path);
      return {
        name: path.slice(directory.length + 1).replaceAll("\\", "/"),
        bytes: bytes.length,
        sha256: sha256(bytes),
      };
    })
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
}

export function buildReplacementBundle(
  destination: string,
  arm: ReplacementArm,
  label: "A" | "B",
  manifestVersion: string,
  syntheticVersion: boolean,
): BundleRecord & { directory: string } {
  if (existsSync(destination)) throw new Error("Replacement bundle destination must be fresh");
  const identity = `SYNTHETIC-9257:${arm}:${label}`;
  const template = readFileSync(resolve(import.meta.dirname, "worker.js"), "utf8");
  const placeholder = "/* compiled-identity */ null";
  if (template.split(placeholder).length !== 2) throw new Error("Worker template must hold one identity placeholder");
  const manifest = {
    manifest_version: 3,
    name: "SYNTHETIC code-replacement probe",
    version: manifestVersion,
    ...(syntheticVersion ? { version_name: `${manifestVersion} SYNTHETIC lower-than-0.1.0` } : {}),
    key: syntheticReplacementKey,
    background: { service_worker: "worker.js", type: "module" },
    content_security_policy: { extension_pages: "script-src 'self'; object-src 'none'" },
  };
  mkdirSync(destination, { recursive: true });
  writeFileSync(resolve(destination, "worker.js"), template.replace(placeholder, JSON.stringify(identity)));
  copyFileSync(resolve(import.meta.dirname, "observer.html"), resolve(destination, "observer.html"));
  writeFileSync(resolve(destination, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return {
    label,
    identity,
    manifestVersion,
    syntheticVersion,
    files: fileDigests(destination),
    directory: destination,
  };
}

// Callers stage only while no context holds the profile: clear the stable directory, copy the complete set, compare.
export function stageBundle(bundle: BundleRecord & { directory: string }, target: string): StagingRecord {
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  const source = fileDigests(bundle.directory);
  for (const file of source) {
    mkdirSync(dirname(resolve(target, file.name)), { recursive: true });
    copyFileSync(resolve(bundle.directory, file.name), resolve(target, file.name));
  }
  return { bundle: bundle.label, stagedAt: new Date().toISOString(), source, staged: fileDigests(target) };
}
