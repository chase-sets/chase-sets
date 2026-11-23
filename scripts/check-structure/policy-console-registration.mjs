// A platform policy is only operator-tunable if an operator can author a
// document for it, and the platform policy console is the generic authoring
// surface: it answers 404 for any policy key that is not in its registry.
// This guard fails when a `definePolicy` declaration is neither registered in
// that registry nor on the reviewed exception list
// (scripts/check-structure/policy-console-registration-exceptions.mjs). See
// docs/architecture/platform-policy-conventions.md.
//
// Deliberately textual, like scripts/check-structure/business-literal-guard.mjs:
//
//   - A declaration is `definePolicy`, then an optional type-argument list
//     read with balanced angle brackets across lines, then `(`. Its symbol is
//     the constant the call initializes (annotated or not) or the enclosing
//     factory function. A call in any other shape fails closed, and so does
//     any use of the name that is not a direct call (an alias, a renamed
//     import, an optional call): only prose in a comment, a plain
//     import/export specifier, `typeof definePolicy` and the function's own
//     definition pass unread.
//   - A registered name is one inside a `definitions: [...]` array of the
//     cross-context sources in the platform API composition root, or inside
//     Platform Operations' `ownPolicyDefinitions`. A mention anywhere else
//     (a public policy source, a resolver) does not count.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { GIT_LISTING_MAX_BUFFER } from "../lib/git-listing.mjs";
import { policyConsoleRegistrationExceptions } from "./policy-console-registration-exceptions.mjs";

export const policyConsoleCrossContextRegistrationFile = "deployables/platform-api/src/app.ts";
export const policyConsoleOwnRegistrationFile =
  "bounded-contexts/platform-operations/support/runtime-support/services.ts";

const exceptionListFile = "scripts/check-structure/policy-console-registration-exceptions.mjs";
const identifierPattern = "[A-Za-z_$][\\w$]*";
const testPathPattern = /(^|\/)(?:__tests__|tests|fixtures|test-fixtures|test-support)(\/|$)/;
const testSupportFileNamePattern = /(?:^|[/-])test-support\.(?:ts|tsx|mts|cts)$/;

export function isPolicyDeclarationGuardedFile(relativePath) {
  const normalized = relativePath.replaceAll("\\", "/");
  if (!/\.(?:ts|tsx|mts|cts)$/.test(normalized)) return false;
  if (/\.d\.(?:ts|mts|cts)$/.test(normalized)) return false;
  if (/\.(?:test|spec)\.(?:ts|tsx|mts|cts)$/.test(normalized)) return false;
  if (testPathPattern.test(normalized)) return false;
  if (testSupportFileNamePattern.test(normalized)) return false;
  return true;
}

function lineAt(content, index) {
  let line = 1;
  for (
    let cursor = content.indexOf("\n");
    cursor !== -1 && cursor < index;
    cursor = content.indexOf("\n", cursor + 1)
  ) {
    line += 1;
  }
  return line;
}

function skipWhitespace(content, index) {
  let cursor = index;
  while (cursor < content.length && /\s/.test(content[cursor])) cursor += 1;
  return cursor;
}

function hasOpenQuote(text) {
  return ['"', "'", "`"].some((quote) => text.split(quote).length % 2 === 0);
}

// A mention in prose is not a call. Only a comment that provably holds the
// match is skipped; anything else is read as code.
function isCommentMention(content, index) {
  const lineStart = content.lastIndexOf("\n", index - 1) + 1;
  const before = content.slice(lineStart, index);
  if (/^\s*\*/.test(before)) return true;
  const blockOpen = before.lastIndexOf("/*");
  if (blockOpen !== -1 && !before.includes("*/", blockOpen)) return true;
  for (let at = before.indexOf("//"); at !== -1; at = before.indexOf("//", at + 2)) {
    if (!hasOpenQuote(before.slice(0, at))) return true;
  }
  return false;
}

