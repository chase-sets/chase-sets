import { execFile, execFileSync } from "node:child_process";
import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);
const PINNED_EXTENSION_LOADER_SOURCE = `import { extname } from "node:path";
export async function resolve(specifier, context, nextResolve) {
  try { return await nextResolve(specifier, context); } catch (error) {
    const cleanSpecifier = specifier.split(/[?#]/, 1)[0] ?? specifier;
    const eligible = !extname(cleanSpecifier) &&
      (specifier.startsWith(".") || specifier.startsWith("/") || /^[A-Za-z]:[\\\\/]/.test(specifier)) &&
      (error?.code === "ERR_MODULE_NOT_FOUND" || error?.code === "ERR_UNSUPPORTED_DIR_IMPORT");
    if (!eligible) throw error;
    for (const extension of [".ts", ".tsx", ".js", ".mjs", "/index.ts", "/index.tsx", "/index.js", "/index.mjs"]) {
      try { return await nextResolve(\`\${specifier}\${extension}\`, context); }
      catch (nextError) {
        if (nextError?.code !== "ERR_MODULE_NOT_FOUND" && nextError?.code !== "ERR_UNSUPPORTED_DIR_IMPORT") throw nextError;
      }
    }
    throw error;
  }
}
`;
const PINNED_SOURCE_LOADER_SOURCE = `export async function resolve(specifier, context, nextResolve) {
  try { return await nextResolve(specifier, context); } catch (error) {
    if ((specifier.startsWith("./") || specifier.startsWith("../")) && !/\\.[a-z0-9]+$/iu.test(specifier)) {
      return nextResolve(\`\${specifier}.ts\`, context);
    }
    throw error;
  }
}
`;
const walkerSource = `import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = path.resolve(process.argv[2]);
const traversalRoot = path.resolve(process.argv[3]);
const rootUrl = pathToFileURL(traversalRoot + path.sep).href;
const entryUrl = pathToFileURL(path.resolve(process.argv[4])).href;
const queue = [entryUrl];
const seen = new Set(queue);
const edges = [];
const errors = [];

while (queue.length > 0) {
  const moduleUrl = queue.shift();
  let source;
  try {
    source = await readFile(fileURLToPath(moduleUrl), "utf8");
  } catch {
    continue;
  }
  for (const specifier of literalSpecifiers(source)) {
    if (specifier.startsWith("node:") || specifier.startsWith("data:")) continue;
    try {
      const resolved = import.meta.resolve(specifier, moduleUrl);
      edges.push({ from: moduleUrl.slice(rootUrl.length), specifier, resolved });
      if (resolved.startsWith(rootUrl) && !resolved.includes("/node_modules/") && !seen.has(resolved)) {
        seen.add(resolved);
        queue.push(resolved);
      }
    } catch (error) {
      const code = error?.code ?? error?.name ?? null;
      edges.push({ from: moduleUrl.slice(rootUrl.length), specifier, resolved: null, code });
      errors.push({ from: moduleUrl.slice(rootUrl.length), specifier, code });
    }
  }
}

edges.sort(compareRecords);
errors.sort(compareRecords);
console.log(JSON.stringify({
  modules: [...seen].map((url) => url.slice(rootUrl.length)).sort(),
  edges,
  errors,
}));

function literalSpecifiers(source) {
  const specifiers = new Set();
  for (const match of source.matchAll(/(?:^|[\\s;{(])(?:import|export)\\s[^'"();]*?from\\s*["']([^"']+)["']/gmu)) specifiers.add(match[1]);
  for (const match of source.matchAll(/(?:^|[^.\\w])import\\s*\\(\\s*["']([^"']+)["']/gmu)) specifiers.add(match[1]);
  for (const match of source.matchAll(/^\\s*(?:import|export)\\s+["']([^"']+)["']/gmu)) specifiers.add(match[1]);
  for (const match of source.matchAll(/^\\s*export\\s+\\*\\s+from\\s*["']([^"']+)["']/gmu)) specifiers.add(match[1]);
  return [...specifiers];
}

function compareRecords(left, right) {
  return JSON.stringify(left).localeCompare(JSON.stringify(right));
}
`;

