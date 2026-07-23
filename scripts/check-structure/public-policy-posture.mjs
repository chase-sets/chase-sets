import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import ts from "@chase-sets/typescript-compiler-api";

const productionSurfaceRoots = [
  "bounded-contexts/public-presence/features/policies/ui",
  "bounded-contexts/public-presence/routes/marketplace",
];

const canonicalFunctionNames = new Set([
  "resolvePolicyArtifactPublicationPosture",
  "buildPolicyArtifactPageCopy",
  "PolicyArtifactPage",
]);

const expectedCanonicalPendingValues = [
  "publicPresence.info.terms.metadata.effectivePending",
  "publicPresence.info.policies.metadata.effectivePending",
  "publicPresence.info.terms.counselPending.title",
  "publicPresence.info.terms.counselPending.description",
  "publicPresence.info.policies.counselPending.title",
  "publicPresence.info.policies.counselPending.description",
];

const postureDecidingPageProps = new Set([
  "copy",
  "effectivePendingText",
  "formatEffectiveText",
  "counselPendingTitle",
  "counselPendingDescription",
]);

function isProductionSource(relativePath) {
  return /\.(?:ts|tsx)$/.test(relativePath) && !/\.test\.(?:ts|tsx)$/.test(relativePath);
}

function sourceKindFor(relativePath) {
  return relativePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
}

function topLevelFunctionNames(sourceFile) {
  return new Set(
    sourceFile.statements
      .filter((statement) => ts.isFunctionDeclaration(statement) && statement.name !== undefined)
      .map((statement) => statement.name.text),
  );
}

function containingFunctionName(node) {
  for (let current = node.parent; current !== undefined; current = current.parent) {
    if (ts.isFunctionDeclaration(current)) {
      return current.name?.text;
    }
    if (
      (ts.isFunctionExpression(current) || ts.isArrowFunction(current)) &&
      ts.isVariableDeclaration(current.parent) &&
      ts.isIdentifier(current.parent.name)
    ) {
      return current.parent.name.text;
    }
  }
  return undefined;
}

function isPendingPostureValue(value) {
  return (
    /^publicPresence\.info\.[A-Za-z0-9-]+\.metadata\.effectivePending$/.test(value) ||
    /^publicPresence\.info\.[A-Za-z0-9-]+\.counselPending\.[A-Za-z0-9-]+$/.test(value) ||
    value === "Effective date pending counsel approval"
  );
}

function pageElementName(tagName) {
  return ts.isIdentifier(tagName) ? tagName.text : tagName.getText();
}

function lineFor(sourceFile, node) {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function propertyNameText(name) {
  if (name === undefined) {
    return undefined;
  }
  return ts.isIdentifier(name) || ts.isStringLiteralLike(name) ? name.text : name.getText();
}

/**
 * AST guard for every production module in the policy UI and marketplace
 * route ownership roots. Pending copy is permitted only as the exact finite
 * set of localization keys inside the canonical copy builder. The public page
 * API cannot accept posture-deciding copy or spread props.
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

  const canonicalMappers = guardedRecords.filter(({ sourceFile }) => {
    const functionNames = topLevelFunctionNames(sourceFile);
    return [...canonicalFunctionNames].every((name) => functionNames.has(name));
  });
  const canonicalMapper = canonicalMappers.length === 1 ? canonicalMappers[0] : undefined;
  const canonicalPendingCounts = new Map(expectedCanonicalPendingValues.map((value) => [value, 0]));
  const violations = [];

  if (canonicalMappers.length !== 1) {
    violations.push(
      `bounded-contexts/public-presence/features/policies/ui: expected exactly one canonical publication-state mapper/builder/page module; found ${canonicalMappers.length}`,
    );
  }

  for (const record of guardedRecords) {
    const { relativePath, sourceFile } = record;

    function report(node, message) {
      violations.push(`${relativePath}:${lineFor(sourceFile, node)}: ${message}`);
    }

    function visit(node) {
      if (ts.isStringLiteralLike(node) && isPendingPostureValue(node.text)) {
        const inCanonicalBuilder =
          record === canonicalMapper && containingFunctionName(node) === "buildPolicyArtifactPageCopy";
        if (!inCanonicalBuilder || !canonicalPendingCounts.has(node.text)) {
          report(node, `pending publication copy '${node.text}' must be selected only by the canonical copy builder`);
        } else {
          canonicalPendingCounts.set(node.text, (canonicalPendingCounts.get(node.text) ?? 0) + 1);
        }
      }

      if (
        (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
        pageElementName(node.tagName) === "PolicyArtifactPage"
      ) {
        for (const attribute of node.attributes.properties) {
          if (ts.isJsxSpreadAttribute(attribute)) {
            report(attribute, "PolicyArtifactPage forbids spread props that could inject publication posture");
            continue;
          }
          const propName = propertyNameText(attribute.name);
          if (propName !== undefined && postureDecidingPageProps.has(propName)) {
            report(attribute, `PolicyArtifactPage posture-deciding prop '${propName}' is forbidden`);
          }
        }
      }

      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "PolicyArtifactPage" &&
        node.arguments.length > 0 &&
        ts.isObjectLiteralExpression(node.arguments[0])
      ) {
        for (const property of node.arguments[0].properties) {
          if (ts.isSpreadAssignment(property)) {
            report(property, "PolicyArtifactPage forbids spread arguments that could inject publication posture");
            continue;
          }
          const propName = propertyNameText(property.name);
          if (propName !== undefined && postureDecidingPageProps.has(propName)) {
            report(property, `PolicyArtifactPage posture-deciding property '${propName}' is forbidden`);
          }
        }
      }

      ts.forEachChild(node, visit);
    }

    visit(sourceFile);
  }

  if (canonicalMapper !== undefined) {
    for (const [value, count] of canonicalPendingCounts) {
      if (count !== 1) {
        violations.push(
          `${canonicalMapper.relativePath}: canonical copy builder must contain '${value}' exactly once; found ${count}`,
        );
      }
    }
  }

  return {
    guardedFiles: guardedRecords.map(({ relativePath }) => relativePath).sort(),
    canonicalMapperFiles: canonicalMappers.map(({ relativePath }) => relativePath).sort(),
    violations,
  };
}

export async function readPublicPolicyPostureSources({ repoRoot }) {
  const sourceRecords = [];
  for (const relativeRoot of productionSurfaceRoots) {
    const absoluteRoot = path.resolve(repoRoot, relativeRoot);
    for (const absolutePath of await listFiles(absoluteRoot)) {
      const relativePath = path.relative(repoRoot, absolutePath).replaceAll("\\", "/");
      if (!isProductionSource(relativePath)) {
        continue;
      }
      sourceRecords.push({ relativePath, source: await readFile(absolutePath, "utf8") });
    }
  }
  return sourceRecords;
}

export async function validatePublicPolicyPosture({ repoRoot }) {
  return findPublicPolicyPostureViolations(await readPublicPolicyPostureSources({ repoRoot }));
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
