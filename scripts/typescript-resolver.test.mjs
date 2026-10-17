import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { TYPESCRIPT_RESOLUTION_CANDIDATES } from "../infrastructure/platform-runtime/typescript-resolver.mjs";

const execFileAsync = promisify(execFile);
const PINNED_PREDECESSOR_REVISION = "a0fa6d57f739952f2dac5f9b09f5677f2f6823a4";
const PINNED_EXTENSION_LOADER_SOURCE = `import { extname } from "node:path";

export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    if (
      !shouldTryExtension(specifier) ||
      (error?.code !== "ERR_MODULE_NOT_FOUND" && error?.code !== "ERR_UNSUPPORTED_DIR_IMPORT")
    ) {
      throw error;
    }

    for (const extension of [".ts", ".tsx", ".js", ".mjs", "/index.ts", "/index.tsx", "/index.js", "/index.mjs"]) {
      try {
        return await nextResolve(\`\${specifier}\${extension}\`, context);
      } catch (nextError) {
        if (nextError?.code !== "ERR_MODULE_NOT_FOUND" && nextError?.code !== "ERR_UNSUPPORTED_DIR_IMPORT") {
          throw nextError;
        }
      }
    }

    throw error;
  }
}

function shouldTryExtension(specifier) {
  const cleanSpecifier = specifier.split(/[?#]/, 1)[0] ?? specifier;
  return (
    !extname(cleanSpecifier) &&
    (specifier.startsWith(".") || specifier.startsWith("/") || /^[A-Za-z]:[\\\\/]/.test(specifier))
  );
}
`;
const PINNED_SOURCE_LOADER_SOURCE = `export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    if ((specifier.startsWith("./") || specifier.startsWith("../")) && !/\\.[a-z0-9]+$/iu.test(specifier)) {
      return nextResolve(\`\${specifier}.ts\`, context);
    }
    throw error;
  }
}
`;
const candidateModuleUrl = new URL("../infrastructure/platform-runtime/typescript-resolver.mjs", import.meta.url);
const candidateSource = await readFile(candidateModuleUrl, "utf8");
const temporaryRoots = [];
let matrix;

beforeAll(async () => {
  const root = await mkdtemp(path.join(tmpdir(), "typescript-resolver-matrix-"));
  temporaryRoots.push(root);
  matrix = await buildMatrix(root);
});

afterAll(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("TypeScript resolver union", () => {
  it("derives the shipped candidate grammar from the pinned extension-loader source", () => {
    expect(PINNED_PREDECESSOR_REVISION).toMatch(/^[0-9a-f]{40}$/u);
    const arrayLiteral = PINNED_EXTENSION_LOADER_SOURCE.match(/for \(const extension of (\[[^\]]+\])\)/u)?.[1];
    expect(arrayLiteral).toBeDefined();
    expect([...TYPESCRIPT_RESOLUTION_CANDIDATES]).toEqual(JSON.parse(arrayLiteral));
    expect(TYPESCRIPT_RESOLUTION_CANDIDATES).toEqual([
      ".ts",
      ".tsx",
      ".js",
      ".mjs",
      "/index.ts",
      "/index.tsx",
      "/index.js",
      "/index.mjs",
    ]);
  });

  it("matches the predecessor union over all twenty predicate rows and all nine order/URL rows", async () => {
    const results = await runImplementations(matrix, {
      original: null,
      extension: PINNED_EXTENSION_LOADER_SOURCE,
      source: PINNED_SOURCE_LOADER_SOURCE,
      consolidated: candidateSource,
    });

    for (const row of matrix.rows) {
      const expected = results[row.expectedFrom][row.id];
      expect(results.consolidated[row.id], row.id).toEqual(expected);
      if (row.expectedFrom === "original" && !row.expectedUrlSuffix) {
        expect(results.consolidated[row.id].ok, row.id).toBe(false);
        expect(results.consolidated[row.id].message, row.id).toBeTruthy();
      }
      if (row.expectedUrlSuffix) {
        expect(results.consolidated[row.id], row.id).toMatchObject({ ok: true });
        expect(new URL(results.consolidated[row.id].url).pathname, row.id).toMatch(row.expectedUrlSuffix);
      }
      if (row.expectedErrorCode) {
        expect(results.consolidated[row.id], row.id).toMatchObject({ ok: false, code: row.expectedErrorCode });
      }
    }

    expect(results.extension.C02.ok).toBe(false);
    expect(results.source.C02).toEqual(results.consolidated.C02);
    expect(results.extension.C09).toEqual(results.consolidated.C09);
    expect(results.source.C09.ok).toBe(false);
  });

  it("makes every adjacent-order mutant and the file-URL mutant observably red", async () => {
    const required = (await runImplementations(matrix, { required: candidateSource })).required;
    const mutants = Object.fromEntries([
      ...TYPESCRIPT_RESOLUTION_CANDIDATES.slice(0, -1).map((_candidate, index) => [
        `transpose-${index + 1}`,
        transposeCandidates(candidateSource, index),
      ]),
      ["file-url", widenFileUrl(candidateSource)],
    ]);
    const results = await runImplementations(matrix, mutants);
    const predicateRowIds = matrix.rows.filter((row) => row.id.startsWith("C")).map((row) => row.id);

    for (let index = 0; index < 7; index += 1) {
      const mutant = results[`transpose-${index + 1}`];
      expect(project(mutant, predicateRowIds)).toEqual(project(required, predicateRowIds));
      expect(differingRows(required, mutant)).toEqual([`L${index + 1}`]);
    }
    expect(project(results["file-url"], predicateRowIds)).toEqual(project(required, predicateRowIds));
    expect(differingRows(required, results["file-url"])).toEqual(["U1"]);
  });
});

