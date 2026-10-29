#!/usr/bin/env node
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { writeFile } from "node:fs/promises";

export const DIGITALOCEAN_REGISTRY_GC_GATE_VERSION = "digitalocean-registry-gc-gate/v1";
export const REGISTRY_GC_WAIT_MINUTES = 120;
export const REGISTRY_GC_JOB_TIMEOUT_MINUTES = 135;
export const REGISTRY_GC_POLL_INTERVAL_MS = 60_000;
export const ACTIVE_GC_NOT_FOUND_PHRASE = "did not find an active garbage collection";
export const REGISTRY_GC_READ_ONLY_CODE = "registry-gc-read-only";

function commandOutput(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { maxBuffer: 50 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve(stdout);
    });
  });
}

function compactFailure(error) {
  const stderr = typeof error?.stderr === "string" ? error.stderr : "";
  return stderr.replace(/\s+/g, " ").trim().slice(0, 500) || "provider command failed";
}

function field(value, names) {
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(value, name)) return value[name];
  }
  return undefined;
}

function parseGarbageCollectionEntry(record, registry) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return { kind: "error", reason: "malformed", detail: "provider returned an unexpected shape" };
  }
  const uuid = field(record, ["uuid", "UUID", "id", "ID"]);
  const status = field(record, ["status", "Status"]);
  const registryName = field(record, ["registry_name", "registryName", "RegistryName", "registry"]);
  if (typeof uuid !== "string" || !/^[0-9a-f-]{36}$/i.test(uuid) || typeof status !== "string" || !status.trim()) {
    return { kind: "error", reason: "malformed", detail: "provider omitted UUID or status" };
  }
  if (registryName !== undefined && registryName !== registry) {
    return { kind: "error", reason: "mismatched-registry", detail: "provider returned another registry" };
  }
  return { kind: "active", uuid, status: status.trim().toLowerCase(), registry: registryName ?? registry };
}

export function parseGarbageCollectionRecord(raw, registry) {
  let value;
  try {
    value = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return { kind: "error", reason: "malformed", detail: "provider returned malformed JSON" };
  }
  if (!Array.isArray(value) || value.length !== 1) {
    return { kind: "error", reason: "malformed", detail: "provider returned an unexpected shape" };
  }
  return parseGarbageCollectionEntry(value[0], registry);
}

function parseList(raw, registry) {
  let value;
  try {
    value = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return { kind: "error", reason: "malformed", detail: "provider returned malformed list JSON" };
  }
  const entries = Array.isArray(value)
    ? value
    : Array.isArray(value?.garbage_collections)
      ? value.garbage_collections
      : Array.isArray(value?.garbageCollections)
        ? value.garbageCollections
        : null;
  if (!entries) return { kind: "error", reason: "malformed", detail: "provider returned an unexpected list shape" };
  const records = entries.map((entry) => parseGarbageCollectionEntry(entry, registry));
  if (records.some((entry) => entry.kind === "error")) return records.find((entry) => entry.kind === "error");
  return { kind: "list", records };
}

export async function getActiveGarbageCollection(registry, dependencies = {}) {
  const output = dependencies.commandOutput ?? commandOutput;
  try {
    const raw = await output("doctl", ["registry", "garbage-collection", "get-active", registry, "--output", "json"]);
    return parseGarbageCollectionRecord(raw, registry);
  } catch (error) {
    const stderr = `${error?.stderr ?? ""}\n${error?.stdout ?? ""}`;
    if (stderr.includes(ACTIVE_GC_NOT_FOUND_PHRASE)) return { kind: "none" };
    return { kind: "error", reason: "provider-error", detail: compactFailure(error) };
  }
}

export async function listGarbageCollections(registry, dependencies = {}) {
  const output = dependencies.commandOutput ?? commandOutput;
  try {
    const raw = await output("doctl", ["registry", "garbage-collection", "list", registry, "--output", "json"]);
    return parseList(raw, registry);
  } catch (error) {
    return { kind: "error", reason: "provider-error", detail: compactFailure(error) };
  }
}

function refusal(registry, reason, detail, active = false) {
  return {
    schemaVersion: DIGITALOCEAN_REGISTRY_GC_GATE_VERSION,
    repository: registry,
    result: "refused",
    reason,
    detail,
    active,
    rootCauseCode: active ? REGISTRY_GC_READ_ONLY_CODE : "unknown",
  };
}