// Reads `<...>` from its opening bracket and returns the index after the
// matching close, or -1 when the list never closes. `=>` inside a function
// type is not a closing bracket.
function readTypeArguments(content, openIndex) {
  let depth = 0;
  for (let cursor = openIndex; cursor < content.length; cursor += 1) {
    const character = content[cursor];
    if (character === "<") depth += 1;
    if (character === ">" && content[cursor - 1] !== "=") {
      depth -= 1;
      if (depth === 0) return cursor + 1;
    }
  }
  return -1;
}

// Reads a type annotation from just after its `:` and returns the index of
// the `=` that ends it, or -1 when there is none before `limit`.
function readTypeAnnotation(content, startIndex, limit) {
  let depth = 0;
  for (let cursor = startIndex; cursor < limit; cursor += 1) {
    const character = content[cursor];
    if (character === "=" && content[cursor + 1] === ">") {
      cursor += 1;
      continue;
    }
    if ("<({[".includes(character)) depth += 1;
    if (">)}]".includes(character)) depth -= 1;
    if (character === "=" && depth === 0) return cursor;
  }
  return -1;
}

function constantSymbolAt(content, callIndex) {
  const declarations = [...content.slice(0, callIndex).matchAll(new RegExp(`\\bconst\\s+(${identifierPattern})`, "g"))];
  const nearest = declarations.at(-1);
  if (!nearest) return null;

  let cursor = skipWhitespace(content, nearest.index + nearest[0].length);
  if (content[cursor] === ":") {
    cursor = readTypeAnnotation(content, cursor + 1, callIndex);
    if (cursor === -1) return null;
  }
  if (content[cursor] !== "=" || content[cursor + 1] === "=" || content[cursor + 1] === ">") return null;
  return skipWhitespace(content, cursor + 1) === callIndex ? nearest[1] : null;
}

function factorySymbolAt(content, callIndex) {
  const head = content.slice(0, callIndex);
  const functions = [...head.matchAll(new RegExp(`\\bfunction(?:\\s+|\\s*\\*\\s*)(${identifierPattern})`, "g"))];
  for (const candidate of functions.reverse()) {
    const sinceCandidate = head.slice(candidate.index);
    const opened = sinceCandidate.split("{").length - sinceCandidate.split("}").length;
    if (opened > 0) return candidate[1];
  }
  return null;
}

// `definePolicy` as one name in an `import { ... }` or `export { ... }` list,
// not renamed: followed by `,` or `}` inside braces opened by the keyword.
function isModuleSpecifierMention(content, nameIndex, afterIndex) {
  if (content[afterIndex] !== "," && content[afterIndex] !== "}") return false;
  const open = content.lastIndexOf("{", nameIndex);
  if (open === -1 || content.slice(open, nameIndex).includes("}")) return false;
  return /\b(?:import|export)(?:\s+type)?\s*$/.test(content.slice(0, open));
}

function notACallViolation(relativeFile, line) {
  return `${relativeFile}:${line}: definePolicy is used here without being called directly (an alias, a renamed import, an optional call, or a type-argument list the guard cannot read to its call); call definePolicy directly so the policy console registration guard can see the declaration`;
}

/**
 * Every `definePolicy` call in one source file, as `{ file, symbol, line }`,
 * plus a violation for each use the scanner cannot read as a nameable call.
 */
