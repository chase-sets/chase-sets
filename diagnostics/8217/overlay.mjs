import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

const path = "deployables/platform-api/vitest.config.ts";
const original = readFileSync(path);
const hash = createHash("sha256").update(original).digest("hex");
const text = original.toString("utf8");
const anchor = '    include: ["__tests__/**/*.test.ts"],';
if (text.split(anchor).length !== 2 || text.includes("reporters:")) {
  throw new Error("Unexpected platform API config; refusing diagnostic overlay");
}
if (!process.env.CAPACITY_REPORTER) throw new Error("CAPACITY_REPORTER is required");
const addition = '    reporters: ["default", process.env.CAPACITY_REPORTER],';
const result = text.replace(anchor, `${anchor}\n${addition}`);
writeFileSync(`${process.env.CAPTURE_DIR}/vitest-original.sha256`, `${hash}  ${path}\n`);
writeFileSync(`${process.env.CAPTURE_DIR}/vitest-overlay.diff`, `@@ -6,0 +7 @@\n+${addition}\n`);
writeFileSync(path, result);
