import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

export const implementationBase = "d0abeb97b46e8aafc16628e24e0cf6e56b41b01b";
export const channelsIndexPath = "bounded-contexts/channels/index.ts";
export const publicationContractsPath = "bounded-contexts/channels/features/publication-port/domain/contracts.ts";

export const repoRoot = path.resolve(import.meta.dirname, "../../../../..");

export function deriveImplementationBaseRootExports(): Readonly<{
  provenance: "git-object" | "immutable-golden";
  revision: string;
  path: string;
  blobSha: string;
  exports: readonly string[];
}> {
  const golden = JSON.parse(
    readFileSync(path.join(import.meta.dirname, "implementation-base-root-exports.json"), "utf8"),
  ) as Readonly<{ revision: string; path: string; blobSha: string; exports: readonly string[] }>;
  let source: string;
  try {
    source = execFileSync("git", ["show", `${golden.revision}:${golden.path}`], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    return { provenance: "immutable-golden", ...golden };
  }
  const blobSha = execFileSync("git", ["hash-object", "--stdin"], {
    cwd: repoRoot,
    encoding: "utf8",
    input: source,
  }).trim();
  const exports = collectRootExports(source);
  if (blobSha !== golden.blobSha || JSON.stringify(exports) !== JSON.stringify(golden.exports)) {
    throw new Error("The implementation-base root export golden does not match its authoritative Git object.");
  }
  return { provenance: "git-object", ...golden };
}

export function collectRootExports(source: string): string[] {
  const names = new Set<string>();
  for (const match of source.matchAll(
    /^export\s+(?:declare\s+)?(?:const|let|var|function|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm,
  )) {
    names.add(match[1]);
  }
  for (const match of source.matchAll(/^export\s*\{([\s\S]*?)\}\s*from\s*["'][^"']+["']/gm)) {
    for (const rawMember of match[1].split(",")) {
      const member = rawMember.trim().replace(/^type\s+/, "");
      if (!member) continue;
      names.add(member.split(/\s+as\s+/).at(-1)!);
    }
  }
  return [...names].sort();
}

export function collectRootExportViolations(
  baseline: readonly string[],
  candidateSource: string,
  sliceAdditions: readonly string[],
): string[] {
  const candidate = new Set(collectRootExports(candidateSource));
  const additions = new Set(sliceAdditions);
  const violations: string[] = [];
  for (const name of baseline) {
    if (!candidate.has(name)) violations.push(`dropped-baseline:${name}`);
  }
  for (const name of additions) {
    if (!candidate.has(name)) violations.push(`missing-addition:${name}`);
  }
  for (const name of candidate) {
    if (baseline.includes(name) || additions.has(name)) continue;
    if (name.startsWith("assert")) violations.push(`exported-validator:${name}`);
    else if (name === "productionChannelProviderDescriptors") {
      violations.push(`exported-production-descriptor-table:${name}`);
    } else violations.push(`undeclared-addition:${name}`);
  }
  return violations.sort();
}

export type SourceFileMap = ReadonlyMap<string, string>;

export function listTrackedProductionSources(): Map<string, string> {
  const tracked = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
    cwd: repoRoot,
    encoding: "utf8",
  })
    .split(/\r?\n/)
    .filter(Boolean)
    .filter(isProductionSourcePath);
  return new Map(
    tracked.map((relativePath) => [relativePath, readFileSync(path.join(repoRoot, relativePath), "utf8")]),
  );
}

export function collectPublicationCallerEvidence(files: SourceFileMap): Readonly<{
  scanned: number;
  operationCallFiles: readonly string[];
  violations: readonly string[];
}> {
  const operationCallFiles: string[] = [];
  const violations: string[] = [];
  for (const [relativePath, source] of files) {
    if (!isChannelPublicationSource(source)) continue;
    const calls = findPublicationOperationCalls(source);
    if (calls.length === 0) continue;
    operationCallFiles.push(relativePath);
    const isCanonicalBoundary =
      source.includes("function resolvePublication") &&
      source.includes("assertPublishListingInput") &&
      source.includes("assertChannelPublicationResult");
    const obtainsResolvedCapability =
      source.includes(".get(") &&
      (source.includes("channelProviderRegistry") ||
        source.includes("ChannelProviderRegistry") ||
        source.includes("ResolvedChannelPublication"));
    if (!isCanonicalBoundary && !obtainsResolvedCapability) {
      violations.push(`${relativePath}:${calls.join(",")}`);
    }
  }
  return { scanned: files.size, operationCallFiles: operationCallFiles.sort(), violations: violations.sort() };
}

