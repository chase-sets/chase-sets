import { lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, posix, resolve } from "node:path";
import {
  countCaptureContainsForbidden,
  countLifecycleArtifactPath,
  countLifecycleReceiptMaxBytes,
  validateCountLifecycleReceipt,
  type CountLifecycleValidation,
} from "../domain/count-lifecycle-receipt";

// Every refusal is the same value-free error: callers learn that the projection
// was refused, never which marker, field or value caused it.
const refused = () => new Error("count-capture-artifact-refused");
const directoryParts = posix.dirname(countLifecycleArtifactPath).split("/");
const fileName = posix.basename(countLifecycleArtifactPath);

async function artifactDirectory(workspace: string, create: boolean) {
  let directory = resolve(workspace);
  for (const part of directoryParts) {
    directory = join(directory, part);
    if (create)
      await mkdir(directory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      });
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw refused();
  }
  return directory;
}

// The final upload-boundary scan: the directory holds exactly the one receipt
// file, which is bounded, leak-free and still a valid, self-classified receipt.
export async function validateCountCaptureArtifacts(
  forbiddenValues: readonly string[],
  workspace = process.cwd(),
): Promise<CountLifecycleValidation> {
  try {
    const directory = await artifactDirectory(workspace, false);
    const entries = await readdir(directory, { withFileTypes: true });
    if (entries.length !== 1 || entries[0]!.name !== fileName || !entries[0]!.isFile()) throw refused();
    const path = join(directory, fileName);
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > countLifecycleReceiptMaxBytes) throw refused();
    const serialized = await readFile(path, "utf8");
    if (countCaptureContainsForbidden(serialized, forbiddenValues)) throw refused();
    const validation = validateCountLifecycleReceipt(JSON.parse(serialized), forbiddenValues);
    if (!validation.valid) throw refused();
    return validation;
  } catch {
    throw refused();
  }
}

// Writes the one validated projection, create-once, then re-reads it through the
// same final scan. Raw responses, traces and session state never enter it. The
// file holds exactly the serialized bytes the validator bounded, nothing appended.
export async function writeCountCaptureArtifact(
  receipt: unknown,
  forbiddenValues: readonly string[],
  workspace = process.cwd(),
): Promise<CountLifecycleValidation> {
  try {
    const serialized = JSON.stringify(receipt);
    if (
      Buffer.byteLength(serialized) > countLifecycleReceiptMaxBytes ||
      !validateCountLifecycleReceipt(JSON.parse(serialized), forbiddenValues).valid
    )
      throw refused();
    const directory = await artifactDirectory(workspace, true);
    if ((await readdir(directory)).length !== 0) throw refused();
    await writeFile(join(directory, fileName), serialized, { flag: "wx", mode: 0o600 });
    return await validateCountCaptureArtifacts(forbiddenValues, workspace);
  } catch {
    throw refused();
  }
}
