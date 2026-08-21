import { createHash, randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const digest = (value) => createHash("sha256").update(value).digest("hex");
const stages = Object.freeze([
  "mid-read",
  "mid-build",
  "validation",
  "reference-validation",
  "oracle-validation",
  "receipt-validation",
  "pre-commit",
  "rename",
  "post-commit",
]);
export const transactionProtocol = Object.freeze({
  schema: "playwright-evidence-transaction/v1",
  states: ["absent", "staging", "validated", "published"],
  failureStages: stages,
  commit: "one-same-volume-atomic-rename",
  contentTransform: "forbidden",
});

function exact(value, keys, code) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())
  )
    throw new Error(code);
}

const instant = (value) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value);

export function validateTransactionReceipt(receipt) {
  exact(receipt, ["schema", "createdAt", "status", "payload", "timings", "code"], "TRANSACTION_RECEIPT_OPEN");
  exact(receipt.payload, ["files", "bytes", "digest"], "TRANSACTION_PAYLOAD_OPEN");
  exact(receipt.timings, ["elapsedMs"], "TRANSACTION_TIMING_OPEN");
  const bounded =
    instant(receipt.createdAt) &&
    Number.isSafeInteger(receipt.payload.files) &&
    receipt.payload.files >= 1 &&
    Number.isSafeInteger(receipt.payload.bytes) &&
    receipt.payload.bytes >= 0 &&
    /^[a-f0-9]{64}$/.test(receipt.payload.digest) &&
    Number.isSafeInteger(receipt.timings.elapsedMs) &&
    receipt.timings.elapsedMs >= 0 &&
    receipt.timings.elapsedMs <= 60_000;
  if (!bounded) throw new Error("TRANSACTION_RECEIPT_BOUNDS");
  return receipt;
}

function walk(root) {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .flatMap((entry) => {
      const file = path.join(root, entry.name);
      return entry.isDirectory() ? walk(file) : entry.isFile() ? [file] : [];
    })
    .sort();
}

function treeDigest(root, files = walk(root)) {
  const rows = files.map(
    (file) =>
      `${path.relative(root, file).replaceAll("\\", "/")}:${readFileSync(file).length}:${digest(readFileSync(file))}`,
  );
  return {
    files: rows.length,
    bytes: rows.reduce((sum, row) => sum + Number(row.split(":")[1]), 0),
    digest: digest(rows.join("\n")),
  };
}

