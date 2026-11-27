import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import ts from "@chase-sets/typescript-compiler-api";

// The policy pages are the Corten public app's views/policy_page.rs. Its
// Words::of is the one place that selects the counsel-pending copy, and the
// page shows that copy only while a document has no effective date. The
// TypeScript side keeps the policies feature's ui root to its catalog: the
// catalog may declare the pending copy, and no TypeScript module may select it.
const typescriptSurfaceRoots = ["bounded-contexts/public-presence/features/policies/ui"];

export const CORTEN_POLICY_PAGE = "deployables/corten-pilot/public/src/views/policy_page.rs";
const cortenPublicSourceRoot = "deployables/corten-pilot/public/src";

const expectedCatalogPendingKeys = new Set([
  "publicPresence.info.terms.metadata.effectivePending",
  "publicPresence.info.policies.metadata.effectivePending",
  "publicPresence.info.terms.counselPending.title",
  "publicPresence.info.terms.counselPending.description",
  "publicPresence.info.policies.counselPending.title",
  "publicPresence.info.policies.counselPending.description",
]);

// The Corten accessors the export generates for those six catalog keys.
export const cortenPendingAccessors = [
  "terms_metadata_effective_pending",
  "policies_metadata_effective_pending",
  "terms_counsel_pending_title",
  "terms_counsel_pending_description",
  "policies_counsel_pending_title",
  "policies_counsel_pending_description",
];

// The posture decision the policy page must keep: the banner and the pending
// effective text only while the document has no effective date.
export const cortenPostureGates = ["if policy.effective_at.is_none() {", "None => words.effective_pending"];

function isProductionSource(relativePath) {
  return /\.(?:ts|tsx)$/.test(relativePath) && !/\.test\.(?:ts|tsx)$/.test(relativePath);
}

function sourceKindFor(relativePath) {
  return relativePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
}

function isPendingPostureValue(value) {
  return (
    /^publicPresence\.info\.[A-Za-z0-9-]+\.metadata\.effectivePending$/.test(value) ||
    /^publicPresence\.info\.[A-Za-z0-9-]+\.counselPending\.[A-Za-z0-9-]+$/.test(value) ||
    value === "Effective date pending counsel approval"
  );
}

function staticCatalogProperties(sourceFile) {
  if (!/\/localization\/locales\/en\.ts$/.test(sourceFile.fileName) || sourceFile.statements.length !== 1) {
    return undefined;
  }
  const [statement] = sourceFile.statements;
  if (
    !ts.isVariableStatement(statement) ||
    !statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ||
    !(statement.declarationList.flags & ts.NodeFlags.Const) ||
    statement.declarationList.declarations.length !== 1
  ) {
    return undefined;
  }
  let { initializer } = statement.declarationList.declarations[0];
  if (initializer && ts.isAsExpression(initializer)) initializer = initializer.expression;
  if (
    !initializer ||
    !ts.isObjectLiteralExpression(initializer) ||
    !initializer.properties.every(
      (property) =>
        ts.isPropertyAssignment(property) &&
        ts.isStringLiteral(property.name) &&
        ts.isStringLiteral(property.initializer),
    )
  ) {
    return undefined;
  }
  return initializer;
}

