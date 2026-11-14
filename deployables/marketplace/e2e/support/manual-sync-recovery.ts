import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

type OwnedRecoveryInput = Readonly<{
  ownershipId: string;
  connectionId: string;
  listingId: string;
  inventoryItemId: string;
  createdAfter: string;
}>;
type OwnedRecoveryReceipt = Readonly<{
  version: 1;
  ownershipId: string;
  connectionId: string;
  listingId: string;
  runId: string;
  runRevision: 0;
}>;

// Closed on-demand Node bridge: https://github.com/chase-sets/chase-sets/issues/11137.
export async function createManualSyncBrowserRecovery(
  fixture: OwnedRecoveryInput,
  metadata: Readonly<{ channelsDatabaseUrl?: unknown; catalogDatabaseUrl?: unknown }>,
): Promise<OwnedRecoveryReceipt> {
  const fail = () => new Error("owned-recovery-child-failed");
  if (process.env.PLAYWRIGHT_SKIP_WEB_SERVER === "true") throw fail();
  const serialized = JSON.stringify({
    version: 1,
    fixture,
    databases: { channels: metadata.channelsDatabaseUrl, catalog: metadata.catalogDatabaseUrl },
  });
  if (Buffer.byteLength(serialized) > 8192) throw fail();
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
  const facade = path.join(root, "bounded-contexts/channels/support/seed-support/manual-sync-browser.ts");
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "SystemRoot", "TEMP", "TMP", "TMPDIR"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(process.execPath, ["--import", "tsx", facade, "--owned-recovery-stdin"], {
      cwd: root,
      shell: false,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {
    throw fail();
  }
  let invalid = false;
  let exited = false;
  let exitCode: number | null = null;
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let outBytes = 0;
  let errBytes = 0;
  child.stdout!.on("data", (chunk: Buffer) => {
    outBytes += Buffer.byteLength(chunk);
    if (outBytes <= 2048) stdout.push(Buffer.from(chunk));
    else invalid = true;
  });
  child.stderr!.on("data", (chunk: Buffer) => {
    errBytes += Buffer.byteLength(chunk);
    if (errBytes <= 2048) stderr.push(Buffer.from(chunk));
    if (errBytes > 2048) invalid = true;
  });
  child.stdout!.on("error", () => {
    invalid = true;
  });
  child.stderr!.on("error", () => {
    invalid = true;
  });
  child.on("error", () => {
    invalid = true;
  });
  child.stdin!.on("error", () => {
    invalid = true;
  });
  child.once("exit", (code) => {
    exited = true;
    exitCode = code;
  });
  const closed = new Promise<number | null>((resolve) => child.once("close", resolve));
  let closeCode: number | null;
  try {
    try {
      child.stdin!.end(serialized);
    } catch {
      invalid = true;
      child.stdin!.destroy();
    }
    closeCode = await closed;
  } finally {
    child.stdin!.destroy();
  }
  if (invalid || !exited || exitCode !== 0 || closeCode !== 0 || errBytes !== 0) {
    const text = errBytes <= 2048 ? Buffer.concat(stderr).toString("utf8") : "";
    const reason =
      /^OWNED_RECOVERY_FAILED (owned-recovery-(?:input-required|database-required|database-not-local|web-server-required|listing-required|listing-collision|connection-required|run-collision|member-required|initial-state-required|close-failed)|type-error|unexpected-error)\n$/.exec(
        text,
      )?.[1];
    const loaderCode =
      /\b(ERR_MODULE_NOT_FOUND|ERR_PACKAGE_PATH_NOT_EXPORTED|ERR_UNKNOWN_FILE_EXTENSION|ERR_UNSUPPORTED_DIR_IMPORT|ERR_REQUIRE_ESM|ERR_REQUIRE_ASYNC_MODULE)\b/.exec(
        text,
      )?.[1];
    throw reason || loaderCode ? new Error(`owned-recovery-child-failed: ${reason ?? loaderCode}`) : fail();
  }
  let receipt: unknown;
  try {
    receipt = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(stdout)));
  } catch {
    throw fail();
  }
  if (
    !receipt ||
    typeof receipt !== "object" ||
    Array.isArray(receipt) ||
    Object.keys(receipt).sort().join(",") !== "connectionId,listingId,ownershipId,runId,runRevision,version"
  )
    throw fail();
  const value = receipt as Record<string, unknown>;
  if (
    value.version !== 1 ||
    value.ownershipId !== fixture.ownershipId ||
    value.connectionId !== fixture.connectionId ||
    value.listingId !== fixture.listingId ||
    value.runId !== `run-browser-recovery-${fixture.ownershipId}` ||
    value.runRevision !== 0
  )
    throw fail();
  return value as OwnedRecoveryReceipt;
}