export async function assertRegistryWritable(registry, dependencies = {}) {
  const active = await getActiveGarbageCollection(registry, dependencies);
  if (active.kind === "none") {
    return {
      schemaVersion: DIGITALOCEAN_REGISTRY_GC_GATE_VERSION,
      repository: registry,
      result: "writable",
      reason: "no-active-garbage-collection",
      active: false,
      rootCauseCode: "",
    };
  }
  if (active.kind === "active") return refusal(registry, "active-garbage-collection", active.status, true);
  return refusal(registry, active.reason, active.detail, false);
}

export async function waitForRegistryGarbageCollection(options, dependencies = {}) {
  const registry = options.registry ?? options.repository;
  const uuid = options.uuid;
  const maxWaitMs = options.maxWaitMs ?? REGISTRY_GC_WAIT_MINUTES * 60_000;
  const pollIntervalMs = options.pollIntervalMs ?? REGISTRY_GC_POLL_INTERVAL_MS;
  const now = dependencies.now ?? (() => Date.now());
  const sleep = dependencies.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const records = [];
  const startedAt = now();
  for (;;) {
    if (dependencies.isCancelled?.() || options.signal?.aborted) {
      return { ...refusal(registry, "cancelled", "garbage-collection wait was cancelled"), records };
    }
    const active = await getActiveGarbageCollection(registry, dependencies);
    records.push(active);
    if (active.kind === "none") {
      if (!uuid) {
        return {
          ...refusal(registry, "missing-garbage-collection-identity", "start did not return a UUID"),
          records,
        };
      }
      const listed = await listGarbageCollections(registry, dependencies);
      if (listed.kind !== "list") {
        return { ...refusal(registry, "list-error", listed.detail), records };
      }
      const terminal = listed.records.find((entry) => entry.uuid === uuid);
      if (!terminal)
        return { ...refusal(registry, "missing-garbage-collection", "started UUID was not listed"), records };
      if (terminal.status === "succeeded") {
        return {
          schemaVersion: DIGITALOCEAN_REGISTRY_GC_GATE_VERSION,
          repository: registry,
          uuid,
          result: "succeeded",
          reason: "terminal-succeeded",
          status: terminal.status,
          active: false,
          rootCauseCode: "",
          records,
        };
      }
      return {
        ...refusal(registry, `terminal-${terminal.status}`, `garbage collection ended ${terminal.status}`),
        uuid,
        status: terminal.status,
        records,
      };
    }
    if (now() - startedAt >= maxWaitMs) {
      return {
        ...refusal(
          registry,
          "wait-timeout",
          `garbage collection did not become terminal within ${maxWaitMs / 60_000} minutes`,
        ),
        uuid,
        records,
      };
    }
    await sleep(Math.min(pollIntervalMs, Math.max(0, maxWaitMs - (now() - startedAt))));
  }
}

export function parseStartedGarbageCollection(raw, registry) {
  const parsed = parseGarbageCollectionRecord(raw, registry);
  return parsed.kind === "active" ? parsed.uuid : null;
}

async function writeRecord(path, record) {
  if (path) await writeFile(path, `${JSON.stringify(record, null, 2)}\n`);
}

async function main(argv) {
  const [command, ...args] = argv;
  const registry = args.find((arg) => arg.startsWith("--registry="))?.slice("--registry=".length);
  if (!registry) throw new Error("--registry=<name> is required");
  const out = args.find((arg) => arg.startsWith("--out="))?.slice("--out=".length);
  if (command === "assert-writable") {
    const record = await assertRegistryWritable(registry);
    await writeRecord(out, record);
    console.log(JSON.stringify(record));
    return record.result === "writable" ? 0 : 1;
  }
  if (command === "wait") {
    const uuid = args.find((arg) => arg.startsWith("--uuid="))?.slice("--uuid=".length);
    const record = await waitForRegistryGarbageCollection({ repository: registry, uuid });
    await writeRecord(out, record);
    console.log(JSON.stringify(record));
    return record.result === "succeeded" ? 0 : 1;
  }
  throw new Error(
    "Usage: digitalocean-registry-gc-gate.mjs assert-writable|wait --registry=<name> [--uuid=<uuid>] [--out=<path>]",
  );
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
