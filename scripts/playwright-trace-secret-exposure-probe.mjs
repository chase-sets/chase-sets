import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { inflateRawSync } from "node:zlib";

const repoRoot = path.resolve(import.meta.dirname, "..");
const uploadedArtifactRoots = [
  path.join(repoRoot, "artifacts", "playwright", "report"),
  path.join(repoRoot, "artifacts", "playwright", "test-results"),
];
const markerPrefix = ["FAKE", "TRACE", "PROBE", "5944"].join("_");
const markers = {
  email: `${markerPrefix}_ADMIN_EMAIL@example.invalid`,
  password: `${markerPrefix}_ADMIN_PASSWORD`,
  session: `${markerPrefix}_ADMIN_SESSION`,
  bearer: `${markerPrefix}_ADMIN_BEARER`,
  token: `${markerPrefix}_ADMIN_TOKEN`,
};

const playwrightArguments = [
  "exec",
  "playwright",
  "test",
  "deployables/marketplace/e2e/support/auth-trace-artifact.probe.spec.ts",
  "--project=marketplace-chromium",
  "--retries=1",
  "--workers=1",
];
const probe = spawnSync(
  process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : "pnpm",
  process.platform === "win32" ? ["/d", "/s", "/c", `pnpm ${playwrightArguments.join(" ")}`] : playwrightArguments,
  {
    cwd: repoRoot,
    env: {
      ...process.env,
      AUTH_TRACE_ARTIFACT_PROBE: "true",
      CI: "true",
      PLAYWRIGHT_SKIP_WEB_SERVER: "true",
      PLATFORM_ADMIN_EMAIL: markers.email,
      PLATFORM_ADMIN_PASSWORD: markers.password,
      TRACE_PROBE_ADMIN_EMAIL: markers.email,
      TRACE_PROBE_ADMIN_PASSWORD: markers.password,
      TRACE_PROBE_ADMIN_SESSION: markers.session,
      TRACE_PROBE_ADMIN_BEARER: markers.bearer,
      TRACE_PROBE_ADMIN_TOKEN: markers.token,
    },
    stdio: "inherit",
    timeout: 180_000,
  },
);

if (probe.error?.code === "ETIMEDOUT") {
  throw new Error("Playwright trace secret exposure probe failed (timeout).");
}
if (probe.error || probe.status !== 0) {
  throw new Error("Playwright trace secret exposure probe failed (runner).");
}

const state = {
  artifactFiles: 0,
  archiveEntries: 0,
  traceArchives: 0,
  traceEntries: 0,
  resourceEntries: 0,
};

for (const root of uploadedArtifactRoots) {
  const files = await listFiles(root);
  if (files.length === 0) {
    throw new Error(`Playwright trace secret exposure probe failed (missing-${path.basename(root)}).`);
  }
  for (const file of files) {
    state.artifactFiles += 1;
    const bytes = await readFile(file);
    assertMarkersAbsent(bytes, path.relative(repoRoot, file));
    if (isZip(bytes)) {
      if (path.basename(file) === "trace.zip") {
        state.traceArchives += 1;
      }
      inspectZip(bytes, path.relative(repoRoot, file), state);
    }
  }
}

if (state.traceArchives < 1 || state.traceEntries < 2 || state.resourceEntries < 1) {
  throw new Error("Playwright trace secret exposure probe failed (retained-trace-shape).");
}

console.log(
  `Playwright trace secret exposure probe passed: ${state.artifactFiles} uploaded files, ${state.archiveEntries} extracted archive entries, ${state.traceArchives} trace archive, ${state.traceEntries} trace entries, ${state.resourceEntries} resource entries; ${Object.keys(markers).length} fake markers absent.`,
);

async function listFiles(root) {
  const files = [];
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(entryPath)));
    } else if (entry.isFile()) {
      files.push(entryPath);
    }
  }
  return files;
}

function inspectZip(bytes, archivePath, state) {
  for (const entry of readZipEntries(bytes)) {
    state.archiveEntries += 1;
    const entryPath = `${archivePath}!${entry.name}`;
    assertMarkersAbsent(entry.bytes, entryPath);
    if (entry.name.endsWith("trace.trace") || entry.name.endsWith("trace.network")) {
      state.traceEntries += 1;
    }
    if (entry.name.includes("resources/")) {
      state.resourceEntries += 1;
    }
    if (isZip(entry.bytes)) {
      inspectZip(entry.bytes, entryPath, state);
    }
  }
}

function assertMarkersAbsent(bytes, location) {
  for (const [classification, marker] of Object.entries(markers)) {
    if (bytes.includes(Buffer.from(marker))) {
      throw new Error(`Playwright trace secret exposure probe failed (${classification}-marker in ${location}).`);
    }
  }
}

function isZip(bytes) {
  return bytes.length >= 4 && bytes.readUInt32LE(0) === 0x04034b50;
}

function readZipEntries(bytes) {
  const end = findEndOfCentralDirectory(bytes);
  const entryCount = bytes.readUInt16LE(end + 10);
  let offset = bytes.readUInt32LE(end + 16);
  const entries = [];
  for (let index = 0; index < entryCount; index += 1) {
    if (bytes.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error("Playwright trace secret exposure probe failed (invalid-archive-directory).");
    }
    const compression = bytes.readUInt16LE(offset + 10);
    const compressedSize = bytes.readUInt32LE(offset + 20);
    const uncompressedSize = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const localHeaderOffset = bytes.readUInt32LE(offset + 42);
    const name = bytes.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    if (bytes.readUInt32LE(localHeaderOffset) !== 0x04034b50) {
      throw new Error("Playwright trace secret exposure probe failed (invalid-archive-entry).");
    }
    const localNameLength = bytes.readUInt16LE(localHeaderOffset + 26);
    const localExtraLength = bytes.readUInt16LE(localHeaderOffset + 28);
    const dataOffset = localHeaderOffset + 30 + localNameLength + localExtraLength;
    const compressed = bytes.subarray(dataOffset, dataOffset + compressedSize);
    const entryBytes = compression === 0 ? compressed : compression === 8 ? inflateRawSync(compressed) : null;
    if (!entryBytes || entryBytes.length !== uncompressedSize) {
      throw new Error("Playwright trace secret exposure probe failed (unsupported-archive-entry).");
    }
    entries.push({ name, bytes: entryBytes });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function findEndOfCentralDirectory(bytes) {
  const minimumOffset = Math.max(0, bytes.length - 65_557);
  for (let offset = bytes.length - 22; offset >= minimumOffset; offset -= 1) {
    if (bytes.readUInt32LE(offset) === 0x06054b50) {
      return offset;
    }
  }
  throw new Error("Playwright trace secret exposure probe failed (missing-archive-directory).");
}