function contained(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function census(transactionRoot, destination, staging) {
  const destinationFiles = walk(destination);
  const receiptFiles = destinationFiles.filter((file) => path.basename(file) === "transaction-receipt.json");
  return {
    staging: { directories: existsSync(staging) ? 1 : 0, files: walk(staging).length },
    destination: { directories: existsSync(destination) ? 1 : 0, files: destinationFiles.length },
    receipt: { files: receiptFiles.length },
    uploadEligible: { paths: existsSync(destination) && receiptFiles.length === 1 ? 1 : 0 },
    registry: {
      entries: readdirSync(transactionRoot, { withFileTypes: true }).filter(
        (entry) => entry.isDirectory() && entry.name.startsWith("published-"),
      ).length,
    },
  };
}

/* `validators` keeps the protocol candidate-neutral: it runs whatever fallible payload, reference and
   oracle validation the caller supplies, and it runs all of it inside staging before the one rename. */
export function runTransaction({
  source,
  transactionRoot,
  destination = path.join(transactionRoot, "published-authority"),
  inject = null,
  validators = {},
}) {
  if (!stages.includes(inject) && inject !== null) throw new Error("INJECTION_STAGE_INVALID");
  mkdirSync(transactionRoot, { recursive: true });
  if (!contained(transactionRoot, destination) || !existsSync(source) || existsSync(destination))
    throw new Error("TRANSACTION_ROOT_OR_STATE_REFUSED");
  const staging = path.join(transactionRoot, `.staging-${randomUUID()}`);
  const started = performance.now();
  let committed = false;
  try {
    mkdirSync(staging);
    const sourceFiles = walk(source);
    if (!sourceFiles.length) throw new Error("SOURCE_EMPTY");
    for (const [index, file] of sourceFiles.entries()) {
      if (inject === "mid-read" && index === 0) throw new Error("INJECT_MID_READ");
      const target = path.join(staging, path.relative(source, file));
      mkdirSync(path.dirname(target), { recursive: true });
      cpSync(file, target);
      if (inject === "mid-build" && index === Math.floor(sourceFiles.length / 2)) throw new Error("INJECT_MID_BUILD");
    }
    const sourceTree = treeDigest(source, sourceFiles);
    if (inject === "validation" || JSON.stringify(sourceTree) !== JSON.stringify(treeDigest(staging)))
      throw new Error("PAYLOAD_VALIDATION_FAILED");
    const staged = walk(staging).map((file) => [
      path.relative(staging, file).replaceAll("\\", "/"),
      readFileSync(file),
    ]);
    for (const stage of ["reference-validation", "oracle-validation"]) {
      if (inject === stage) throw new Error(`INJECT_${stage.toUpperCase().replaceAll("-", "_")}`);
      validators[stage]?.(staged);
    }
    const receipt = {
      schema: "transaction-receipt/v1",
      createdAt: new Date().toISOString(),
      status: "published",
      payload: sourceTree,
      timings: { elapsedMs: Math.ceil(performance.now() - started) },
      code: "ATOMIC_COMMIT",
    };
    writeFileSync(path.join(staging, "transaction-receipt.json"), `${JSON.stringify(receipt)}\n`);
    if (inject === "receipt-validation") writeFileSync(path.join(staging, "transaction-receipt.json"), "{}\n");
    const readReceipt = JSON.parse(readFileSync(path.join(staging, "transaction-receipt.json"), "utf8"));
    validateTransactionReceipt(readReceipt);
    if (readReceipt.payload.digest !== sourceTree.digest) throw new Error("RECEIPT_VALIDATION_FAILED");
    if (inject === "pre-commit") throw new Error("INJECT_PRE_COMMIT");
    if (
      path.parse(staging).root !== path.parse(destination).root ||
      path.dirname(staging) !== path.dirname(destination)
    )
      throw new Error("COMMIT_NOT_SAME_VOLUME");
    if (inject === "rename") throw new Error("INJECT_RENAME");
    renameSync(staging, destination);
    committed = true;
    if (inject === "post-commit") throw new Error("INJECT_POST_COMMIT");
    return { status: "PUBLISHED", code: "ATOMIC_COMMIT", census: census(transactionRoot, destination, staging) };
  } catch (error) {
    if (!committed) rmSync(staging, { recursive: true, force: true });
    return {
      status: committed ? "PUBLISHED_CALLER_FAILURE" : "ROLLED_BACK",
      code: String(error.message).replace(/[^A-Z_]/g, "") || "BOUNDED_FAILURE",
      census: census(transactionRoot, destination, staging),
    };
  }
}

export function resetTransaction({ transactionRoot, destination = path.join(transactionRoot, "published-authority") }) {
  if (!contained(transactionRoot, destination)) throw new Error("RESET_TARGET_REFUSED");
  mkdirSync(transactionRoot, { recursive: true });
  rmSync(destination, { recursive: true, force: true });
  for (const entry of readdirSync(transactionRoot, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name.startsWith(".staging-"))
      rmSync(path.join(transactionRoot, entry.name), { recursive: true, force: true });
  }
  return { staging: 0, destination: 0, receipt: 0, uploadEligible: 0, registry: 0 };
}

export function verifyTransactionHarness({ source, transactionRoot, validators = {} }) {
  const observations = [];
  for (const inject of [null, ...stages]) {
    resetTransaction({ transactionRoot });
    const result = runTransaction({ source, transactionRoot, inject, validators });
    const complete =
      result.census.destination.directories === 1 &&
      result.census.receipt.files === 1 &&
      result.census.uploadEligible.paths === 1;
    const zero = Object.values(result.census).every((entry) => Object.values(entry).every((value) => value === 0));
    if (inject === null || inject === "post-commit") {
      if (!complete) throw new Error("COMPLETE_PUBLICATION_MISSING");
    } else if (!zero) throw new Error("ROLLBACK_RESIDUE");
    observations.push({ inject: inject ?? "none", status: result.status, code: result.code, census: result.census });
  }
  resetTransaction({ transactionRoot });
  return validateConformanceReceipt({
    schema: "transaction-conformance/v1",
    observedAt: new Date().toISOString(),
    observations,
  });
}

export function validateConformanceReceipt(receipt) {
  exact(receipt, ["schema", "observedAt", "observations"], "CONFORMANCE_RECEIPT_OPEN");
  if (!instant(receipt.observedAt) || receipt.observations.length !== stages.length + 1)
    throw new Error("CONFORMANCE_RECEIPT_BOUNDS");
  const partitions = {
    staging: ["directories", "files"],
    destination: ["directories", "files"],
    receipt: ["files"],
    uploadEligible: ["paths"],
    registry: ["entries"],
  };
  for (const row of receipt.observations) {
    exact(row, ["inject", "status", "code", "census"], "CONFORMANCE_ROW_OPEN");
    exact(row.census, Object.keys(partitions), "CONFORMANCE_CENSUS_OPEN");
    for (const [name, value] of Object.entries(row.census)) {
      exact(value, partitions[name], "CONFORMANCE_PARTITION_OPEN");
      if (Object.values(value).some((count) => !Number.isSafeInteger(count) || count < 0 || count > 100_000))
        throw new Error(`CONFORMANCE_${name.toUpperCase()}_BOUNDS`);
    }
  }
  return receipt;
}