async function buildMatrix(root) {
  await writeFile(path.join(root, "package.json"), '{"type":"module"}\n');
  const loaderRoot = path.join(root, "loaders");
  const caseRoot = path.join(root, "cases");
  await mkdir(loaderRoot, { recursive: true });
  await mkdir(caseRoot, { recursive: true });
  const arbitraryHookPath = path.join(loaderRoot, "arbitrary-error-hook.mjs");
  await writeFile(
    arbitraryHookPath,
    `let failures = new Set();
export function initialize(data) { failures = new Set(data.failures); }
export async function resolve(specifier, context, nextResolve) {
  if (failures.has(\`\${context.parentURL}\\0\${specifier}\`)) {
    const error = new Error(\`SYNTHETIC_RESOLVER_ERROR \${specifier}\`);
    error.code = "SYNTHETIC_RESOLVER_ERROR";
    throw error;
  }
  return nextResolve(specifier, context);
}
`,
  );

  const definitions = [
    row("C01", "./plain", ["plain.ts"], "extension", { expectedUrlSuffix: /\/plain\.ts$/u }),
    row("C02", "./a.b-c", ["a.b-c.ts"], "source", { expectedUrlSuffix: /\/a\.b-c\.ts$/u }),
    row("C03", "./only-tsx.b-c", ["only-tsx.b-c.tsx"], "original"),
    row("C04", "./only-js.b-c", ["only-js.b-c.js"], "original"),
    row("C08", "./noext", ["noext.ts"], "source", {
      arbitrary: true,
      expectedUrlSuffix: /\/noext\.ts$/u,
    }),
    row("C09", "./dir", ["dir/index.ts"], "extension", { expectedUrlSuffix: /\/dir\/index\.ts$/u }),
    row("C10", "./dir/", ["dir/index.ts"], "extension", { expectedUrlSuffix: /\/dir\/index\.ts$/u }),
    row("C11", "./trail.", ["trail..ts"], "source", { expectedUrlSuffix: /\/trail\.\.ts$/u }),
    row("C12", "./onlytsx", ["onlytsx.tsx"], "extension", { expectedErrorCode: "ERR_UNKNOWN_FILE_EXTENSION" }),
    row("C15", "plainbare", [], "original"),
    row("C16", "./missing", [], "original"),
    row("C17", "./plain?v=1", ["plain.ts"], "original"),
    row("C18", "./plain#frag", ["plain.ts"], "original"),
    row("C19", "./plain.ts", ["plain.ts"], "original", { expectedUrlSuffix: /\/plain\.ts$/u }),
    row("C20", "./a.b-c", ["a.b-c.ts"], "source", {
      arbitrary: true,
      expectedUrlSuffix: /\/a\.b-c\.ts$/u,
    }),
    row(
      "L1",
      "./ladder1",
      [...TYPESCRIPT_RESOLUTION_CANDIDATES].map((suffix) => `ladder1${suffix}`),
      "extension",
      {
        expectedUrlSuffix: /\/ladder1\.ts$/u,
      },
    ),
    row(
      "L2",
      "./ladder2",
      TYPESCRIPT_RESOLUTION_CANDIDATES.slice(1).map((suffix) => `ladder2${suffix}`),
      "extension",
      {
        expectedErrorCode: "ERR_UNKNOWN_FILE_EXTENSION",
      },
    ),
    row(
      "L3",
      "./ladder3",
      TYPESCRIPT_RESOLUTION_CANDIDATES.slice(2).map((suffix) => `ladder3${suffix}`),
      "extension",
      {
        expectedUrlSuffix: /\/ladder3\.js$/u,
      },
    ),
    row(
      "L4",
      "./ladder4",
      TYPESCRIPT_RESOLUTION_CANDIDATES.slice(3).map((suffix) => `ladder4${suffix}`),
      "extension",
      {
        expectedUrlSuffix: /\/ladder4\.mjs$/u,
      },
    ),
    row(
      "L5",
      "./ladder5",
      TYPESCRIPT_RESOLUTION_CANDIDATES.slice(4).map((suffix) => `ladder5${suffix}`),
      "extension",
      {
        expectedUrlSuffix: /\/ladder5\/index\.ts$/u,
      },
    ),
    row(
      "L6",
      "./ladder6",
      TYPESCRIPT_RESOLUTION_CANDIDATES.slice(5).map((suffix) => `ladder6${suffix}`),
      "extension",
      {
        expectedErrorCode: "ERR_UNKNOWN_FILE_EXTENSION",
      },
    ),
    row(
      "L7",
      "./ladder7",
      TYPESCRIPT_RESOLUTION_CANDIDATES.slice(6).map((suffix) => `ladder7${suffix}`),
      "extension",
      {
        expectedUrlSuffix: /\/ladder7\/index\.js$/u,
      },
    ),
    row(
      "L8",
      "./ladder8",
      TYPESCRIPT_RESOLUTION_CANDIDATES.slice(7).map((suffix) => `ladder8${suffix}`),
      "extension",
      {
        expectedUrlSuffix: /\/ladder8\/index\.mjs$/u,
      },
    ),
  ];

  const rows = [];
  for (const definition of definitions) rows.push(await materializeRow(caseRoot, definition));
  rows.splice(4, 0, await absoluteRow(caseRoot, "C05", "a.b-c", ["a.b-c.ts"], false));
  rows.splice(5, 0, await driveLetterRow(caseRoot));
  rows.splice(6, 0, await absoluteRow(caseRoot, "C07", "noext", ["noext.ts"], true));
  rows.splice(12, 0, await siblingRow(caseRoot));
  rows.splice(13, 0, await absoluteRow(caseRoot, "C14", "plain", ["plain.ts"], false, "extension", /\/plain\.ts$/u));
  rows.push(await fileUrlRow(caseRoot));
  return { root, loaderRoot, arbitraryHookPath, rows };
}

