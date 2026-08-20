import { execFile, execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(".");
const wrapperPath = path.join(repositoryRoot, "infrastructure/platform-runtime/typescript-resolver-register.mjs");
const expectedRegistrationFiles = Object.freeze([
  "infrastructure/platform-runtime/typescript-resolver-register.mjs",
  "scripts/discovery-search-embedding-backfill.mjs",
  "scripts/discovery-search-relevance-embeddings.mjs",
  "scripts/discovery-search-relevance.mjs",
  "scripts/generate-agent-connector-packaging.mjs",
  "scripts/representative-snapshot.mjs",
  "scripts/run-catalog-observation-pack-capture.mjs",
  "scripts/run-catalog-production-completion-report.mjs",
  "scripts/run-catalog-real-provider-proof.mjs",
  "scripts/verify-observation-pack.mjs",
  "scripts/verify-observation-pack.test.mjs",
]);
const registrationPattern =
  /register\("(?:\.\.\/|\.\/)(?:infrastructure\/platform-runtime\/)?typescript-resolver(?:-register)?\.mjs"/gu;
const wrapperPattern =
  /^import \{ register \} from "node:module";\r?\n\r?\nregister\("\.\/typescript-resolver\.mjs", import\.meta\.url\);\r?\n$/u;
const temporaryRoots = [];
let harness;

beforeAll(async () => {
  harness = await createCountingHarness();
});

afterAll(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("TypeScript resolver register wrapper", () => {
  it("contains only the import and one direct registration call", async () => {
    const source = await readFile(wrapperPath, "utf8");
    expect(wrapperPattern.test(source)).toBe(true);
    for (const siblingControl of [
      'import { register } from "node:module";\n',
      `${source}process.on("exit", () => undefined);\n`,
      source.replace("typescript-resolver.mjs", "typescript-resolver-register.mjs"),
      source.replace("import.meta.url", 'new URL(".", import.meta.url)'),
    ]) {
      expect(wrapperPattern.test(siblingControl)).toBe(false);
    }
  });

  it("derives exactly eleven registration lines in eleven sorted files", async () => {
    const sources = await trackedMjsSources();
    const inventory = registrationInventory(sources);
    expect(inventory).toHaveLength(11);
    expect(inventory.map(({ file }) => file)).toEqual(expectedRegistrationFiles);

    const omitted = new Map(sources);
    omitted.set(
      expectedRegistrationFiles[1],
      omitted.get(expectedRegistrationFiles[1]).replace("typescript-resolver.mjs", "typescript-resolver-omitted.mjs"),
    );
    expect(registrationInventory(omitted)).toHaveLength(10);
    expect(registrationInventory(omitted).map(({ file }) => file)).not.toContain(expectedRegistrationFiles[1]);

    const extra = new Map(sources);
    extra.set(
      "scripts/synthetic-extra.mjs",
      ["reg", 'ister("../infrastructure/platform-runtime/typescript-resolver.mjs", import.meta.url);\n'].join(""),
    );
    expect(registrationInventory(extra)).toHaveLength(12);

    extra.set(
      "scripts/synthetic-extra.mjs",
      ["reg", 'ister("../infrastructure/platform-runtime/typescript-resolver-register.mjs", import.meta.url);\n'].join(
        "",
      ),
    );
    expect(registrationInventory(extra)).toHaveLength(12);
  });

  it.each([
    ["eager --import", "eager"],
    ["lazy import", "lazy"],
    ["eager plus lazy", "combined"],
    ["file-URL eager plus relative lazy", "file-url-combined"],
  ])("registers once under %s", async (_label, shape) => {
    await unlink(harness.counterPath).catch(() => undefined);
    const result = await runCountingShape(shape);
    expect(result.stderr).toBe("");
    expect(result.stdout.trim()).toBe("1");
  });

  it("adds no SIGTERM, SIGINT, or exit listeners", async () => {
    const source = `const signals = ["SIGTERM", "SIGINT", "exit"];
const before = Object.fromEntries(signals.map((signal) => [signal, process.listenerCount(signal)]));
await import(${JSON.stringify(pathToFileURL(wrapperPath).href)});
const after = Object.fromEntries(signals.map((signal) => [signal, process.listenerCount(signal)]));
console.log(JSON.stringify({ before, after }));
`;
    const result = await runNode(["--input-type=module", "--eval", source], repositoryRoot);
    expect(result.stderr).toBe("");
    const counts = JSON.parse(result.stdout.trim());
    expect(counts.after).toEqual(counts.before);
  });
});

async function createCountingHarness() {
  const root = await mkdtemp(path.join(tmpdir(), "typescript-resolver-register-"));
  temporaryRoots.push(root);
  const counterPath = path.join(root, "registrations.txt");
  const wrapperCopyPath = path.join(root, "typescript-resolver-register.mjs");
  const hookPath = path.join(root, "typescript-resolver.mjs");
  const lazyChildPath = path.join(root, "lazy-child.mjs");
  const combinedChildPath = path.join(root, "combined-child.mjs");
  await writeFile(wrapperCopyPath, await readFile(wrapperPath, "utf8"));
  await writeFile(
    hookPath,
    `import { appendFileSync } from "node:fs";
export function initialize() { appendFileSync(${JSON.stringify(counterPath)}, "registered\\n"); }
export async function resolve(specifier, context, nextResolve) { return nextResolve(specifier, context); }
`,
  );
  await writeFile(
    lazyChildPath,
    `import { readFileSync } from "node:fs";
await import("./typescript-resolver-register.mjs");
await import("node:path");
console.log(readFileSync(${JSON.stringify(counterPath)}, "utf8").trim().split(/\\r?\\n/u).length);
`,
  );
  await writeFile(
    combinedChildPath,
    `import { readFileSync } from "node:fs";
await import("./typescript-resolver-register.mjs");
await import("node:path");
console.log(readFileSync(${JSON.stringify(counterPath)}, "utf8").trim().split(/\\r?\\n/u).length);
`,
  );
  return { root, counterPath, wrapperCopyPath, lazyChildPath, combinedChildPath };
}

async function runCountingShape(shape) {
  const wrapperUrl = pathToFileURL(harness.wrapperCopyPath).href;
  const wrapperSpecifier = "./typescript-resolver-register.mjs";
  if (shape === "lazy") return runNode([harness.lazyChildPath], harness.root);
  if (shape === "combined") {
    return runNode(["--import", wrapperSpecifier, harness.combinedChildPath], harness.root);
  }
  if (shape === "file-url-combined") {
    return runNode(["--import", wrapperUrl, harness.combinedChildPath], harness.root);
  }
  const source = `import { readFileSync } from "node:fs";
await import("node:path");
console.log(readFileSync(${JSON.stringify(harness.counterPath)}, "utf8").trim().split(/\\r?\\n/u).length);
`;
  return runNode(["--import", wrapperSpecifier, "--input-type=module", "--eval", source], harness.root);
}

async function trackedMjsSources() {
  const files = execFileSync("git", ["ls-files", "*.mjs"], { cwd: repositoryRoot, encoding: "utf8" })
    .split(/\r?\n/u)
    .filter(Boolean);
  return new Map(
    await Promise.all(
      files.map(async (file) => [file.replaceAll("\\", "/"), await readFile(path.join(repositoryRoot, file), "utf8")]),
    ),
  );
}

function registrationInventory(sources) {
  const inventory = [];
  for (const [file, source] of sources) {
    for (const match of source.matchAll(registrationPattern)) inventory.push({ file, index: match.index });
  }
  return inventory.sort((left, right) => left.file.localeCompare(right.file) || left.index - right.index);
}

async function runNode(arguments_, cwd) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, arguments_, {
      cwd,
      encoding: "utf8",
      env: process.env,
    });
    return { status: 0, stdout, stderr };
  } catch (error) {
    throw new Error(`Node child failed (${arguments_.join(" ")}):\n${error.stderr ?? error.message}`);
  }
}
