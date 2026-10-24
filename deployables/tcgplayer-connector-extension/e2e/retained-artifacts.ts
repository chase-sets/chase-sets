import { readFileSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { unzipSync } from "fflate";

export function scanRetainedArtifacts(directory: string, forbidden: readonly string[]): number {
  let inspected = 0;
  function inspect(bytes: Uint8Array) {
    const text = Buffer.from(bytes).toString("utf8");
    if (forbidden.some((marker) => text.includes(marker))) throw new Error("connector-retained-artifact-secret");
    inspected++;
  }
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      inspected += scanRetainedArtifacts(path, forbidden);
      continue;
    }
    const bytes = readFileSync(path);
    if (!entry.name.endsWith(".zip")) {
      inspect(bytes);
      continue;
    }
    const extracted = resolve(directory, `${entry.name}.extracted`);
    for (const [name, content] of Object.entries(unzipSync(bytes))) {
      const target = resolve(extracted, name);
      if (!target.startsWith(`${extracted}${sep}`)) throw new Error("connector-artifact-path-refused");
      if (name.endsWith("/")) continue;
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);
      inspect(content);
    }
  }
  return inspected;
}