export function findPolicyDeclarations({ relativeFile, content }) {
  const declarations = [];
  const violations = [];

  for (const match of content.matchAll(/\bdefinePolicy\b/g)) {
    const nameIndex = match.index;
    const line = lineAt(content, nameIndex);
    let cursor = skipWhitespace(content, nameIndex + match[0].length);
    if (isCommentMention(content, nameIndex)) continue;
    const before = content.slice(0, nameIndex);
    // The shared machinery's own `function definePolicy<Value>(...)`.
    if (/\bfunction\s+$/.test(before)) continue;
    // `typeof definePolicy` names the function's type and declares nothing.
    if (/\btypeof\s+$/.test(before)) continue;

    if (content[cursor] !== "<" && content[cursor] !== "(") {
      if (isModuleSpecifierMention(content, nameIndex, cursor)) continue;
      violations.push(notACallViolation(relativeFile, line));
      continue;
    }

    if (content[cursor] === "<") {
      const afterTypeArguments = readTypeArguments(content, cursor);
      if (afterTypeArguments === -1) {
        violations.push(
          `${relativeFile}:${line}: definePolicy has a type-argument list that never closes; the policy console registration guard cannot read this declaration`,
        );
        continue;
      }
      cursor = skipWhitespace(content, afterTypeArguments);
      if (content[cursor] !== "(") {
        violations.push(notACallViolation(relativeFile, line));
        continue;
      }
    }

    const symbol = constantSymbolAt(content, nameIndex) ?? factorySymbolAt(content, nameIndex);
    if (!symbol) {
      violations.push(
        `${relativeFile}:${line}: definePolicy call is neither the initializer of a constant nor inside a named factory function; declare the policy as an exported constant or a named factory so the policy console registration guard can name it`,
      );
      continue;
    }
    declarations.push({ file: relativeFile, symbol, line });
  }

  return { declarations, violations };
}

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

function namesInArrays(source, arrayPattern) {
  // A commented-out list registers nothing.
  const arrays = [...source.matchAll(arrayPattern)].filter((array) => !isCommentMention(source, array.index));
  return {
    arrayCount: arrays.length,
    names: arrays.flatMap((array) => stripComments(array[1]).match(new RegExp(identifierPattern, "g")) ?? []),
  };
}

/** The policy names the console's two registration lists carry. */
export function findRegisteredPolicyNames({ crossContextSource, ownSource }) {
  const crossContext = namesInArrays(crossContextSource ?? "", /\bdefinitions\s*:\s*\[([^\]]*)\]/g);
  const own = namesInArrays(ownSource ?? "", /\bownPolicyDefinitions\s*=\s*\[([^\]]*)\]/g);
  return {
    crossContextArrayCount: crossContext.arrayCount,
    ownArrayCount: own.arrayCount,
    fileByName: new Map([
      ...crossContext.names.map((name) => [name, policyConsoleCrossContextRegistrationFile]),
      ...own.names.map((name) => [name, policyConsoleOwnRegistrationFile]),
    ]),
  };
}

function exceptionKey({ file, symbol }) {
  return `${file}#${symbol}`;
}

/**
 * Checks one already-loaded set of source records (`relativePath` + `source`,
 * or `relativePath` + `readError`) and returns the declaration inventory with
 * its violations. `exceptions` defaults to the reviewed list; tests inject a
 * synthetic one.
 */
