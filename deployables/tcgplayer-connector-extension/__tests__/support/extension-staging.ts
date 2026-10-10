import { createHash } from "node:crypto";
import { cpSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

export function extensionFiles(directory: string): { name: string; sha256: string }[] {
  const visit = (path: string): { name: string; sha256: string }[] =>
    readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
      const file = join(path, entry.name);
      if (entry.isDirectory()) return visit(file);
      if (!entry.isFile()) throw new Error("extension-staging-non-file");
      return [
        {
          name: relative(directory, file).replaceAll("\\", "/"),
          sha256: createHash("sha256").update(readFileSync(file)).digest("hex"),
        },
      ];
    });
  return visit(directory).sort((a, b) => a.name.localeCompare(b.name));
}

export function attestExtensionFiles(source: string, destination: string) {
  const evidence = {
    source,
    destination,
    sourceFiles: extensionFiles(source),
    stagedFiles: extensionFiles(destination),
  };
  if (!isDeepStrictEqual(evidence.sourceFiles, evidence.stagedFiles))
    throw new Error(`extension-staging-mismatch: ${JSON.stringify(evidence)}`);
  return evidence;
}

export function stageExtension(source: string, destination: string) {
  const contains = (parent: string, child: string) => {
    const path = relative(parent, child);
    return (
      path === "" ||
      (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`))
    );
  };
  source = resolve(source);
  destination = resolve(destination);
  if (contains(source, destination) || contains(destination, source))
    throw new Error("extension-staging-overlapping-paths");
  // Validate the complete source before clearing any stale destination assets.
  extensionFiles(source);
  rmSync(destination, { recursive: true, force: true });
  cpSync(source, destination, { recursive: true });
  return attestExtensionFiles(source, destination);
}