function row(id, specifier, files, expectedFrom, options = {}) {
  return { id, specifier, files, expectedFrom, ...options };
}

async function materializeRow(caseRoot, definition, driverDirectoryName = definition.id) {
  const directory = path.join(caseRoot, definition.id);
  const driverDirectory = path.join(directory, driverDirectoryName === definition.id ? "" : driverDirectoryName);
  await mkdir(driverDirectory, { recursive: true });
  await writeFixtures(directory, definition.files);
  const driverPath = path.join(driverDirectory, "driver.mjs");
  await writeDriver(driverPath, definition.specifier);
  return { ...definition, driverPath };
}

async function absoluteRow(caseRoot, id, stem, files, arbitrary, expectedFrom = "original", expectedUrlSuffix) {
  const directory = path.join(caseRoot, id);
  await mkdir(directory, { recursive: true });
  await writeFixtures(directory, files);
  const absolute = path.resolve(directory, stem).replaceAll("\\", "/");
  const specifier = process.platform === "win32" ? `/${absolute}` : absolute;
  const driverPath = path.join(directory, "driver.mjs");
  await writeDriver(driverPath, specifier);
  return { id, specifier, files, expectedFrom, arbitrary, expectedUrlSuffix, driverPath };
}

async function driveLetterRow(caseRoot) {
  const directory = path.join(caseRoot, "C06");
  await mkdir(directory, { recursive: true });
  await writeFixtures(directory, ["a.b-c.ts"]);
  const specifier = process.platform === "win32" ? path.join(directory, "a.b-c") : "C:\\dir\\a.b-c";
  const driverPath = path.join(directory, "driver.mjs");
  await writeDriver(driverPath, specifier);
  return { id: "C06", specifier, files: ["a.b-c.ts"], expectedFrom: "original", driverPath };
}

