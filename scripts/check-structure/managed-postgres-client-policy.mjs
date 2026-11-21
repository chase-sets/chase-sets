#!/usr/bin/env node
// Managed Postgres client policy inventory.
//
// Every tracked file (`git ls-files -z --cached`) is read once, assigned a
// grammar from its extension or content, scanned for Postgres client shapes and
// classified. Entrypoints are found by content: workflow jobs, YAML
// `command`/`args` values, Dockerfile instructions and Terraform `local-exec`
// commands. Reachability follows shell text, package scripts, executed path
// strings and the static import graph. An entrypoint holds managed Postgres
// authority when it runs in a pod (runtime Secret URLs), runs Terraform
// `local-exec` (state URLs), or is a workflow job whose steps reach the
// canonical runner URL producer. A direct client reachable from such an
// entrypoint must go through the validated seam; observers and local tools
// without that authority are classified with their execution location. A
// client shape in an unreadable grammar stays INDETERMINATE, and the check
// fails on any INDETERMINATE or unsafe member. No directory walk, basename or
// path vocabulary decides a class.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseAllDocuments } from "yaml";
import { GIT_LISTING_MAX_BUFFER } from "../lib/git-listing.mjs";

export const managedPostgresClientPolicyVersion = "managed-postgres-client-policy/v1";
export const managedPostgresClientPolicySource = "git ls-files -z --cached --stage";
export const MANAGED_AUTHORITY = "managed-authority";

const JS_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
const GRAMMAR_BY_EXTENSION = new Map([
  ...JS_EXTENSIONS.map((extension) => [extension, "javascript"]),
  [".sh", "shell"],
  [".bash", "shell"],
  [".ps1", "shell"],
  [".psm1", "shell"],
  [".yml", "yaml"],
  [".yaml", "yaml"],
  [".tf", "terraform"],
  [".json", "json"],
]);
// Content that no repository entrypoint executes as a client: prose, styles,
// media, fonts, locks, examples, SQL bodies and resolver manifests.
const DATA_EXTENSIONS = new Set([
  ".md",
  ".txt",
  ".css",
  ".html",
  ".svg",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
  ".ico",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".csv",
  ".sql",
  ".lock",
  ".hcl",
  ".toml",
  ".manifest",
  ".example",
  ".gitignore",
  ".gitattributes",
  ".dockerignore",
  ".prettierignore",
  ".npmrc",
]);
const DRIVER_PACKAGES = new Set(["pg", "pg-pool", "pg-native", "postgres", "pg-promise", "knex", "slonik"]);
const PARSER_PACKAGES = new Set(["pg-connection-string"]);
const TEST_PACKAGES = new Set(["vitest", "@playwright/test", "node:test"]);
const CLI_NAMES = "psql|pg_dump|pg_restore|pg_dumpall";
const CLI_LITERAL = new RegExp(`^(?:exec\\s+)?(?:${CLI_NAMES})(?:\\s|$)`, "u");
const SHELL_CLI = new RegExp(`(?<![\\w./-])(?:${CLI_NAMES})(?![\\w./-])`, "gu");
const SHELL_CONTAINER_EXEC = /\b(?:docker|podman|kubectl|compose)\b[^\n;|&]*\bexec\b/u;
// An in-container CLI that names no connection target reaches only the
// container's own local socket. A URL, a URL-valued variable, a libpq host
// variable or a non-socket host names another database.
const CLI_CONNECTION_TARGET =
  /postgres(?:ql)?:\/\/|url|Url|URL|\bPG(?:HOST|HOSTADDR|SERVICE)\b|(?:^|[\s"',[(])(?:-h|--host)(?:=|[\s"',]+)(?![\s"',]*\/)/u;