export async function discoverDirectCallers(repositoryRoot) {
  const directRegistration = [
    "reg",
    'ister("../infrastructure/platform-runtime/typescript-resolver.mjs", import.meta.url)',
  ].join("");
  const tracked = execFileSync("git", ["ls-files", "*.mjs"], { cwd: repositoryRoot, encoding: "utf8" })
    .split(/\r?\n/u)
    .filter(Boolean);
  const matches = [];
  for (const file of tracked) {
    const source = await readFile(path.join(repositoryRoot, file), "utf8");
    if (source.includes(directRegistration)) {
      matches.push(file.replaceAll("\\", "/"));
    }
  }
  return matches.sort();
}

export async function createHarness(repositoryRoot) {
  const root = await mkdtemp(path.join(tmpdir(), "typescript-resolver-parity-"));
  const candidateHookUrl = pathToFileURL(
    path.join(repositoryRoot, "infrastructure/platform-runtime/typescript-resolver.mjs"),
  ).href;
  const extensionHook = path.join(root, "pinned-extension-loader.mjs");
  const sourceHook = path.join(root, "pinned-source-loader.mjs");
  const candidateShim = path.join(root, "candidate-register.mjs");
  const extensionShim = path.join(root, "extension-register.mjs");
  const sourceShim = path.join(root, "source-register.mjs");
  const walker = path.join(root, "walker.mjs");
  const parentProbe = path.join(root, "parent-probe.mjs");
  await writeFile(extensionHook, PINNED_EXTENSION_LOADER_SOURCE);
  await writeFile(sourceHook, PINNED_SOURCE_LOADER_SOURCE);
  await writeFile(candidateShim, registerShim(candidateHookUrl));
  await writeFile(extensionShim, registerShim(pathToFileURL(extensionHook).href));
  await writeFile(sourceShim, registerShim(pathToFileURL(sourceHook).href));
  await writeFile(walker, walkerSource);
  await writeFile(
    parentProbe,
    `import { pathToFileURL } from "node:url";
const parentUrl = pathToFileURL(process.argv[2]).href;
console.log(JSON.stringify({
  relative: import.meta.resolve("./plain", parentUrl),
  missing: import.meta.resolve("./definitely-does-not-exist-xyz.ts", parentUrl),
}));
`,
  );
  return {
    root,
    repositoryRoot,
    walker,
    parentProbe,
    candidateShim: pathToFileURL(candidateShim).href,
    predecessorShims: {
      extension: pathToFileURL(extensionShim).href,
      source: pathToFileURL(sourceShim).href,
    },
  };
}

function registerShim(hookUrl) {
  return `import { register } from "node:module";\nregister(${JSON.stringify(hookUrl)}, import.meta.url);\n`;
}

export async function walkClosure(harness, registerShimPath, callerPath, traversalRoot = harness.repositoryRoot) {
  const result = await runNode(
    [
      "--experimental-import-meta-resolve",
      "--import",
      registerShimPath,
      harness.walker,
      harness.repositoryRoot,
      traversalRoot,
      callerPath,
    ],
    harness.repositoryRoot,
  );
  return JSON.parse(result.stdout.trim());
}

export async function exists(filePath) {
  try {
    await access(filePath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function runNode(arguments_, cwd, expectSuccess = true) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, arguments_, {
      cwd,
      encoding: "utf8",
      env: process.env,
      maxBuffer: 8 * 1024 * 1024,
    });
    const result = { status: 0, stdout, stderr };
    if (expectSuccess && stderr !== "") throw new Error(`Unexpected Node stderr: ${stderr}`);
    return result;
  } catch (error) {
    const result = { status: error.code, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
    if (expectSuccess) throw new Error(`Node child failed (${arguments_.join(" ")}):\n${result.stderr}`);
    return result;
  }
}