function lineFor(sourceFile, node) {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

/**
 * AST guard for every TypeScript production module under the policies ui
 * root. The catalog may declare the six pending keys; any other occurrence of
 * pending copy selects it outside the Corten policy page.
 */
export function findPublicPolicyPostureViolations(sourceRecords) {
  const guardedRecords = sourceRecords
    .filter(({ relativePath }) => isProductionSource(relativePath))
    .map((record) => ({
      ...record,
      sourceFile: ts.createSourceFile(
        record.relativePath,
        record.source,
        ts.ScriptTarget.Latest,
        true,
        sourceKindFor(record.relativePath),
      ),
    }));
  const violations = [];

  for (const { relativePath, sourceFile } of guardedRecords) {
    const catalog = staticCatalogProperties(sourceFile);

    function visit(node) {
      if (ts.isStringLiteralLike(node) && isPendingPostureValue(node.text)) {
        const property = node.parent;
        const declaresCatalogCopy =
          catalog !== undefined &&
          ts.isPropertyAssignment(property) &&
          property.parent === catalog &&
          ts.isStringLiteral(property.name) &&
          expectedCatalogPendingKeys.has(property.name.text);
        // The catalog defines the value; it cannot select when that copy is used.
        if (!declaresCatalogCopy) {
          violations.push(
            `${relativePath}:${lineFor(sourceFile, node)}: pending publication copy '${node.text}' must be selected only by ${CORTEN_POLICY_PAGE}`,
          );
        }
      }
      ts.forEachChild(node, visit);
    }

    visit(sourceFile);
  }

  return {
    guardedFiles: guardedRecords.map(({ relativePath }) => relativePath).sort(),
    violations,
  };
}

/**
 * Line guard for the Corten public app's Rust sources (tests excluded): each
 * pending accessor is called exactly once, only in the policy page, and the
 * page keeps both posture gates.
 */
export function findCortenPolicyPostureViolations(sourceRecords) {
  const violations = [];
  const guardedFiles = [];
  const counts = new Map(cortenPendingAccessors.map((accessor) => [accessor, 0]));
  let page;

  for (const record of sourceRecords) {
    const { relativePath } = record;
    if (!isCortenPostureGuardedModule(relativePath)) continue;
    guardedFiles.push(relativePath);
    if (relativePath === CORTEN_POLICY_PAGE) page = record;
    record.source.split(/\r?\n/).forEach((line, index) => {
      for (const accessor of cortenPendingAccessors) {
        const calls = line.split(`.${accessor}(`).length - 1;
        if (calls === 0) continue;
        if (relativePath === CORTEN_POLICY_PAGE) {
          counts.set(accessor, counts.get(accessor) + calls);
        } else {
          violations.push(
            `${relativePath}:${index + 1}: pending publication copy '${accessor}' must be selected only by ${CORTEN_POLICY_PAGE}`,
          );
        }
      }
    });
  }

  if (page === undefined) {
    violations.push(`${CORTEN_POLICY_PAGE}: the Corten policy page is missing; the posture guard fails closed`);
  } else {
    for (const [accessor, count] of counts) {
      if (count !== 1) {
        violations.push(`${CORTEN_POLICY_PAGE}: must select '${accessor}' exactly once; found ${count}`);
      }
    }
    for (const gate of cortenPostureGates) {
      if (!page.source.includes(gate)) {
        violations.push(
          `${CORTEN_POLICY_PAGE}: lost the posture gate '${gate}'; pending copy must show only while a document has no effective date`,
        );
      }
    }
  }

  return { guardedFiles: guardedFiles.sort(), violations };
}

export function isCortenPostureGuardedModule(relativePath) {
  const normalized = relativePath.replaceAll("\\", "/");
  return (
    normalized.startsWith(`${cortenPublicSourceRoot}/`) &&
    normalized.endsWith(".rs") &&
    !/(^|\/)tests\.rs$/.test(normalized) &&
    !/\/tests\//.test(normalized)
  );
}

async function readTree(repoRoot, relativeRoot, keep) {
  const records = [];
  for (const absolutePath of await listFiles(path.resolve(repoRoot, relativeRoot))) {
    const relativePath = path.relative(repoRoot, absolutePath).replaceAll("\\", "/");
    if (keep(relativePath)) {
      records.push({ relativePath, source: await readFile(absolutePath, "utf8") });
    }
  }
  return records;
}

export async function readPublicPolicyPostureSources({ repoRoot }) {
  const records = [];
  for (const relativeRoot of typescriptSurfaceRoots) {
    records.push(...(await readTree(repoRoot, relativeRoot, isProductionSource)));
  }
  return records;
}

export async function readCortenPolicyPostureSources({ repoRoot }) {
  return readTree(repoRoot, cortenPublicSourceRoot, isCortenPostureGuardedModule);
}

export async function validatePublicPolicyPosture({ repoRoot }) {
  const typescript = findPublicPolicyPostureViolations(await readPublicPolicyPostureSources({ repoRoot }));
  const corten = findCortenPolicyPostureViolations(await readCortenPolicyPostureSources({ repoRoot }));
  return {
    guardedFiles: typescript.guardedFiles,
    cortenGuardedFiles: corten.guardedFiles,
    violations: [...typescript.violations, ...corten.violations],
  };
}

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(entryPath)));
    } else if (entry.isFile()) {
      files.push(entryPath);
    }
  }
  return files;
}