export function collectStructuralRedeclarations(files: SourceFileMap, contractsSource: string): readonly string[] {
  const contractFingerprints = collectDeclarationFingerprints(contractsSource);
  const violations: string[] = [];
  for (const [relativePath, source] of files) {
    if (relativePath.startsWith("bounded-contexts/channels/features/publication-port/")) continue;
    for (const declaration of collectDeclarationFingerprints(source)) {
      const matches = contractFingerprints.filter((target) => target.fingerprint === declaration.fingerprint);
      for (const match of matches) violations.push(`${relativePath}:${declaration.name}->${match.name}`);
    }
  }
  return violations.sort();
}

function isProductionSourcePath(relativePath: string): boolean {
  const normalized = relativePath.replaceAll("\\", "/");
  if (!/\.(?:[cm]?[jt]sx?)$/.test(normalized)) return false;
  if (/(?:^|\/)tests?(?:\/|$)|(?:^|\/)__tests__(?:\/|$)|\.(?:test|spec)\.[^.]+$/.test(normalized)) return false;
  return true;
}

function findPublicationOperationCalls(source: string): string[] {
  const operationNames = ["publishListing", "updatePriceQuantity", "delistListing"] as const;
  const importedAliases = new Map<string, string>();
  for (const match of source.matchAll(/import\s*\{([\s\S]*?)\}\s*from\s*["'][^"']+["']/g)) {
    for (const rawMember of match[1].split(",")) {
      const member = rawMember.trim().replace(/^type\s+/, "");
      const [importedName, localName = importedName] = member.split(/\s+as\s+/);
      if (operationNames.includes(importedName as (typeof operationNames)[number])) {
        importedAliases.set(localName, importedName);
      }
    }
  }
  const calls: string[] = [];
  for (const operationName of operationNames) {
    for (const _match of source.matchAll(new RegExp(`\\.${operationName}\\s*\\(`, "g"))) calls.push(operationName);
  }
  for (const [localName, importedName] of importedAliases) {
    for (const _match of source.matchAll(new RegExp(`\\b${escapeRegExp(localName)}\\s*\\(`, "g"))) {
      calls.push(importedName);
    }
  }
  return calls;
}

function collectDeclarationFingerprints(source: string): readonly Readonly<{ name: string; fingerprint: string }>[] {
  const results: Array<Readonly<{ name: string; fingerprint: string }>> = [];
  const pattern = /(?:^|\n)(?:export\s+)?(?:interface\s+(\w+)[^{]*|type\s+(\w+)\s*=\s*Readonly\s*<\s*)\{/g;
  for (const match of source.matchAll(pattern)) {
    const name = match[1] ?? match[2];
    const openBrace = (match.index ?? 0) + match[0].lastIndexOf("{");
    const closeBrace = findMatchingBrace(source, openBrace);
    if (closeBrace < 0) continue;
    const fingerprint = membersFingerprint(source.slice(openBrace + 1, closeBrace));
    if (fingerprint) results.push({ name, fingerprint });
  }
  return results;
}

function membersFingerprint(body: string): string {
  const members: string[] = [];
  let memberStart = 0;
  let depth = 0;
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index];
    if ("<({[".includes(character)) depth += 1;
    else if (">)}]".includes(character)) depth -= 1;
    else if (character === ";" && depth === 0) {
      members.push(body.slice(memberStart, index));
      memberStart = index + 1;
    }
  }
  if (body.slice(memberStart).trim()) members.push(body.slice(memberStart));
  return members
    .map((member) =>
      member
        .replace(/\breadonly\s+/g, "")
        .replace(/\s+/g, "")
        .trim(),
    )
    .filter(Boolean)
    .sort()
    .join("|");
}

function findMatchingBrace(source: string, openBrace: number): number {
  let depth = 0;
  for (let index = openBrace; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isChannelPublicationSource(source: string): boolean {
  return /\b(?:ChannelProviderRegistry|ResolvedChannelPublication|ChannelPublicationCapability|ChannelProviderDescriptor|channelProviderRegistry|assertPublishListingInput)\b/.test(
    source,
  );
}