export function findPolicyConsoleRegistrationViolations(
  sourceRecords,
  { exceptions = policyConsoleRegistrationExceptions } = {},
) {
  const violations = [];
  const declarations = [];
  const registrationSources = new Map();

  for (const record of sourceRecords) {
    const relativeFile = record.relativePath.replaceAll("\\", "/");
    if (!isPolicyDeclarationGuardedFile(relativeFile)) continue;
    if (record.readError !== undefined) {
      violations.push(
        `${relativeFile}: ${record.readError}; the policy console registration guard fails closed on unreadable tracked files`,
      );
      continue;
    }
    if (
      relativeFile === policyConsoleCrossContextRegistrationFile ||
      relativeFile === policyConsoleOwnRegistrationFile
    ) {
      registrationSources.set(relativeFile, record.source);
    }
    if (!record.source.includes("definePolicy")) continue;
    const found = findPolicyDeclarations({ relativeFile, content: record.source });
    declarations.push(...found.declarations);
    violations.push(...found.violations);
  }

  const registration = findRegisteredPolicyNames({
    crossContextSource: registrationSources.get(policyConsoleCrossContextRegistrationFile),
    ownSource: registrationSources.get(policyConsoleOwnRegistrationFile),
  });
  if (registration.crossContextArrayCount === 0) {
    violations.push(
      `${policyConsoleCrossContextRegistrationFile}: no \`definitions: [...]\` array found; the policy console registration guard no longer sees the cross-context registration lists`,
    );
  }
  if (registration.ownArrayCount !== 1) {
    violations.push(
      `${policyConsoleOwnRegistrationFile}: expected exactly one \`ownPolicyDefinitions = [...]\` array, found ${registration.ownArrayCount}; the policy console registration guard no longer sees Platform Operations' own registration list`,
    );
  }

  const declarationsBySymbol = new Map();
  for (const declaration of declarations) {
    declarationsBySymbol.set(declaration.symbol, [
      ...(declarationsBySymbol.get(declaration.symbol) ?? []),
      declaration,
    ]);
  }
  for (const [symbol, sameName] of declarationsBySymbol) {
    if (sameName.length > 1) {
      violations.push(
        `${sameName.map(({ file, line }) => `${file}:${line}`).join(", ")}: policy declaration name ${symbol} is declared more than once; registration is matched by name, so each declaration needs its own name`,
      );
    }
  }
  for (const [name, registrationFile] of registration.fileByName) {
    if (!declarationsBySymbol.has(name)) {
      violations.push(
        `${registrationFile}: registered policy name ${name} matches no definePolicy declaration; register the declared constant itself so the policy console registration guard can match it`,
      );
    }
  }

  const exceptionKeys = new Set();
  const declarationKeys = new Set(declarations.map(exceptionKey));
  for (const exception of exceptions) {
    const key = exceptionKey(exception);
    const where = `${exceptionListFile}: exception for ${exception.symbol} in ${exception.file}`;
    if (exceptionKeys.has(key)) {
      violations.push(`${where} is listed more than once`);
    }
    exceptionKeys.add(key);
    if (typeof exception.reason !== "string" || exception.reason.trim().length === 0) {
      violations.push(`${where} has an empty reason; say where the policy is authored instead`);
    }
    if (!declarationKeys.has(key)) {
      violations.push(`${where} matches no definePolicy declaration; delete the stale entry`);
    } else if (registration.fileByName.has(exception.symbol)) {
      violations.push(`${where} is now registered in the platform policy console; delete the entry`);
    }
  }

  const registered = [];
  const excepted = [];
  for (const declaration of declarations) {
    if (registration.fileByName.has(declaration.symbol)) {
      registered.push(declaration);
    } else if (exceptionKeys.has(exceptionKey(declaration))) {
      excepted.push(declaration);
    } else {
      violations.push(
        `${declaration.file}:${declaration.line}: policy declaration ${declaration.symbol} is neither registered in the platform policy console nor on the reviewed exception list; add it to a \`definitions\` array in ${policyConsoleCrossContextRegistrationFile} (or \`ownPolicyDefinitions\` in ${policyConsoleOwnRegistrationFile}), or add a reasoned entry to ${exceptionListFile}`,
      );
    }
  }

  return { declarations, registered, excepted, violations: violations.sort() };
}

export function listPolicyDeclarationGuardCandidates(repoRoot, { execGit = execFileSync } = {}) {
  return execGit("git", ["ls-files", "-z", "--cached"], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: GIT_LISTING_MAX_BUFFER,
  })
    .split("\0")
    .filter(Boolean)
    .map((file) => file.replaceAll("\\", "/"))
    .filter(isPolicyDeclarationGuardedFile)
    .sort();
}

export function readPolicyDeclarationGuardSources({ repoRoot, execGit } = {}) {
  return listPolicyDeclarationGuardCandidates(repoRoot, { execGit }).map((relativePath) => {
    try {
      return { relativePath, source: readFileSync(path.join(repoRoot, ...relativePath.split("/")), "utf8") };
    } catch (error) {
      return {
        relativePath,
        readError: `could not read tracked file (${error instanceof Error ? error.message : String(error)})`,
      };
    }
  });
}

export function validatePolicyConsoleRegistration({ repoRoot, execGit, exceptions } = {}) {
  return findPolicyConsoleRegistrationViolations(readPolicyDeclarationGuardSources({ repoRoot, execGit }), {
    exceptions,
  });
}
