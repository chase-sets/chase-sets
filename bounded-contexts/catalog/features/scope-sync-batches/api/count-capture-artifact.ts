import { lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { countCaptureContainsForbidden, validateCountLifecycleReceipt } from "../domain/count-lifecycle-receipt";

const refused = () => new Error("count-capture-artifact-refused");

async function artifactDirectory(workspace: string, create: boolean) {
  let directory = resolve(workspace);
  for (const part of ["artifacts", "catalog-count-lifecycle"]) {
    directory = join(directory, part);
    if (create)
      await mkdir(directory, { recursive: false, mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      });
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw refused();
  }
  return directory;
}

export async function validateCountCaptureArtifacts(forbiddenValues: readonly string[], workspace = process.cwd()) {
  try {
    const directory = await artifactDirectory(workspace, false);
    const entries = await readdir(directory, { withFileTypes: true });
    if (entries.length !== 1 || entries[0]!.name !== "receipt.json" || !entries[0]!.isFile()) throw refused();
    const path = join(directory, "receipt.json");
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 128_000) throw refused();
    const serialized = await readFile(path, "utf8");
    if (countCaptureContainsForbidden(serialized, forbiddenValues)) throw refused();
    const verdict = validateCountLifecycleReceipt(JSON.parse(serialized), forbiddenValues);
    if (!verdict.valid) throw refused();
    return verdict;
  } catch {
    throw refused();
  }
}

// The runner writes only this projection, once, and scans the exact upload
// directory again at the upload boundary. Raw responses and traces never enter it.
export async function writeCountCaptureArtifact(
  receipt: unknown,
  forbiddenValues: readonly string[],
  workspace = process.cwd(),
) {
  try {
    const verdict = validateCountLifecycleReceipt(receipt, forbiddenValues);
    if (!verdict.valid) throw refused();
    const directory = await artifactDirectory(workspace, true);
    if ((await readdir(directory)).length !== 0) throw refused();
    await writeFile(join(directory, "receipt.json"), `${JSON.stringify(receipt)}\n`, { flag: "wx", mode: 0o600 });
    return await validateCountCaptureArtifacts(forbiddenValues, workspace);
  } catch {
    throw refused();
  }
}