const WEAK_MODES = "require|prefer|allow|verify-ca|no-verify";
const DOWNGRADES = [
  /\brejectUnauthorized\s*(?<![=!])[:=](?!=)\s*false\b/u,
  /\bNODE_TLS_REJECT_UNAUTHORIZED\s*(?<![=!])[:=](?!=)\s*["']?0\b/u,
  new RegExp(`\\bsslmode\\s*=\\s*(?:${WEAK_MODES})\\b`, "iu"),
  new RegExp(`\\bsslmode["']?\\s*[:,]\\s*["'](?:${WEAK_MODES})["']`, "iu"),
  new RegExp(`\\bPGSSLMODE\\s*(?<![=!])[:=](?!=)\\s*["']?(?:${WEAK_MODES})\\b`, "u"),
];
const COPIED_PARSER = /\.get\(\s*["'](?:sslmode|sslrootcert)["']\s*\)/u;
const SEAM_CALL = /\b(?:createPgPool|createPgClient|admitPostgresClientConnection)\s*\(/u;
const TRUST_CALL = /\b(?:postgresClientConfig|resolvePostgresSsl)\s*\(/u;
const RAW_CONNECTION_KEY = /[{,]\s*connectionString\s*[:,}]/u;
const GENERIC_CLIENT_SHAPE = new RegExp(
  `(?<![\\w./-])(?:${CLI_NAMES}|tokio_postgres|psycopg2?|asyncpg|libpq)(?![\\w./-])|postgres(?:ql)?://|\\bsslmode\\b|\\brejectUnauthorized\\b`,
  "u",
);
// A path string is followed only where it is executed or loaded: inside the
// arguments of a process, loader or URL call, or as a dispatch-table value in a
// module that starts Node child processes.
const EXECUTING_CALLEE = /^(?:spawn\w*|exec\w*|fork|run\w*|tsImport|import|require|register|Worker|URL)$/u;
const ANY = "*";
const COMMAND_BREAK = "\u0001";
// A string that carries its own module imports is a program run elsewhere
// (kubectl exec, heredoc); it is read with the same JavaScript rules.
const EMBEDDED_PROGRAM =
  /^(?=[\s\S]{80})[\s\S]*(?:\bimport\b[^;\n]*\bfrom\s*["'][^"']+["']|\bimport\s*\(\s*["'][^"']+["']|\brequire\s*\(\s*["'][^"']+["'])/u;

export function scanManagedPostgresClientPolicy({ repoRoot = process.cwd(), head } = {}) {
  const entries = listTrackedEntries(repoRoot);
  const tracked = new Set(entries.map((entry) => entry.path));
  const files = new Map();
  for (const entry of entries) files.set(entry.path, readEntry(repoRoot, entry));
  const context = { ...buildResolutionContext(files, tracked), repoRoot, ignored: new Map() };
  for (const file of files.values()) analyze(file, context);
  markOwners(files);
  markAuthority(files);
  const reach = {
    operational: traverse(files, (node) => node.roots.length > 0, false),
    authority: traverse(files, (node) => node.roots.some(holdsManagedAuthority), false),
    tests: traverse(files, (node) => node.testTool, true),
  };
  const members = [];
  const counts = {};
  for (const file of files.values()) {
    const member = classify(file, reach);
    counts[member.class] = (counts[member.class] ?? 0) + 1;
    if (member.class !== "no-client" && member.class !== "data-only") members.push(member);
  }
  const indeterminate = members.filter((member) => member.class === "INDETERMINATE").length;
  // Without exactly one seam owner and one runner URL producer, consumers and
  // managed runner jobs cannot be recognized, so the inventory would pass
  // vacuously; the anchors are reported and checked.
  const anchors = (flag) => [...files.values()].filter((file) => file.facts[flag]).map((file) => file.path);
  return {
    trustAnchors: {
      validatedSeam: anchors("definesSeam"),
      scheduledTrustConfig: anchors("definesTrustConfig"),
      runnerUrlProducer: anchors("definesRunnerProducer"),
    },
    schema: managedPostgresClientPolicyVersion,
    derivation: {
      command: "pnpm run check:managed-postgres-client-policy",
      source: managedPostgresClientPolicySource,
      head: head ?? readHead(repoRoot),
      version: managedPostgresClientPolicyVersion,
    },
    total: entries.length,
    scanned: [...files.values()].filter((file) => file.readable).length,
    handled: entries.length - indeterminate,
    indeterminate,
    unsafe: members.filter((member) => member.class === "unsafe").length,
    classes: Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right))),
    members: members.sort((left, right) => left.path.localeCompare(right.path)),
  };
}

function listTrackedEntries(repoRoot) {
  const output = execFileSync("git", ["ls-files", "-z", "--cached", "--stage"], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: GIT_LISTING_MAX_BUFFER,
    windowsHide: true,
  });
  return output
    .split("\0")
    .filter(Boolean)
    .map((record) => ({ mode: record.slice(0, record.indexOf(" ")), path: record.slice(record.indexOf("\t") + 1) }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

function readHead(repoRoot) {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8", windowsHide: true }).trim();
}

function newNode(id) {
  return {
    path: id,
    roots: [],
    edges: [],
    testTool: false,
    facts: {
      driverImports: [],
      valueImports: [],
      reExports: [],
      cliSites: [],
      downgrades: [],
      copiedParser: false,
      seamCalls: false,
      trustCalls: false,
      rawConnectionKey: false,
    },
  };
}

function readEntry(repoRoot, entry) {
  const file = { ...newNode(entry.path), readable: false, text: "", grammar: "unreadable", subNodes: new Map() };
  if (entry.mode === "160000" || entry.mode === "120000") return { ...file, readable: true, grammar: "data" };
  let bytes;
  try {
    bytes = readFileSync(path.join(repoRoot, entry.path));
  } catch {
    return file;
  }
  file.readable = true;
  if (bytes.subarray(0, 8000).includes(0)) return { ...file, grammar: "data" };
  file.text = bytes.toString("utf8");
  file.grammar = grammarOf(entry.path, file.text);
  return file;
}

function grammarOf(filePath, text) {
  const base = path.posix.basename(filePath);
  if (/\.d\.[cm]?ts$/u.test(base)) return "declaration";
  const extension = path.posix.extname(base).toLowerCase() || (base.startsWith(".") ? base : "");
  if (GRAMMAR_BY_EXTENSION.has(extension)) return GRAMMAR_BY_EXTENSION.get(extension);
  if (DATA_EXTENSIONS.has(extension)) return "data";
  const shebang = /^#!.*\b(node|tsx|bash|sh|pwsh)\b/u.exec(text);
  if (shebang) return shebang[1] === "node" || shebang[1] === "tsx" ? "javascript" : "shell";
  const firstInstruction = text.split(/\r?\n/u).find((line) => line.trim() && !line.trim().startsWith("#"));
  if (firstInstruction && /^\s*(?:FROM|ARG)\s+\S/u.test(firstInstruction) && /^\s*FROM\s+\S/mu.test(text)) {
    return "dockerfile";
  }
  return "unsupported";
}

// ---------------------------------------------------------------------------
// Module resolution derived from tracked package manifests and tsconfig paths.

function buildResolutionContext(files, tracked) {
  const packages = new Map();
  const manifests = new Map();
  const aliases = new Map();
  for (const file of files.values()) {
    if (file.grammar !== "json") continue;
    const manifest = parseJson(file.text) ?? parseJson(stripJsonComments(file.text));
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) continue;
    const directory = path.posix.dirname(file.path);
    if (manifest.scripts && typeof manifest.scripts === "object") {
      file.packageScripts = Object.fromEntries(
        Object.entries(manifest.scripts).filter(([, value]) => typeof value === "string"),
      );
      manifests.set(directory, file.path);
    }
    if (typeof manifest.name === "string" && (manifest.scripts || manifest.exports || manifest.main)) {
      packages.set(manifest.name, { directory, manifest });
    }
    const paths = manifest.compilerOptions?.paths;
    if (paths && typeof paths === "object") {
      const base = joinPath(directory, manifest.compilerOptions.baseUrl ?? ".");
      for (const [key, targets] of Object.entries(paths)) {
        if (!aliases.has(key) && Array.isArray(targets)) {
          aliases.set(
            key,
            targets.map((target) => joinPath(base, target)),
          );
        }
      }
    }
  }
  return { files, tracked, packages, manifests, aliases };
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function stripJsonComments(text) {
  return text
    .replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//gu, (match, string) => string ?? "")
    .replace(/,(\s*[}\]])/gu, "$1");
}

function joinPath(...parts) {
  const joined = path.posix.normalize(path.posix.join(...parts));
  return joined.startsWith("./") ? joined.slice(2) : joined;
}

function resolveFile(candidate, tracked) {
  if (!candidate || candidate.startsWith("..")) return undefined;
  const base = candidate.replace(/\/$/u, "");
  const withoutJs = base.replace(/\.(?:m|c)?js$/u, "");
  const options = [
    base,
    ...JS_EXTENSIONS.map((extension) => `${base}${extension}`),
    ...JS_EXTENSIONS.map((extension) => `${withoutJs}${extension}`),
    ...JS_EXTENSIONS.map((extension) => `${base}/index${extension}`),
  ];
  return options.find((option) => tracked.has(option));
}

function resolveExact(candidate, tracked) {
  return candidate && !candidate.startsWith("..") && tracked.has(candidate) ? candidate : undefined;
}

function resolveSpecifier(specifier, fromDirectory, context) {
  if (specifier.startsWith(".")) return resolveFile(joinPath(fromDirectory, specifier), context.tracked);
  if (specifier.startsWith("node:")) return undefined;
  for (const [key, targets] of context.aliases) {
    const star = key.indexOf("*");
    if (star < 0 ? key !== specifier : !specifier.startsWith(key.slice(0, star))) continue;
    const rest = star < 0 ? "" : specifier.slice(star, specifier.length - (key.length - star - 1));
    for (const target of targets) {
      // split/join substitutes every wildcard and never expands `$` patterns from the specifier.
      const resolved = resolveFile(target.split("*").join(rest), context.tracked);
      if (resolved) return resolved;
    }
  }
  const segments = specifier.split("/");
  const name = specifier.startsWith("@") ? segments.slice(0, 2).join("/") : segments[0];
  const record = context.packages.get(name);
  if (!record) return undefined;
  const subpath = specifier.slice(name.length);
  const target = exportTarget(record.manifest.exports, subpath ? `.${subpath}` : ".");
  return resolveFile(
    joinPath(record.directory, target ?? (subpath ? `.${subpath}` : (record.manifest.main ?? "index"))),
    context.tracked,
  );
}

function exportTarget(exportsField, key) {
  if (typeof exportsField === "string") return key === "." ? exportsField : undefined;
  if (!exportsField || typeof exportsField !== "object") return undefined;
  const value = Object.hasOwn(exportsField, key) ? exportsField[key] : key === "." ? exportsField : undefined;
  return conditionTarget(value);
}

function conditionTarget(value) {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return undefined;
  for (const condition of ["import", "node", "default", "types"]) {
    const target = conditionTarget(value[condition]);
    if (target) return target;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// JavaScript/TypeScript lexing. `code` drops comments; `masked` also blanks
// string contents so brackets and keywords are read only from code.

export function lexJavaScript(source) {
  const literals = [];
  let masked = "";
  let code = "";
  let index = 0;
  let lastSignificant = "";
  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];
    if (char === "/" && next === "/") {
      while (index < source.length && source[index] !== "\n") index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      const end = source.indexOf("*/", index + 2);
      const stop = end < 0 ? source.length : end + 2;
      const blank = source.slice(index, stop).replace(/[^\n]/gu, " ");
      masked += blank;
      code += blank;
      index = stop;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      let end = index + 1;
      let value = "";
      let dynamic = false;
      while (end < source.length && source[end] !== char) {
        if (source[end] === "\\") {
          value += source[end + 1] ?? "";
          end += 2;
          continue;
        }
        if (char === "`" && source[end] === "$" && source[end + 1] === "{") {
          dynamic = true;
          let depth = 1;
          end += 2;
          while (end < source.length && depth > 0) {
            if (source[end] === "{") depth += 1;
            else if (source[end] === "}") depth -= 1;
            end += 1;
          }
          value += "\u0000";
          continue;
        }
        if (char !== "`" && source[end] === "\n") break;
        value += source[end];
        end += 1;
      }
      literals.push({ start: masked.length, length: end - index + 1, value, dynamic });
      masked += char + source.slice(index + 1, end).replace(/[^\n]/gu, " ") + (source[end] ?? "");
      code += source.slice(index, end + 1);
      index = end + 1;
      lastSignificant = char;
      continue;
    }
    if (char === "/" && (lastSignificant === "" || /[(,=:[!&|?{};+\-*%<>~^]/u.test(lastSignificant))) {
      let end = index + 1;
      let inClass = false;
      while (end < source.length && source[end] !== "\n") {
        if (source[end] === "\\") {
          end += 2;
          continue;
        }
        if (source[end] === "[") inClass = true;
        else if (source[end] === "]") inClass = false;
        else if (source[end] === "/" && !inClass) break;
        end += 1;
      }
      if (source[end] === "/") {
        masked += `/${" ".repeat(end - index - 1)}/`;
        code += source.slice(index, end + 1);
        index = end + 1;
        lastSignificant = "/";
        continue;
      }
    }
    masked += char;
    code += char;
    if (!/\s/u.test(char)) lastSignificant = /[\w$]/u.test(char) ? "a" : char;
    index += 1;
  }
  return { masked, code, literals };
}

function importContext(masked, literal) {
  const before = masked.slice(Math.max(0, literal.start - 200), literal.start);
  if (/\bfrom\s*$/u.test(before) || /\bimport\s*$/u.test(before)) return "static";
  if (/\bimport\s*\(\s*$/u.test(before) || /\btsImport\s*\(\s*$/u.test(before)) return "dynamic";
  if (/\b[A-Za-z_$][\w$]*[Rr]equire[\w$]*\s*\(\s*$|\brequire\s*\(\s*$/u.test(before)) return "require";
  return undefined;
}

function typeOnlyImport(masked, literal, kind) {
  if (kind === "dynamic") {
    const before = masked.slice(Math.max(0, literal.start - 40), literal.start);
    const after = masked.slice(literal.start + literal.length, literal.start + literal.length + 40);
    return /\btypeof\s+import\s*\(\s*$/u.test(before) || /^\s*\)\s*\.\s*[A-Z]/u.test(after);
  }
  if (kind !== "static") return false;
  const statementStart = Math.max(masked.lastIndexOf(";", literal.start), masked.lastIndexOf("}\n", literal.start));
  const head = /\b(?:import|export)\b([\s\S]*)$/u.exec(masked.slice(statementStart + 1, literal.start));
  if (!head) return false;
  const clause = head[1].replace(/\bfrom\s*$/u, "").trim();
  if (/^type\b/u.test(clause)) return true;
  const braces = /^\{([\s\S]*)\}$/u.exec(clause);
  return Boolean(braces) && braces[1].split(",").every((entry) => !entry.trim() || /^type\b/u.test(entry.trim()));
}

// One linear pass per masked source records the innermost open bracket before
// every position and each bracket's matching close.
const bracketIndexes = new Map();

function bracketIndex(masked) {
  let index = bracketIndexes.get(masked);
  if (index) return index;
  const inner = new Int32Array(masked.length + 1).fill(-1);
  const close = new Map();
  const stack = [];
  for (let position = 0; position < masked.length; position += 1) {
    inner[position] = stack.length > 0 ? stack[stack.length - 1] : -1;
    const char = masked[position];
    if (char === "(" || char === "[" || char === "{") stack.push(position);
    else if ((char === ")" || char === "]" || char === "}") && stack.length > 0) close.set(stack.pop(), position);
  }
  inner[masked.length] = stack.length > 0 ? stack[stack.length - 1] : -1;
  if (bracketIndexes.size > 4) bracketIndexes.clear();
  index = { inner, close };
  bracketIndexes.set(masked, index);
  return index;
}

function enclosingBracket(masked, position) {
  const { inner, close } = bracketIndex(masked);
  const start = inner[position];
  if (start === undefined || start < 0) return undefined;
  return { open: masked[start], start, end: close.get(start) ?? masked.length };
}

function matchingClose(text, start) {
  let depth = 0;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (char === "(" || char === "[" || char === "{") depth += 1;
    else if (char === ")" || char === "]" || char === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return text.length;
}

function calleeBefore(masked, position) {
  return /([A-Za-z_$][\w$]*)\s*$/u.exec(masked.slice(Math.max(0, position - 80), position))?.[1];
}

// A CLI literal is a client invocation when it is an argv element or the
// program argument of a process call; it runs in a container when that argv
// carries an `exec` element before it, and is admitted when the argv passes the
// connection target through the validated seam.
function cliSiteFor(masked, code, literals, position) {
  const bracket = enclosingBracket(masked, position);
  if (!bracket) return undefined;
  const argvText = masked.slice(bracket.start, bracket.end + 1);
  const connectionTarget = CLI_CONNECTION_TARGET.test(code.slice(bracket.start, bracket.end + 1));
  if (bracket.open === "[") {
    const before = literals.filter((entry) => entry.start > bracket.start && entry.start < position);
    return {
      inContainer: before.some((entry) => entry.value === "exec"),
      connectionTarget,
      admitted: SEAM_CALL.test(argvText),
    };
  }
  if (bracket.open === "(" && /spawn|exec|run|process/iu.test(calleeBefore(masked, bracket.start) ?? "")) {
    return { inContainer: false, connectionTarget, admitted: SEAM_CALL.test(argvText) };
  }
  return undefined;
}

// Returns undefined when the path string is not executed, ANY for an executed
// path, or the selecting command name for a dispatch-table entry.
function executedPath(masked, literals, position, spawnsNode) {
  let cursor = position;
  for (let depth = 0; depth < 4; depth += 1) {
    const bracket = enclosingBracket(masked, cursor);
    if (!bracket) return undefined;
    if (bracket.open === "(" && EXECUTING_CALLEE.test(calleeBefore(masked, bracket.start) ?? "")) return ANY;
    const propertyValue = /[\w$"']\s*:\s*$/u.test(masked.slice(Math.max(0, position - 200), position));
    if (bracket.open === "{" && depth === 0 && spawnsNode && propertyValue) {
      const windowStart = Math.max(0, bracket.start - 200);
      const before = masked.slice(windowStart, bracket.start);
      const separator = /\s*:\s*$/u.exec(before);
      if (!separator) return ANY;
      const keyEnd = windowStart + separator.index;
      const key = literals.find((entry) => entry.start + entry.length === keyEnd);
      const bare = /([\w$-]+)$/u.exec(before.slice(0, separator.index))?.[1];
      return key?.value ?? bare ?? ANY;
    }
    cursor = bracket.start;
  }
  return undefined;
}

function analyzeJavaScript(node, source, context, directory, embedded = false) {
  const { masked, code, literals } = lexJavaScript(source);
  const spawnsNode = /\b(?:spawn|spawnSync|fork|execFile|execFileSync)\s*\(\s*process\.execPath\b/u.test(masked);
  const facts = node.facts;
  if (
    /\bexport\s+function\s+admitPostgresClientConnection\b/u.test(masked) &&
    /\bexport\s+function\s+createPgPool\b/u.test(masked) &&
    /\bexport\s+function\s+createPgClient\b/u.test(masked)
  ) {
    facts.definesSeam = true;
  }
  if (
    /\bexport\s+function\s+postgresClientConfig\b/u.test(masked) &&
    /\bexport\s+function\s+resolvePostgresSsl\b/u.test(masked)
  ) {
    facts.definesTrustConfig = true;
  }
  if (
    /\bexport\s+function\s+managedPostgresRunnerCaPath\b/u.test(masked) &&
    /\bexport\s+function\s+managedPostgresConnectionUrl\b/u.test(masked)
  ) {
    facts.definesRunnerProducer = true;
  }
  for (const literal of literals) {
    const kind = importContext(masked, literal);
    if (kind) {
      const specifier = literal.value;
      if (TEST_PACKAGES.has(specifier)) node.testTool = true;
      const typeOnly = typeOnlyImport(masked, literal, kind) || node.grammar === "declaration";
      const segments = specifier.split("/");
      const packageName = specifier.startsWith("@") ? segments.slice(0, 2).join("/") : segments[0];
      if (DRIVER_PACKAGES.has(packageName) && !typeOnly) facts.driverImports.push({ specifier, kind });
      if (PARSER_PACKAGES.has(packageName) && !typeOnly) facts.copiedParser = true;
      if (literal.dynamic || typeOnly) continue;
      // An embedded program runs from an image that mirrors the repository
      // layout, so its relative imports are also read from the repository root.
      const target =
        resolveSpecifier(specifier, directory, context) ??
        (embedded && specifier.startsWith(".")
          ? resolveFile(joinPath(specifier.replace(/^(?:\.\.?\/)+/u, "")), context.tracked)
          : undefined);
      if (!target) continue;
      node.edges.push({ to: target, via: `import ${specifier}` });
      facts.valueImports.push(target);
      if (/^\s*export\b/u.test(masked.slice(masked.lastIndexOf("\n", literal.start) + 1, literal.start))) {
        facts.reExports.push(target);
      }
      continue;
    }
    if (CLI_LITERAL.test(literal.value)) {
      const windowStart = Math.max(0, literal.start - 120);
      const declaration = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*$/u.exec(
        masked.slice(windowStart, literal.start),
      );
      const positions = declaration
        ? [...masked.matchAll(new RegExp(`(?<![\\w$.])${declaration[1]}(?![\\w$])`, "gu"))]
            .map((match) => match.index)
            .filter((index) => index < windowStart + declaration.index || index > literal.start)
        : [literal.start];
      for (const position of positions) {
        const site = cliSiteFor(masked, code, literals, position);
        if (site) facts.cliSites.push({ ...site, origin: node.path, command: literal.value.split(/\s+/u).at(-1) });
      }
      continue;
    }
    if (!embedded && EMBEDDED_PROGRAM.test(literal.value)) {
      analyzeJavaScript(node, literal.value.replaceAll("\u0000", " "), context, directory, true);
      continue;
    }
    if (literal.dynamic || !/^[\w@.][\w@./-]*\.[A-Za-z]{1,5}$|^\.{1,2}\//u.test(literal.value)) continue;
    const selector = executedPath(masked, literals, literal.start, spawnsNode);
    if (selector === undefined) continue;
    const target =
      resolveFile(joinPath(directory, literal.value), context.tracked) ??
      resolveFile(joinPath(literal.value), context.tracked);
    if (target && target !== node.path) {
      node.edges.push({
        to: target,
        via: `path ${literal.value}`,
        dispatchKey: selector === ANY ? undefined : selector,
      });
    }
  }
  if (SEAM_CALL.test(masked)) facts.seamCalls = true;
  if (TRUST_CALL.test(masked)) facts.trustCalls = true;
  if (RAW_CONNECTION_KEY.test(masked)) facts.rawConnectionKey = true;
  if (COPIED_PARSER.test(code)) facts.copiedParser = true;
  scanDowngrades(code, facts, node.path);
}

function scanDowngrades(text, facts, origin) {
  for (const pattern of DOWNGRADES) {
    const match = pattern.exec(text);
    if (match) facts.downgrades.push({ origin, shape: match[0].slice(0, 80) });
  }
}

// ---------------------------------------------------------------------------
// Shell text: CLI invocations, package scripts and file references.

function analyzeShell(node, text, context, cwd) {
  const facts = node.facts;
  const logical = text.replace(/\\\r?\n/gu, " ");
  const commands = logical
    .split(/\r?\n/u)
    .filter((line) => !line.trim().startsWith("#"))
    .join("\n");
  for (const line of commands.split("\n")) {
    for (const match of line.matchAll(SHELL_CLI)) {
      facts.cliSites.push({
        inContainer: SHELL_CONTAINER_EXEC.test(line.slice(0, match.index)),
        connectionTarget: CLI_CONNECTION_TARGET.test(line),
        admitted: false,
        origin: node.path,
        command: match[0],
      });
    }
  }
  scanDowngrades(commands, facts, node.path);
  // Inline programs (heredocs, -e/-c bodies) are read with the JavaScript rules.
  if (/\b(?:node|tsx|deno|bun)\b/u.test(commands)) analyzeJavaScript(node, commands, context, cwd, true);
  node.edges.push(...shellEdges(commands, cwd, context));
}

function shellEdges(text, cwd, context) {
  const edges = [];
  const words = text
    .replace(/\$\{\{[^}]*\}\}/gu, " $expr ")
    .replace(/[;|&\n]+/gu, ` ${COMMAND_BREAK} `)
    .split(/[\s"'`=()<>]+/u)
    .filter(Boolean);
  const selectorAt = (index) => {
    let cursor = index;
    while (words[cursor] === "--") cursor += 1;
    const word = words[cursor];
    if (!word || word === COMMAND_BREAK || word.includes("$")) return ANY;
    return word.startsWith("-") ? ANY : word;
  };
  for (const [index, word] of words.entries()) {
    const value = word.replace(/^\.\//u, "").replace(/[,:]+$/u, "");
    if (!value || value === COMMAND_BREAK || value.startsWith("-") || value.includes("$")) continue;
    const target =
      resolveExact(joinPath(cwd, value), context.tracked) ?? resolveExact(joinPath(value), context.tracked);
    if (target) {
      edges.push({ to: target, via: `command ${value}`, selector: selectorAt(index + 1) });
    } else if (
      /^[\w.][\w./-]*\.[cm]?js$/u.test(value) &&
      context.manifests.has(cwd || ".") &&
      isIgnoredBuildOutput(context, joinPath(cwd, value))
    ) {
      edges.push({ to: packageSources(context, context.manifests.get(cwd || ".")), via: `built output ${value}` });
    }
  }
  for (let index = 0; index < words.length; index += 1) {
    if (!/^(?:pnpm|npm|yarn)$/u.test(words[index])) continue;
    let directory = cwd;
    const filters = [];
    let cursor = index + 1;
    while (cursor < words.length && words[cursor].startsWith("-")) {
      const flag = words[cursor];
      if (/^(?:--filter|-F)$/u.test(flag)) {
        filters.push(words[cursor + 1] ?? "");
        cursor += 2;
      } else if (/^(?:-C|--dir|--prefix)$/u.test(flag)) {
        directory = joinPath(cwd, words[cursor + 1] ?? ".");
        cursor += 2;
      } else {
        cursor += 1;
      }
    }
    if (words[cursor] === "run" || words[cursor] === "run-script") cursor += 1;
    while (cursor < words.length && words[cursor].startsWith("-") && words[cursor] !== "--") cursor += 1;
    const script = words[cursor];
    if (!script) continue;
    const directories = filters.length
      ? filters.flatMap((filter) => filterDirectories(filter, cwd, context))
      : [directory];
    for (const packageDirectory of directories) {
      const manifestPath = nearestManifest(packageDirectory, context);
      const manifest = manifestPath && context.files.get(manifestPath);
      if (manifest?.packageScripts && Object.hasOwn(manifest.packageScripts, script)) {
        edges.push({
          to: `${manifestPath}#scripts.${script}`,
          via: `script ${script}`,
          selector: selectorAt(cursor + 1),
        });
      }
    }
  }
  return edges;
}

// A git-ignored program inside a package is a build output of that package, so
// executing it executes the package's tracked sources. Other untracked paths
// are not followed.
function isIgnoredBuildOutput(context, candidate) {
  if (!context.ignored.has(candidate)) {
    const result = spawnSync("git", ["check-ignore", "-q", "--no-index", "--", candidate], {
      cwd: context.repoRoot,
      windowsHide: true,
    });
    context.ignored.set(candidate, result.status === 0);
  }
  return context.ignored.get(candidate);
}

// An untracked program inside a package is a build output of that package, so
// executing it executes the package's tracked sources.
function packageSources(context, manifestPath) {
  const file = context.files.get(manifestPath);
  const id = `${manifestPath}#sources`;
  if (file.subNodes.has(id)) return id;
  const node = newNode(id);
  const directory = path.posix.dirname(manifestPath);
  const prefix = directory === "." ? "" : `${directory}/`;
  for (const candidate of context.tracked) {
    if (!candidate.startsWith(prefix) || !JS_EXTENSIONS.includes(path.posix.extname(candidate))) continue;
    if (nearestManifest(path.posix.dirname(candidate), context) !== manifestPath) continue;
    node.edges.push({ to: candidate, via: "package source" });
  }
  file.subNodes.set(id, node);
  return id;
}

function nearestManifest(directory, context) {
  let current = directory || ".";
  for (;;) {
    if (context.manifests.has(current)) return context.manifests.get(current);
    if (current === ".") return undefined;
    current = path.posix.dirname(current);
  }
}

function filterDirectories(filter, cwd, context) {
  const cleaned = filter
    .replace(/^\.\.\./u, "")
    .replace(/\.\.\.$/u, "")
    .replace(/^\{(.*)\}$/u, "$1");
  if (cleaned.startsWith(".")) return [joinPath(cwd, cleaned)];
  if (cleaned.includes("*")) {
    const pattern = new RegExp(`^${cleaned.split("*").map(escapeRegExp).join(".*")}$`, "u");
    return [...context.packages].filter(([name]) => pattern.test(name)).map(([, record]) => record.directory);
  }
  const record = context.packages.get(cleaned);
  return record ? [record.directory] : [];
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

// ---------------------------------------------------------------------------
// Per-grammar analysis.

function analyze(file, context) {
  const directory = path.posix.dirname(file.path);
  switch (file.grammar) {
    case "javascript":
    case "declaration":
      analyzeJavaScript(file, file.text, context, directory);
      return;
    case "shell":
      analyzeShell(file, file.text, context, directory);
      return;
    case "dockerfile":
      analyzeDockerfile(file, context);
      return;
    case "yaml":
      analyzeYaml(file, context);
      return;
    case "terraform":
      analyzeTerraform(file, context);
      return;
    case "json":
      for (const [name, command] of Object.entries(file.packageScripts ?? {})) {
        const node = subNode(file, `scripts.${name}`);
        node.forwardsSelector = true;
        analyzeShell(node, command, context, directory);
      }
      return;
    case "unsupported":
      file.genericShape = GENERIC_CLIENT_SHAPE.test(file.text);
      return;
    default:
  }
}

function subNode(file, key) {
  const id = `${file.path}#${key}`;
  // Sub-nodes are entrypoints or script targets in their own right; the file
  // does not execute them merely by being read or referenced.
  if (!file.subNodes.has(id)) file.subNodes.set(id, newNode(id));
  return file.subNodes.get(id);
}

function addRoot(node, location) {
  if (!node.roots.includes(location)) node.roots.push(location);
}

function analyzeDockerfile(file, context) {
  const logical = file.text.replace(/\\\r?\n/gu, " ");
  for (const [index, line] of logical.split(/\r?\n/u).entries()) {
    const instruction = /^\s*(RUN|CMD|ENTRYPOINT)\s+(.*)$/iu.exec(line);
    if (!instruction) continue;
    const kind = instruction[1].toUpperCase();
    const body = instruction[2].trim().startsWith("[") ? (parseJson(instruction[2]) ?? []).join(" ") : instruction[2];
    const node = subNode(file, `${kind}:${index + 1}`);
    // Build steps hold no runtime Secret; the image command runs in the pod.
    addRoot(node, kind === "RUN" ? "image-build" : `pod:${MANAGED_AUTHORITY}`);
    analyzeShell(node, body, context, ".");
  }
}

function analyzeYaml(file, context) {
  let documents;
  try {
    documents = parseAllDocuments(file.text, { uniqueKeys: false, logLevel: "error" });
  } catch {
    documents = undefined;
  }
  if (!documents || documents.some((document) => document.errors.length > 0)) {
    file.grammar = "unsupported";
    file.genericShape = GENERIC_CLIENT_SHAPE.test(file.text);
    return;
  }
  const directory = path.posix.dirname(file.path);
  for (const [documentIndex, document] of documents.entries()) {
    const value = document.toJS({ maxAliasCount: -1 });
    if (!value || typeof value !== "object") continue;
    if (value.jobs && typeof value.jobs === "object" && Object.hasOwn(value, "on")) {
      analyzeWorkflow(file, value, context);
    } else if (value.runs && typeof value.runs === "object") {
      analyzeAction(file, value.runs, directory, context);
    } else {
      // Compose services run local containers; any other command-bearing
      // YAML (chart values, manifests) runs in a cluster pod with Secret URLs.
      const location =
        value.services && typeof value.services === "object" ? "compose-container" : `pod:${MANAGED_AUTHORITY}`;
      let commandIndex = 0;
      walkCommandKeys(value, (command) => {
        const node = subNode(file, `document${documentIndex}.command${commandIndex++}`);
        addRoot(node, location);
        analyzeShell(node, command, context, ".");
      });
    }
  }
}

function walkCommandKeys(value, visit) {
  if (Array.isArray(value)) {
    for (const item of value) walkCommandKeys(item, visit);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (["command", "args", "entrypoint", "run", "script"].includes(key)) {
      if (typeof child === "string") visit(child);
      else if (Array.isArray(child) && child.every((item) => typeof item === "string")) visit(child.join(" "));
      else walkCommandKeys(child, visit);
    } else {
      walkCommandKeys(child, visit);
    }
  }
}

function analyzeWorkflow(file, workflow, context) {
  const workflowDirectory = workflow.defaults?.run?.["working-directory"] ?? ".";
  for (const [jobId, job] of Object.entries(workflow.jobs)) {
    if (!job || typeof job !== "object") continue;
    const node = subNode(file, `jobs.${jobId}`);
    addRoot(node, "github-runner");
    if (typeof job.uses === "string") addUsesEdge(node, job.uses, context);
    const jobDirectory = job.defaults?.run?.["working-directory"] ?? workflowDirectory;
    for (const step of Array.isArray(job.steps) ? job.steps : []) {
      if (!step || typeof step !== "object") continue;
      if (typeof step.uses === "string") addUsesEdge(node, step.uses, context);
      if (typeof step.run === "string")
        analyzeShell(node, step.run, context, joinPath(step["working-directory"] ?? jobDirectory));
      if (typeof step.with?.script === "string") analyzeJavaScript(node, step.with.script, context, ".");
    }
  }
}

function analyzeAction(file, runs, directory, context) {
  if (typeof runs.main === "string") addEdge(file, joinPath(directory, runs.main), "action main", context);
  if (typeof runs.image === "string" && !runs.image.includes("://")) {
    addEdge(file, joinPath(directory, runs.image), "action image", context);
  }
  for (const step of Array.isArray(runs.steps) ? runs.steps : []) {
    if (!step || typeof step !== "object") continue;
    if (typeof step.uses === "string") addUsesEdge(file, step.uses, context);
    if (typeof step.run === "string") analyzeShell(file, step.run, context, joinPath(step["working-directory"] ?? "."));
  }
}

function addEdge(node, target, via, context) {
  if (context.tracked.has(target)) node.edges.push({ to: target, via });
}

function addUsesEdge(node, uses, context) {
  if (!uses.startsWith("./")) return;
  const target = joinPath(uses.split("@")[0]);
  const resolved = [target, `${target}/action.yml`, `${target}/action.yaml`].find((option) =>
    context.tracked.has(option),
  );
  if (resolved) node.edges.push({ to: resolved, via: `uses ${uses}`, uses: true });
}

function analyzeTerraform(file, context) {
  const code = file.text.replace(/("(?:\\.|[^"\\\n])*")|#[^\n]*|\/\/[^\n]*/gu, (match, string) => string ?? "");
  const directory = path.posix.dirname(file.path);
  scanDowngrades(code, file.facts, file.path);
  let index = 0;
  for (const block of code.matchAll(/provisioner\s+"local-exec"\s*\{/gu)) {
    const body = code.slice(block.index, matchingClose(code, block.index + block[0].length - 1));
    const workingDirectory = /working_dir\s*=\s*"([^"]*)"/u.exec(body)?.[1];
    const moduleDirectory = (value) => value.replace(/\$\{path\.(?:module|root|cwd)\}/gu, directory);
    const cwd = workingDirectory ? joinPath(moduleDirectory(workingDirectory)) : directory;
    const heredoc = /command\s*=\s*<<-?(\w+)\n([\s\S]*?)\n\s*\1/u.exec(body);
    const quoted = /command\s*=\s*"((?:\\.|[^"\\])*)"/u.exec(body);
    const node = subNode(file, `local-exec${index++}`);
    addRoot(node, `terraform-runner:${MANAGED_AUTHORITY}`);
    const command = heredoc?.[2] ?? quoted?.[1];
    if (command === undefined) {
      node.genericShape = true;
      continue;
    }
    analyzeShell(node, moduleDirectory(command), context, cwd);
  }
}

// ---------------------------------------------------------------------------
// Owners, authority, reachability and classification.

function allNodes(files) {
  return [...files.values()].flatMap((file) => [file, ...file.subNodes.values()]);
}

function nodeById(files, id) {
  const hash = id.indexOf("#");
  if (hash < 0) return files.get(id);
  return files.get(id.slice(0, hash))?.subNodes.get(id);
}

function markOwners(files) {
  const seamOwners = [...files.values()].filter((file) => file.facts.definesSeam);
  const trustOwners = [...files.values()].filter((file) => file.facts.definesTrustConfig);
  for (const file of seamOwners) file.seamOwner = seamOwners.length === 1 ? "unique" : "duplicate";
  for (const file of trustOwners) file.trustOwner = trustOwners.length === 1 ? "unique" : "duplicate";
  const forwards = (file, owner, seen = new Set()) => {
    if (!file || seen.has(file.path)) return false;
    seen.add(file.path);
    return Boolean(file[owner]) || file.facts.reExports.some((target) => forwards(files.get(target), owner, seen));
  };
  for (const node of allNodes(files)) {
    node.importsSeam = node.facts.valueImports.some((target) => forwards(files.get(target), "seamOwner"));
    node.importsTrust = node.facts.valueImports.some((target) => forwards(files.get(target), "trustOwner"));
  }
}

// A workflow job holds managed authority when its steps (through local actions
// and the commands they run) reach the canonical runner URL producer.
function markAuthority(files) {
  const producers = new Set(
    [...files.values()].filter((file) => file.facts.definesRunnerProducer).map((file) => file.path),
  );
  for (const node of allNodes(files)) {
    if (!node.roots.includes("github-runner")) continue;
    // Follow what the job executes (local actions, package scripts, commands),
    // not the import graph of the programs it runs.
    const seen = new Set([node.path]);
    const queue = [node];
    let holds = false;
    while (queue.length > 0 && !holds) {
      const current = queue.shift();
      for (const edge of current.edges) {
        if (producers.has(edge.to)) holds = true;
        const executes = edge.uses || /^(?:script|command|action) /u.test(`${edge.via} `);
        const target = nodeById(files, edge.to);
        if (!executes || !target || seen.has(edge.to)) continue;
        seen.add(edge.to);
        queue.push(target);
      }
    }
    node.roots = [holds ? `github-runner:${MANAGED_AUTHORITY}` : "github-runner"];
  }
}

// Breadth-first reachability keyed by (node, command selector): a dispatch
// table entry is followed only for the command that selected it, and package
// scripts forward the arguments they were invoked with.
function traverse(files, isStart, fromTests) {
  const states = new Map();
  const queue = [];
  const visit = (id, selector, parent, via, locations) => {
    const key = `${id}\u0000${selector}`;
    const existing = states.get(key);
    if (!existing) {
      states.set(key, { id, selector, parent, via, locations: new Set(locations) });
      queue.push(key);
      return;
    }
    const before = existing.locations.size;
    for (const location of locations) existing.locations.add(location);
    if (existing.locations.size !== before) queue.push(key);
  };
  for (const node of allNodes(files)) {
    if (!isStart(node)) continue;
    const locations = fromTests ? ["test-runner"] : node.roots;
    visit(node.path, ANY, undefined, fromTests ? "test" : `entrypoint ${locations.join("+")}`, locations);
  }
  for (let index = 0; index < queue.length; index += 1) {
    const state = states.get(queue[index]);
    const node = nodeById(files, state.id);
    for (const edge of node?.edges ?? []) {
      if (edge.dispatchKey !== undefined && state.selector !== ANY && state.selector !== edge.dispatchKey) continue;
      // Reachability follows test-library files too; their exemption is a
      // classification decision made after managed reachability is known.
      const target = nodeById(files, edge.to);
      if (!target) continue;
      const selector =
        edge.selector && edge.selector !== ANY
          ? edge.selector
          : node.forwardsSelector && edge.selector === ANY
            ? state.selector
            : ANY;
      visit(edge.to, selector, queue[index], edge.via, state.locations);
    }
  }
  const nodes = new Map();
  for (const [key, state] of states) {
    const entry = nodes.get(state.id) ?? { key, locations: new Set() };
    for (const location of state.locations) entry.locations.add(location);
    nodes.set(state.id, entry);
  }
  return {
    has: (id) => nodes.has(id),
    locations: (id) => [...(nodes.get(id)?.locations ?? [])],
    chain: (id) => {
      const chain = [];
      let key = nodes.get(id)?.key;
      while (key && chain.length < 16) {
        const state = states.get(key);
        chain.unshift(`${state.id} (${state.via})`);
        key = state.parent;
      }
      return chain;
    },
  };
}

function holdsManagedAuthority(location) {
  return location.endsWith(`:${MANAGED_AUTHORITY}`);
}

function classify(file, reach) {
  const base = { path: file.path, grammar: file.grammar };
  if (!file.readable) return { ...base, class: "INDETERMINATE", reasons: ["unreadable-tracked-file"] };
  if (file.grammar === "data") return { ...base, class: "data-only" };
  const nodes = [file, ...file.subNodes.values()];
  if (file.grammar === "unsupported") {
    return file.genericShape
      ? { ...base, class: "INDETERMINATE", reasons: ["client-shape-in-unsupported-grammar"] }
      : { ...base, class: "no-client" };
  }
  const facts = {
    driverImports: nodes.flatMap((node) => node.facts.driverImports.map((entry) => ({ ...entry, node }))),
    cliSites: nodes.flatMap((node) => node.facts.cliSites),
    downgrades: nodes.flatMap((node) => node.facts.downgrades),
    copiedParser: nodes.some((node) => node.facts.copiedParser),
    seamCalls: nodes.some((node) => node.facts.seamCalls && node.importsSeam),
    trustCalls: nodes.some((node) => node.facts.trustCalls && node.importsTrust),
    rawConnectionKey: nodes.some((node) => node.facts.rawConnectionKey),
    genericShape: nodes.some((node) => node.genericShape),
  };
  const hasShape =
    facts.driverImports.length > 0 ||
    facts.cliSites.length > 0 ||
    facts.downgrades.length > 0 ||
    facts.copiedParser ||
    facts.seamCalls ||
    facts.trustCalls ||
    facts.genericShape ||
    file.seamOwner ||
    file.trustOwner;
  if (!hasShape) return { ...base, class: "no-client" };
  const reachedNodes = nodes.filter((node) => reach.operational.has(node.path));
  const locations = [...new Set(reachedNodes.flatMap((node) => reach.operational.locations(node.path)))].sort();
  const authority = (node) => reach.authority.has(node.path);
  const member = {
    ...base,
    // A member no static entrypoint reaches runs only when an operator invokes it.
    locations: locations.length > 0 ? locations : ["operator-invoked"],
    reachability: reachedNodes.length > 0 ? reach.operational.chain(reachedNodes[0].path) : [],
  };
  // A test-library file is exempt only while no managed entrypoint runs it.
  if (file.testTool && !nodes.some(authority)) return { ...member, class: "test-tool", locations: ["test-runner"] };
  if (facts.genericShape) return { ...member, class: "INDETERMINATE", reasons: ["unrecognized-local-exec-command"] };
  if (file.seamOwner === "duplicate" || file.trustOwner === "duplicate") {
    return { ...member, class: "INDETERMINATE", reasons: ["duplicate-trust-owner"] };
  }
  const owner = Boolean(file.seamOwner || file.trustOwner);
  const trustClient = facts.trustCalls && !facts.rawConnectionKey;
  const reasons = facts.downgrades.map((downgrade) => `tls-downgrade ${downgrade.shape}`);
  if (facts.copiedParser && !owner && !trustClient) reasons.push("copied-parser");
  const bypassing = facts.driverImports.filter((entry) => !owner && !trustClient && authority(entry.node));
  if (bypassing.length > 0) reasons.push("seam-bypass-driver");
  for (const site of facts.cliSites) {
    if (site.admitted || !authority(nodeOf(nodes, site.origin))) continue;
    // A container exec is exempt only with local-socket evidence: no named connection target.
    if (!site.inContainer) reasons.push(`bare-postgres-cli ${site.command}`);
    else if (site.connectionTarget) reasons.push(`in-container-cli-target ${site.command}`);
  }
  const authorityChain = [
    ...bypassing.map((entry) => entry.node),
    ...facts.cliSites.map((site) => nodeOf(nodes, site.origin)),
  ].find(authority);
  if (reasons.length > 0) {
    return {
      ...member,
      class: "unsafe",
      reasons: [...new Set(reasons)],
      reachability: authorityChain ? reach.authority.chain(authorityChain.path) : member.reachability,
    };
  }
  if (file.seamOwner) return { ...member, class: "validated-seam-owner" };
  if (file.trustOwner) return { ...member, class: "scheduled-trust-owner" };
  if (trustClient && facts.driverImports.length > 0) return { ...member, class: "scheduled-trust-client" };
  if (facts.driverImports.length > 0 || facts.cliSites.some((site) => !site.inContainer && !site.admitted)) {
    if (reachedNodes.length > 0) return { ...member, class: "runner-local-tool" };
    if (reach.tests.has(file.path)) {
      return {
        ...member,
        class: "test-support",
        locations: ["test-runner"],
        reachability: reach.tests.chain(file.path),
      };
    }
    return { ...member, class: "local-tool" };
  }
  if (facts.seamCalls) return { ...member, class: "validated-seam-consumer" };
  if (facts.cliSites.some((site) => site.admitted)) return { ...member, class: "seam-admitted-cli" };
  if (facts.cliSites.length > 0) return { ...member, class: "in-container-cli" };
  if (facts.trustCalls) return { ...member, class: "scheduled-trust-consumer" };
  return { ...member, class: "INDETERMINATE", reasons: ["unclassified-client-shape"] };
}

function nodeOf(nodes, id) {
  return nodes.find((node) => node.path === id) ?? nodes[0];
}

// ---------------------------------------------------------------------------

export function managedPostgresClientPolicyFailures(report) {
  const failures = [];
  if (report.handled + report.indeterminate !== report.total) failures.push("partition-mismatch");
  if (report.scanned !== report.total) failures.push("unscanned-tracked-files");
  if (report.trustAnchors.validatedSeam.length !== 1) failures.push("validated-seam-not-unique");
  if (report.trustAnchors.runnerUrlProducer.length !== 1) failures.push("runner-url-producer-not-unique");
  if (report.indeterminate > 0) failures.push("indeterminate-members");
  if (report.unsafe > 0) failures.push("unsafe-members");
  return failures;
}

function main() {
  const args = process.argv.slice(2);
  const outIndex = args.indexOf("--out");
  if (args.some((arg, index) => arg !== "--out" && index !== outIndex + 1) || (outIndex >= 0 && !args[outIndex + 1])) {
    throw new Error("Usage: managed-postgres-client-policy.mjs [--out <path>]");
  }
  const out = outIndex >= 0 ? args[outIndex + 1] : "artifacts/managed-postgres-client-policy/inventory.json";
  const report = scanManagedPostgresClientPolicy();
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    `managed-postgres-client-policy ${report.derivation.version} at ${report.derivation.head}: scanned ${report.scanned}/${report.total}; ` +
      `HANDLED ${report.handled} + INDETERMINATE ${report.indeterminate} = ${report.handled + report.indeterminate}; ` +
      `unsafe ${report.unsafe}; members ${report.members.length}; artifact ${out}`,
  );
  console.log(
    `classes: ${Object.entries(report.classes)
      .map(([name, count]) => `${name}=${count}`)
      .join(" ")}`,
  );
  for (const member of report.members.filter((entry) => entry.class === "unsafe" || entry.class === "INDETERMINATE")) {
    console.error(`${member.class}: ${member.path}: ${(member.reasons ?? []).join("; ")}`);
    if (member.reachability.length > 0) console.error(`  reached: ${member.reachability.join(" -> ")}`);
  }
  const failures = managedPostgresClientPolicyFailures(report);
  if (failures.length > 0) {
    console.error(`managed-postgres-client-policy failed: ${failures.join(", ")}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