async function siblingRow(caseRoot) {
  const definition = row("C13", "../sibling/plain", ["sibling/plain.ts"], "extension", {
    expectedUrlSuffix: /\/sibling\/plain\.ts$/u,
  });
  return materializeRow(caseRoot, definition, "importer");
}

async function fileUrlRow(caseRoot) {
  const directory = path.join(caseRoot, "U1");
  await mkdir(directory, { recursive: true });
  await writeFixtures(directory, ["urlplain.ts"]);
  const specifier = pathToFileURL(path.join(directory, "urlplain")).href;
  const driverPath = path.join(directory, "driver.mjs");
  await writeDriver(driverPath, specifier);
  return { id: "U1", specifier, files: ["urlplain.ts"], expectedFrom: "original", driverPath };
}

async function writeFixtures(directory, files) {
  for (const relativePath of files) {
    const target = path.join(directory, ...relativePath.split("/"));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, "export const identity = import.meta.url;\n");
  }
}

async function writeDriver(driverPath, specifier) {
  await writeFile(
    driverPath,
    `export async function run() {
  try {
    const loaded = await import(${JSON.stringify(specifier)});
    return { ok: true, url: loaded.identity };
  } catch (error) {
    return { ok: false, code: error?.code ?? null, name: error?.name ?? null, message: error?.message ?? String(error) };
  }
}
`,
  );
}

async function runImplementations(matrixState, implementations) {
  const entries = await Promise.all(
    Object.entries(implementations).map(async ([name, source]) => [
      name,
      await runImplementation(matrixState, name, source),
    ]),
  );
  return Object.fromEntries(entries);
}

async function runImplementation(matrixState, name, source) {
  const loaderPath = path.join(matrixState.loaderRoot, `${name}.mjs`);
  if (source !== null) await writeFile(loaderPath, source);
  const controllerPath = path.join(matrixState.loaderRoot, `controller-${name}.mjs`);
  const failures = matrixState.rows
    .filter((entry) => entry.arbitrary)
    .map((entry) => `${pathToFileURL(entry.driverPath).href}\0${entry.specifier}`);
  await writeFile(
    controllerPath,
    `import { register } from "node:module";
import { pathToFileURL } from "node:url";
register(${JSON.stringify(pathToFileURL(matrixState.arbitraryHookPath).href)}, { parentURL: import.meta.url, data: { failures: ${JSON.stringify(failures)} } });
${source === null ? "" : `register(${JSON.stringify(pathToFileURL(loaderPath).href)}, import.meta.url);`}
const rows = ${JSON.stringify(matrixState.rows.map(({ id, driverPath }) => ({ id, driverPath })))};
const results = {};
for (const row of rows) {
  const driver = await import(pathToFileURL(row.driverPath));
  results[row.id] = await driver.run();
}
console.log(JSON.stringify(results));
`,
  );
  const { stdout, stderr } = await execFileAsync(process.execPath, [controllerPath], {
    cwd: matrixState.root,
    encoding: "utf8",
    env: process.env,
  });
  expect(stderr, `${name} stderr`).toBe("");
  return JSON.parse(stdout.trim());
}

function transposeCandidates(source, index) {
  const candidates = [...TYPESCRIPT_RESOLUTION_CANDIDATES];
  [candidates[index], candidates[index + 1]] = [candidates[index + 1], candidates[index]];
  const arrayPattern = /export const TYPESCRIPT_RESOLUTION_CANDIDATES = Object\.freeze\(\[[\s\S]*?\]\);/u;
  const replacement = `export const TYPESCRIPT_RESOLUTION_CANDIDATES = Object.freeze(${JSON.stringify(candidates)});`;
  const mutant = source.replace(arrayPattern, replacement);
  expect(mutant).not.toBe(source);
  return mutant;
}

function widenFileUrl(source) {
  const anchor = 'specifier.startsWith(".") || specifier.startsWith("/")';
  const mutant = source.replace(
    anchor,
    'specifier.startsWith("file:") || specifier.startsWith(".") || specifier.startsWith("/")',
  );
  expect(mutant).not.toBe(source);
  return mutant;
}

function project(results, ids) {
  return Object.fromEntries(ids.map((id) => [id, results[id]]));
}

function differingRows(left, right) {
  return Object.keys(left).filter((id) => JSON.stringify(left[id]) !== JSON.stringify(right[id]));
}
