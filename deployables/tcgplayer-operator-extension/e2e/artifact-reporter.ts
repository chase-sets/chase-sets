import { readFileSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { createHash } from "node:crypto";
import type { FullResult, Reporter } from "@playwright/test/reporter";

export default class OperatorArtifactReporter implements Reporter {
  onEnd(result: FullResult) {
    const root = resolve(import.meta.dirname, "../../../artifacts/operator-extension");
    mkdirSync(root, { recursive: true });
    const cookie = Buffer.from(["SYNTHETIC", "OPERATOR", "COOKIE", "CHROMIUM"].join("_"));
    const grant = Buffer.from("A".repeat(43));
    const files = readdirSync(root, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name !== "artifact-scan.json")
      .map((entry) => {
        const path = join(entry.parentPath, entry.name);
        const bytes = readFileSync(path);
        return {
          path: relative(root, path).replaceAll("\\", "/"),
          sha256: createHash("sha256").update(bytes).digest("hex"),
          cookieMarkers: bytes.includes(cookie) ? 1 : 0,
          grantMarkers: bytes.includes(grant) ? 1 : 0,
          unexpectedArchive: /\.(zip|gz|tar|7z)$/i.test(path),
        };
      });
    // Tracing/video are disabled for this synthetic credential probe. Refuse any
    // unexpected archive rather than pretending a compressed byte scan proves absence.
    const clean = files.every((file) => !file.cookieMarkers && !file.grantMarkers && !file.unexpectedArchive);
    writeFileSync(
      join(root, "artifact-scan.json"),
      JSON.stringify({ syntheticOnly: true, clean, files }, null, 2) + "\n",
    );
    return { status: clean ? result.status : ("failed" as const) };
  }
}
