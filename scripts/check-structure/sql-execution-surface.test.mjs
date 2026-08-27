import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "@chase-sets/typescript-compiler-api";
import { afterEach, describe, expect, it } from "vitest";
import {
  SANCTIONED_SQL_RECEIVER_RESOLUTION,
  classifySqlExecutionSurface,
  deriveChangedSqlExecutionFiles,
  listNonTestTypeScriptModules,
  runSqlExecutionSurfaceGuard,
} from "./sql-execution-surface.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const fixtureFile = "scripts/check-structure/fixtures/sql-execution-surface/fixture-cases.ts";
const sqlExecutionSurfaceFile = path.join(repoRoot, "scripts/check-structure/sql-execution-surface.mjs");
const testOnlyDirectorySegments = ["__tests__", "e2e", "fixtures", "tests", "fixture", "test", "test-support"];
const exactRemovedModules = [
  "bounded-contexts/catalog/support/test-support/source-observation-fixtures.ts",
  "deployables/admin-web/src/test/setup.ts",
  "deployables/marketplace/app/test-support/setup.ts",
  "deployables/platform-api/src/test-support/provider-gateways.ts",
  "deployables/platform-worker/src/test-support/provider-gateways.ts",
];
const tempRoots = [];

function classify(files, root = repoRoot) {
  return classifySqlExecutionSurface({ repoRoot: root, files });
}

function partitionFromFiles(root, files) {
  const result = classifySqlExecutionSurface({ repoRoot: root, files });
  return {
    sqlExecuting: result.modules.filter((module) => module.outcome === "sql-executing").map((module) => module.file),
    unprovableForm: result.modules
      .filter((module) => module.outcome === "unprovable-form")
      .map((module) => module.file),
    notSql: result.modules.filter((module) => module.outcome === "not-sql").map((module) => module.file),
    unresolvedMemberRoots: result.unresolvedMemberRoots,
  };
}

function partitionFromTrackedInventory(root, { execGit = undefined } = {}) {
  const files = listNonTestTypeScriptModules(root, execGit === undefined ? {} : { execGit });
  return partitionFromFiles(root, files);
}

function withoutChangedFilesJson(run) {
  const previous = process.env.CHANGED_FILES_JSON;
  delete process.env.CHANGED_FILES_JSON;
  try {
    return run();
  } finally {
    if (previous === undefined) delete process.env.CHANGED_FILES_JSON;
    else process.env.CHANGED_FILES_JSON = previous;
  }
}

function callAt(result, file, line) {
  return result.modules.find((module) => module.file === file)?.calls.find((call) => call.line === line);
}

function expectSql(result, file, line, receiver) {
  expect(callAt(result, file, line), `${file}:${line}`).toMatchObject({
    receiver,
    outcome: "sql-execution",
  });
}

function normalizeTestPath(file) {
  return path.posix.normalize(file.replaceAll("\\", "/")).replace(/^\.\//, "");
}

function discoverBoth(files, module = { deriveChangedSqlExecutionFiles, listNonTestTypeScriptModules }) {
  return {
    changed: module.deriveChangedSqlExecutionFiles({
      repoRoot,
      changedFilesJson: JSON.stringify(files),
    }),
    inventory: module.listNonTestTypeScriptModules(repoRoot, {
      execGit: (args) => {
        expect(args).toEqual(["ls-files", "-z", "--cached"]);
        return `${files.join("\0")}\0`;
      },
    }),
  };
}

function replaceUnique(source, target, replacement) {
  const first = source.indexOf(target);
  expect(first, `missing mutation target: ${target}`).toBeGreaterThanOrEqual(0);
  expect(source.lastIndexOf(target), `non-unique mutation target: ${target}`).toBe(first);
  return source.slice(0, first) + replacement + source.slice(first + target.length);
}

function replaceLast(source, target, replacement) {
  const index = source.lastIndexOf(target);
  expect(index, `missing mutation target: ${target}`).toBeGreaterThanOrEqual(0);
  return source.slice(0, index) + replacement + source.slice(index + target.length);
}

function mutateOwnershipSource(source, mutation) {
  const multilineVocabularyDeclaration = `const testOnlyDirectorySegments = Object.freeze([
  "__tests__",
  "e2e",
  "fixtures",
  "tests",
  "fixture",
  "test",
  "test-support",
]);`;
  if (mutation === "copied declaration") {
    const copiedDeclaration =
      'const copiedTestOnlyDirectorySegments = Object.freeze(["__tests__", "e2e", "fixtures", "tests", "fixture", "test", "test-support"]);';
    const withCopy = replaceUnique(
      source,
      multilineVocabularyDeclaration,
      `${multilineVocabularyDeclaration}\n${copiedDeclaration}`,
    );
    return replaceLast(
      withCopy,
      ".filter(isGovernedProductionModule)",
      '.filter((file) => typeScriptModulePattern.test(file) && !testModuleSuffixPattern.test(file) && !file.split("/").some((segment) => copiedTestOnlyDirectorySegments.includes(segment)))',
    );
  }
  if (mutation === "shadowed predicate") {
    const marker = "  let files;";
    return replaceUnique(
      source,
      marker,
      `  const isGovernedProductionModule = (file) =>
    typeScriptModulePattern.test(file) &&
    !testModuleSuffixPattern.test(file) &&
    !file.split("/").some((segment) => testOnlyDirectorySegments.includes(segment));
${marker}`,
    );
  }
  if (mutation === "local widening") {
    return replaceLast(
      source,
      ".filter(isGovernedProductionModule)",
      ".filter(isGovernedProductionModule).filter((file) => !/synthetic-never-present/.test(file))",
    );
  }
  if (mutation === "alternate normalization") {
    return replaceLast(source, ".map(normalizeRepoPath)", ".map((file) => normalizeRepoPath(file).toLowerCase())");
  }
  if (mutation === "test-support prefix widening") {
    return replaceUnique(
      source,
      "testOnlyDirectorySegments.includes(segment)",
      'testOnlyDirectorySegments.includes(segment) || segment.startsWith("test-support")',
    );
  }
  throw new Error(`unknown mutation: ${mutation}`);
}

function inspectGovernedProductionOwnership(source) {
  const sourceFile = ts.createSourceFile(
    "sql-execution-surface.mjs",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const failures = [];
  const frozenStringArrays = [];

  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !ts.isCallExpression(declaration.initializer)) continue;
      const call = declaration.initializer;
      if (
        ts.isPropertyAccessExpression(call.expression) &&
        ts.isIdentifier(call.expression.expression) &&
        call.expression.expression.text === "Object" &&
        call.expression.name.text === "freeze" &&
        call.arguments.length === 1 &&
        ts.isArrayLiteralExpression(call.arguments[0]) &&
        call.arguments[0].elements.every(ts.isStringLiteral)
      ) {
        frozenStringArrays.push({
          name: declaration.name.text,
          values: call.arguments[0].elements.map((element) => element.text),
        });
      }
    }
  }

  if (frozenStringArrays.length !== 1) {
    failures.push(`FROZEN_VOCABULARY_COUNT=${frozenStringArrays.length}`);
  } else {
    const [vocabulary] = frozenStringArrays;
    if (vocabulary.name !== "testOnlyDirectorySegments") failures.push("FROZEN_VOCABULARY_NAME");
    if (JSON.stringify([...vocabulary.values].sort()) !== JSON.stringify([...testOnlyDirectorySegments].sort())) {
      failures.push("FROZEN_VOCABULARY_MEMBERS");
    }
  }

  const predicateDeclarations = sourceFile.statements.filter(
    (statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === "isGovernedProductionModule",
  );
  if (predicateDeclarations.length !== 1) {
    failures.push(`GOVERNED_PREDICATE_COUNT=${predicateDeclarations.length}`);
  }

  for (const discoveryName of ["deriveChangedSqlExecutionFiles", "listNonTestTypeScriptModules"]) {
    const discovery = sourceFile.statements.find(
      (statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === discoveryName,
    );
    if (!discovery?.body) {
      failures.push(`${discoveryName}:MISSING`);
      continue;
    }

    let predicateReferences = 0;
    let shadowBindings = 0;
    const returnedPipelines = [];
    const inspectBody = (node) => {
      if (ts.isIdentifier(node) && node.text === "isGovernedProductionModule") predicateReferences += 1;
      if (
        (ts.isVariableDeclaration(node) ||
          ts.isParameter(node) ||
          ts.isFunctionDeclaration(node) ||
          ts.isClassDeclaration(node)) &&
        ts.isIdentifier(node.name) &&
        (node.name.text === "isGovernedProductionModule" || node.name.text === "testOnlyDirectorySegments")
      ) {
        shadowBindings += 1;
      }
      if (ts.isReturnStatement(node) && node.expression) returnedPipelines.push(node.expression);
      ts.forEachChild(node, inspectBody);
    };
    inspectBody(discovery.body);

    if (shadowBindings !== 0) failures.push(`${discoveryName}:SHADOW_BINDING=${shadowBindings}`);
    if (predicateReferences !== 1) failures.push(`${discoveryName}:PREDICATE_REFERENCES=${predicateReferences}`);
    if (returnedPipelines.length !== 1) {
      failures.push(`${discoveryName}:RETURNED_PIPELINE_COUNT=${returnedPipelines.length}`);
    }

    let governedFilterCount = 0;
    const inspectPipeline = (node) => {
      if (ts.isRegularExpressionLiteral(node)) failures.push(`${discoveryName}:LOCAL_REGEX_IN_PIPELINE`);
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const method = node.expression.name.text;
        const argument = node.arguments[0];
        if (method === "filter") {
          if (ts.isIdentifier(argument) && argument.text === "isGovernedProductionModule") {
            governedFilterCount += 1;
          } else if (!(ts.isIdentifier(argument) && argument.text === "Boolean")) {
            failures.push(`${discoveryName}:EXTRA_FILTER`);
          }
        }
        if (method === "map" && !(ts.isIdentifier(argument) && argument.text === "normalizeRepoPath")) {
          failures.push(`${discoveryName}:ALTERNATE_NORMALIZATION`);
        }
      }
      ts.forEachChild(node, inspectPipeline);
    };
    for (const pipeline of returnedPipelines) inspectPipeline(pipeline);
    if (governedFilterCount !== 1) {
      failures.push(`${discoveryName}:GOVERNED_FILTER_COUNT=${governedFilterCount}`);
    }
  }

  return [...new Set(failures)];
}

async function loadSqlExecutionModuleFromSource(source) {
  const compilerApiUrl = import.meta.resolve("@chase-sets/typescript-compiler-api");
  const moduleResolutionUrl = new URL("./module-resolution.mjs", import.meta.url).href;
  const runnableSource = source
    .replace('"@chase-sets/typescript-compiler-api"', JSON.stringify(compilerApiUrl))
    .replace('"./module-resolution.mjs"', JSON.stringify(moduleResolutionUrl));
  return import(`data:text/javascript;base64,${Buffer.from(runnableSource).toString("base64")}`);
}

function createContractRepo() {
  const root = mkdtempSync(path.join(tmpdir(), "sql-execution-contract-"));
  tempRoots.push(root);
  const contractDir = path.join(root, "infrastructure", "event-core-postgres");
  mkdirSync(contractDir, { recursive: true });
  cpSync(path.join(repoRoot, "infrastructure", "event-core-postgres", "types.ts"), path.join(contractDir, "types.ts"));
  cpSync(path.join(repoRoot, "infrastructure", "event-core-postgres", "index.ts"), path.join(contractDir, "index.ts"));
  writeFileSync(
    path.join(contractDir, "package.json"),
    JSON.stringify({
      name: "@chase-sets/event-core-postgres",
      exports: { ".": "./index.ts", "./*": "./*.ts" },
    }),
  );
  writeFileSync(path.join(root, "pnpm-workspace.yaml"), 'packages:\n  - "infrastructure/*"\n');
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("SQL execution fixture matrix through the real guard entrypoint", () => {
  it("classifies P1-P10 and P12-P18 as SQL-executing at their named anchors", () => {
    const anchors = [
      ["bounded-contexts/ordering/features/orders/read-model/support-lookup.ts", 37, "db"],
      ["infrastructure/event-core-postgres/catalog-mirror.ts", 236, "db"],
      ["infrastructure/event-core-postgres/types.ts", 40, "client"],
      ["scripts/catalog-integration-reset.ts", 216, "db"],
      ["infrastructure/event-core-postgres/projection-store.ts", 358, "config.db"],
      ["bounded-contexts/catalog/features/product-measures/api/runtime.ts", 145, "deps.db"],
      ["bounded-contexts/auth/support/ucp-support/oauth.ts", 283, "options.auth.db"],
      ["bounded-contexts/commercial-terms/support/runtime-support/seed.ts", 235, "db"],
      ["bounded-contexts/identity/support/runtime-support/admin-qa-actor-fixtures.ts", 284, "db"],
      ["infrastructure/event-core-postgres/postgres-db-test-support.ts", 24, "adminPool"],
      ["bounded-contexts/catalog/features/catalog-items/read-model/projection.ts", 28, "projectionDb"],
      [
        "bounded-contexts/collections/features/saved-lists/read-model/shared-page-projection.ts",
        38,
        "resolveProjectionDb(context, db)",
      ],
      ["bounded-contexts/catalog/features/categories/read-model/queries.ts", 82, "db"],
      ["bounded-contexts/discovery/features/search/read-model/market-signals.ts", 70, "db"],
      [fixtureFile, 29, "db"],
      [fixtureFile, 33, "db"],
      [fixtureFile, 37, "db"],
    ];
    const result = classify([...new Set(anchors.map(([file]) => file))]);
    for (const [file, line, receiver] of anchors) expectSql(result, file, line, receiver);
  });

  it("classifies all package-internal modules, with pool.ts explicitly silent under N13", () => {
    const files = [
      "infrastructure/event-core-postgres/catalog-mirror.ts",
      "infrastructure/event-core-postgres/projection-store.ts",
      "infrastructure/event-core-postgres/event-store.ts",
      "infrastructure/event-core-postgres/postgres-db-test-support.ts",
      "infrastructure/event-core-postgres/projection-helpers.ts",
      "infrastructure/event-core-postgres/aggregate-snapshot-store.ts",
      "infrastructure/event-core-postgres/list-query.ts",
      "infrastructure/event-core-postgres/pool.ts",
    ];
    const result = classify(files);
    for (const file of files.slice(0, -1)) {
      expect(result.modules.find((module) => module.file === file)?.outcome, file).toBe("sql-executing");
    }
    expect(callAt(result, "infrastructure/event-core-postgres/pool.ts", 125)).toMatchObject({
      receiver: "client",
      outcome: "not-sql",
    });
    expect(result.violations).not.toEqual(
      expect.arrayContaining([expect.stringContaining("infrastructure/event-core-postgres/pool.ts")]),
    );
  });

  it("proves every already contract-annotated receiver, including P18", () => {
    const cases = [
      ["bounded-contexts/ordering/features/orders/read-model/support-lookup.ts", 37],
      ["infrastructure/event-core-postgres/catalog-mirror.ts", 236],
      ["bounded-contexts/commercial-terms/support/runtime-support/seed.ts", 235],
      ["bounded-contexts/identity/support/runtime-support/admin-qa-actor-fixtures.ts", 284],
      [fixtureFile, 29],
      [fixtureFile, 37],
    ];
    const result = classify([...new Set(cases.map(([file]) => file))]);
    for (const [file, line] of cases)
      expect(callAt(result, file, line)?.outcome, `${file}:${line}`).toBe("sql-execution");
    const identityServicesLines = readFileSync(
      path.join(repoRoot, "bounded-contexts/identity/support/runtime-support/services.ts"),
      "utf8",
    ).split(/\r?\n/);
    expect(identityServicesLines[51]).toContain("pool as PgQueryable");
  });

  it("classifies every P14 bind-then-call sibling module as SQL-executing", () => {
    const files = [
      "bounded-contexts/catalog/features/catalog-items/read-model/projection.ts",
      "bounded-contexts/catalog/features/display-templates/read-model/projection.ts",
      "bounded-contexts/checkout/features/cart/read-model/projection.ts",
      "bounded-contexts/checkout/features/sessions/read-model/projection.ts",
      "bounded-contexts/collections/features/saved-lists/read-model/shared-page-projection.ts",
      "bounded-contexts/settlement/features/wallets/read-model/projection.ts",
      "bounded-contexts/settlement/features/wallets/read-model/wallet-adjustment-projection.ts",
    ];
    const result = classify(files);
    for (const file of files) {
      expect(result.modules.find((module) => module.file === file)?.outcome, file).toBe("sql-executing");
    }
    expectSql(result, files[0], 28, "projectionDb");
    expectSql(result, files[4], 38, "resolveProjectionDb(context, db)");
  });

  it("classifies N1-N15 exactly, including P18/N15 contract-bound discrimination", () => {
    const realFiles = [
      "bounded-contexts/auth/support/ucp-support/oauth.ts",
      "bounded-contexts/customer-feedback/features/attention/api/route.ts",
      "bounded-contexts/identity/features/api-keys/api/route.ts",
      "infrastructure/event-core-postgres/pool.ts",
      "contracts/event-core/projector.ts",
    ];
    const result = classify([fixtureFile, ...realFiles]);
    const expectations = [
      [fixtureFile, 41, "not-sql"],
      [fixtureFile, 45, "not-sql"],
      [fixtureFile, 49, "not-sql"],
      [fixtureFile, 53, "not-sql"],
      [fixtureFile, 57, "unprovable-form"],
      [fixtureFile, 61, "unprovable-form"],
      [fixtureFile, 65, "unprovable-form"],
      [fixtureFile, 69, "unprovable-form"],
      [fixtureFile, 73, "unprovable-form"],
      [fixtureFile, 77, "unprovable-form"],
      [fixtureFile, 81, "unprovable-form"],
      [fixtureFile, 85, "unprovable-form"],
      [fixtureFile, 90, "not-sql"],
      [fixtureFile, 94, "not-sql"],
      ["infrastructure/event-core-postgres/pool.ts", 125, "not-sql"],
    ];
    for (const [file, line, outcome] of expectations) {
      expect(callAt(result, file, line)?.outcome, `${file}:${line}`).toBe(outcome);
    }
    expect(callAt(result, "bounded-contexts/auth/support/ucp-support/oauth.ts", 613)?.outcome).toBe("not-sql");
    expect(callAt(result, "bounded-contexts/customer-feedback/features/attention/api/route.ts", 44)?.outcome).toBe(
      "not-sql",
    );
    expect(callAt(result, "bounded-contexts/identity/features/api-keys/api/route.ts", 154)?.outcome).toBe("not-sql");
    expect(callAt(result, "contracts/event-core/projector.ts", 128)).toBeUndefined();
    const projectorLines = readFileSync(path.join(repoRoot, "contracts/event-core/projector.ts"), "utf8").split(
      /\r?\n/,
    );
    expect(projectorLines[127]).toContain('NonNullable<ProjectorHandlerContext["db"]>');
  });

  it("reports complete unprovable-form messages and only the sanctioned resolution", () => {
    const root = createContractRepo();
    const controlFile = "control.ts";
    writeFileSync(path.join(root, controlFile), 'export async function control(db) { await db.query("control"); }\n');
    const result = classify([controlFile], root);
    expect(result.violations).not.toHaveLength(0);
    for (const violation of result.violations) {
      expect(violation).toContain(controlFile);
      expect(violation).toMatch(/call \.(?:query|execute)\(\)/);
      expect(violation).toContain("receiver ");
      expect(violation).toMatch(
        /reason: (?:unresolvable declaration|unresolved module hop|bound exceeded|unsupported shape)/,
      );
      expect(violation).toContain(SANCTIONED_SQL_RECEIVER_RESOLUTION);
    }
    const source = readFileSync(path.join(repoRoot, "scripts/check-structure/sql-execution-surface.mjs"), "utf8");
    expect(source).not.toMatch(/\b(?:allowlist|exemption|bypass)\b/i);
  });
});

describe("SQL execution startup self-check negative controls", () => {
  it("fails with SQL_CONTRACT_NAME_MISSING when the contract loses a declaration", () => {
    const root = createContractRepo();
    const typesPath = path.join(root, "infrastructure", "event-core-postgres", "types.ts");
    writeFileSync(typesPath, readFileSync(typesPath, "utf8").replace("PgQueryable", "FormerPgQueryable"));
    expect(() => classify([], root)).toThrowError(
      expect.objectContaining({ name: "SqlExecutionGuardError", code: "SQL_CONTRACT_NAME_MISSING" }),
    );
  });

  it("fails with SQL_CONTRACT_REEXPORT_MISSING when the index loses its re-export", () => {
    const root = createContractRepo();
    const indexPath = path.join(root, "infrastructure", "event-core-postgres", "index.ts");
    writeFileSync(indexPath, readFileSync(indexPath, "utf8").replace('export * from "./types";', ""));
    expect(() => classify([], root)).toThrowError(
      expect.objectContaining({ name: "SqlExecutionGuardError", code: "SQL_CONTRACT_REEXPORT_MISSING" }),
    );
  });
});

describe("governed production module ownership", () => {
  const ownershipMutations = ["copied declaration", "shadowed predicate", "local widening", "alternate normalization"];

  it("binds both returned discovery pipelines to one frozen vocabulary and one bare predicate", () => {
    const source = readFileSync(sqlExecutionSurfaceFile, "utf8");
    expect(inspectGovernedProductionOwnership(source)).toEqual([]);
  });

  it.each(ownershipMutations)("rejects the %s ownership mutant structurally", (mutation) => {
    const source = readFileSync(sqlExecutionSurfaceFile, "utf8");
    const failures = inspectGovernedProductionOwnership(mutateOwnershipSource(source, mutation));
    console.log(`ownership mutant ${mutation}: ${failures.join(", ")}`);
    expect(failures, mutation).not.toEqual([]);
  });

  it("proves behavioural set equality cannot detect the four ownership mutants", async () => {
    const source = readFileSync(sqlExecutionSurfaceFile, "utf8");
    const corpus = ["src/app.ts", "src/test/file.ts", "contest/x.ts", "src/fixtures/y.ts", "test-supporting/z.ts"];
    const candidateModule = await loadSqlExecutionModuleFromSource(source);
    const candidate = discoverBoth(corpus, candidateModule);
    expect(candidate.changed).toEqual(candidate.inventory);

    for (const mutation of ownershipMutations) {
      const mutantModule = await loadSqlExecutionModuleFromSource(mutateOwnershipSource(source, mutation));
      const mutant = discoverBoth(corpus, mutantModule);
      expect(mutant.changed, mutation).toEqual(mutant.inventory);
      expect(mutant, mutation).toEqual(candidate);
    }
  });
});

describe("exact test-only directory segment vocabulary", () => {
  const segmentCases = testOnlyDirectorySegments.flatMap((segment) =>
    ["leading", "nested", "trailing"].flatMap((position) =>
      ["/", "\\"].map((separator) => {
        const testPrefix = {
          leading: segment,
          nested: `src/${segment}`,
          trailing: `src/deep/${segment}`,
        }[position];
        const productionPrefix = {
          leading: "production",
          nested: "src/production",
          trailing: "src/deep/production",
        }[position];
        return {
          name: `${segment} ${position} with ${separator === "/" ? "POSIX" : "Windows"} separators`,
          testFile: `${testPrefix}/module.ts`.replaceAll("/", separator),
          productionFile: `${productionPrefix}/module.ts`.replaceAll("/", separator),
        };
      }),
    ),
  );

  it.each(segmentCases)("excludes $name through both discoveries while governing its production twin", (control) => {
    const discovered = discoverBoth([control.testFile, control.productionFile]);
    const expected = [normalizeTestPath(control.productionFile)];
    expect(discovered.changed).toEqual(expected);
    expect(discovered.inventory).toEqual(expected);
  });

  it("excludes byte-identical SQL modules only under the seven exact test-only segments", () => {
    const root = createContractRepo();
    const source = 'export async function plantedSegmentControl(db) { await db.query("select 1"); }\n';
    const testFiles = testOnlyDirectorySegments.map(
      (segment) => `deployables/segment-controls/${segment}/arbitrary-control.ts`,
    );
    const productionFiles = testOnlyDirectorySegments.map(
      (_segment, index) => `deployables/segment-controls/production-${index}/arbitrary-control.ts`,
    );
    for (const file of [...testFiles, ...productionFiles]) {
      const absoluteFile = path.join(root, file);
      mkdirSync(path.dirname(absoluteFile), { recursive: true });
      writeFileSync(absoluteFile, source);
      expect(readFileSync(absoluteFile, "utf8")).toBe(source);
    }

    const result = runSqlExecutionSurfaceGuard({
      repoRoot: root,
      changedFilesJson: JSON.stringify([...testFiles, ...productionFiles]),
    });
    expect(result.modules.map((module) => module.file)).toEqual(productionFiles);
    expect(result.violations).toHaveLength(productionFiles.length);
    for (const file of productionFiles) {
      expect(result.violations).toEqual(expect.arrayContaining([expect.stringContaining(`${file}:1`)]));
    }
    for (const file of testFiles) {
      expect(result.violations).not.toEqual(expect.arrayContaining([expect.stringContaining(file)]));
    }
  });

  it.each([
    "deployables/platform-api/contest/seed-support.ts",
    "deployables/platform-api/pretest/seed-support.ts",
    "deployables/platform-api/latest/seed-support.ts",
    "deployables/platform-api/tests-adapter/seed-support.ts",
    "deployables/platform-api/fixtures-production/seed-support.ts",
    "deployables/platform-api/test-supporting/seed-support.ts",
    "deployables/platform-api/testsupport/seed-support.ts",
    "deployables/platform-api/fixture2/seed-support.ts",
    "deployables/platform-api/test.ts",
  ])("keeps the exact-boundary production lookalike governed: %s", (productionFile) => {
    const expected = [normalizeTestPath(productionFile)];
    const discovered = discoverBoth([productionFile]);
    expect(discovered.changed).toEqual(expected);
    expect(discovered.inventory).toEqual(expected);
  });

  it.each([
    {
      name: "repeated separators",
      testFile: "src//test//module.ts",
      productionFile: "src//production//module.ts",
    },
    {
      name: "dot segment",
      testFile: "src/./test/module.ts",
      productionFile: "src/./production/module.ts",
    },
    {
      name: "leading dot segment",
      testFile: "./test/module.ts",
      productionFile: "./production/module.ts",
    },
    {
      name: "drive-qualified Windows path",
      testFile: "C:\\repo\\test\\module.ts",
      productionFile: "C:\\repo\\production\\module.ts",
    },
    {
      name: "absolute path",
      testFile: "/repo/test/module.ts",
      productionFile: "/repo/production/module.ts",
    },
  ])("classifies $name identically through both discoveries", (control) => {
    const expected = [normalizeTestPath(control.productionFile)];
    const discovered = discoverBoth([control.testFile, control.productionFile]);
    expect(discovered.changed).toEqual(expected);
    expect(discovered.inventory).toEqual(expected);
  });

  it("rejects test-support prefix widening specifically on test-supporting", async () => {
    const source = readFileSync(sqlExecutionSurfaceFile, "utf8");
    const trueSegments = testOnlyDirectorySegments.map((segment) => `src/${segment}/control.ts`);
    const productionLookalikes = [
      "src/test-supporting/control.ts",
      "src/testsupport/control.ts",
      "src/pretest/control.ts",
      "src/fixture2/control.ts",
    ];
    const corpus = [...trueSegments, ...productionLookalikes];
    const candidate = discoverBoth(corpus, await loadSqlExecutionModuleFromSource(source));
    const mutant = discoverBoth(
      corpus,
      await loadSqlExecutionModuleFromSource(mutateOwnershipSource(source, "test-support prefix widening")),
    );
    const releasedFromGovernance = candidate.changed.filter((file) => !mutant.changed.includes(file));

    console.log(`test-support prefix widening released: ${releasedFromGovernance.join(", ")}`);
    expect(releasedFromGovernance).toEqual(["src/test-supporting/control.ts"]);
    expect(mutant.changed).toEqual(mutant.inventory);
    expect(mutant.changed).toEqual(productionLookalikes.slice(1).sort());
  });
});

describe("SQL execution diff scope fail-closed controls", () => {
  it.each([
    ["malformed CHANGED_FILES_JSON", "{", "SQL_CHANGED_FILES_INVALID_JSON"],
    ["non-array CHANGED_FILES_JSON", "{}", "SQL_CHANGED_FILES_NOT_ARRAY"],
  ])("%s", (_label, changedFilesJson, code) => {
    expect(() => deriveChangedSqlExecutionFiles({ repoRoot, changedFilesJson })).toThrowError(
      expect.objectContaining({ name: "SqlExecutionGuardError", code }),
    );
  });

  it.each([
    ["missing origin/main", ["merge-base", "origin/main", "HEAD"], "SQL_MERGE_BASE_FAILED"],
    ["failed diff", ["diff", "--name-only"], "SQL_DIFF_FAILED"],
  ])("%s", (_label, failingPrefix, code) => {
    const execGit = (args) => {
      if (args.slice(0, failingPrefix.length).join(" ") === failingPrefix.join(" ")) throw new Error("control");
      return "abc123\n";
    };
    expect(() => withoutChangedFilesJson(() => deriveChangedSqlExecutionFiles({ repoRoot, execGit }))).toThrowError(
      expect.objectContaining({ name: "SqlExecutionGuardError", code }),
    );
  });

  it("fails outside Git and accepts only a successfully derived empty diff", () => {
    expect(() =>
      withoutChangedFilesJson(() =>
        deriveChangedSqlExecutionFiles({
          repoRoot,
          execGit: () => {
            throw new Error("not git");
          },
        }),
      ),
    ).toThrowError(expect.objectContaining({ name: "SqlExecutionGuardError", code: "SQL_MERGE_BASE_FAILED" }));
    expect(
      withoutChangedFilesJson(() =>
        deriveChangedSqlExecutionFiles({
          repoRoot,
          execGit: (args) => (args[0] === "merge-base" ? "abc123\n" : ""),
        }),
      ),
    ).toEqual([]);
  });

  it("preserves deletion and rename-destination classification", () => {
    const deletedTestOnlyPath = "deployables/platform-api/tests/deleted-support.ts";
    const renamedIntoTestOnlyPath = "deployables/platform-api/test-support/renamed-support.ts";
    const renamedOutToProductionPath = "deployables/platform-api/src/renamed-support.ts";

    expect(
      deriveChangedSqlExecutionFiles({
        repoRoot,
        changedFilesJson: JSON.stringify([deletedTestOnlyPath]),
      }),
    ).toEqual([]);
    expect(
      deriveChangedSqlExecutionFiles({
        repoRoot,
        changedFilesJson: JSON.stringify([renamedIntoTestOnlyPath]),
      }),
    ).toEqual([]);
    expect(
      deriveChangedSqlExecutionFiles({
        repoRoot,
        changedFilesJson: JSON.stringify([renamedOutToProductionPath]),
      }),
    ).toEqual([renamedOutToProductionPath]);
  });

  it("keeps the ACMR diff contract and normalizes Windows rename destinations", () => {
    const calls = [];
    const files = withoutChangedFilesJson(() =>
      deriveChangedSqlExecutionFiles({
        repoRoot,
        execGit: (args) => {
          calls.push(args);
          if (args[0] === "merge-base") return "synthetic-base\n";
          if (args[0] === "diff") {
            return "deployables\\platform-api\\test-support\\renamed.ts\ndeployables\\platform-api\\src\\renamed.ts\n";
          }
          throw new Error(`unexpected Git arguments: ${JSON.stringify(args)}`);
        },
      }),
    );
    expect(calls).toEqual([
      ["merge-base", "origin/main", "HEAD"],
      ["diff", "--name-only", "--diff-filter=ACMR", "synthetic-base", "HEAD"],
    ]);
    expect(files).toEqual(["deployables/platform-api/src/renamed.ts"]);
  });

  it("discovers an arbitrary production-path SQL negative control through the real guard", () => {
    const root = createContractRepo();
    const productionFile = "deployables/platform-api/test-supporting/arbitrary-negative-control.ts";
    const testOnlyTwin = "deployables/platform-api/tests/arbitrary-negative-control.ts";
    const source = 'export async function plantedProductionControl(db) { await db.query("select 1"); }\n';
    for (const file of [productionFile, testOnlyTwin]) {
      const absoluteFile = path.join(root, file);
      mkdirSync(path.dirname(absoluteFile), { recursive: true });
      writeFileSync(absoluteFile, source);
    }
    expect(readFileSync(path.join(root, productionFile), "utf8")).toBe(
      readFileSync(path.join(root, testOnlyTwin), "utf8"),
    );

    const result = runSqlExecutionSurfaceGuard({
      repoRoot: root,
      changedFilesJson: JSON.stringify([productionFile, testOnlyTwin]),
    });
    console.log(`planted production SQL violation: ${result.violations.join("\n")}`);
    expect(result.modules.map((module) => module.file)).toEqual([productionFile]);
    expect(result.violations).toEqual([expect.stringContaining(`${productionFile}:1`)]);
    expect(result.violations[0]).toContain("receiver db");
    expect(result.violations[0]).toContain(SANCTIONED_SQL_RECEIVER_RESOLUTION);
    expect(result.violations[0]).not.toContain(testOnlyTwin);
  });
});

describe("repository-wide SQL execution partition", () => {
  it("enumerates only cached Git index entries", () => {
    const calls = [];
    const files = listNonTestTypeScriptModules(repoRoot, {
      execGit: (args) => {
        calls.push(args);
        return [
          "src/tracked.ts",
          "src/tracked.mts",
          "src/tracked.test.ts",
          "src/tracked.d.ts",
          "src/fixtures/tracked.ts",
          "",
        ].join("\0");
      },
    });
    expect(calls).toEqual([["ls-files", "-z", "--cached"]]);
    expect(files).toEqual(["src/tracked.mts", "src/tracked.ts"]);
  });

  it("generates from the tracked filename inventory and ignores filesystem build output", () => {
    const root = createContractRepo();
    const trackedFile = "src/tracked.ts";
    const buildOutputFile = "dist/generated.ts";
    for (const file of [trackedFile, buildOutputFile]) {
      const absoluteFile = path.join(root, file);
      mkdirSync(path.dirname(absoluteFile), { recursive: true });
      writeFileSync(absoluteFile, "export const value = 1;\n");
    }
    const calls = [];
    const partition = partitionFromTrackedInventory(root, {
      execGit: (args) => {
        calls.push(args);
        return `${trackedFile}\0`;
      },
    });

    expect(calls).toEqual([["ls-files", "-z", "--cached"]]);
    expect(partition.notSql).toEqual([trackedFile]);
    expect(partition.sqlExecuting).toEqual([]);
    expect(partition.unprovableForm).toEqual([]);
    expect(partition.notSql).not.toContain(buildOutputFile);
  });

  it("measures the exact five-module and enforcement-neutral partition transition", () => {
    const trackedFiles = execFileSync("git", ["ls-files", "-z", "--cached"], {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    })
      .split("\0")
      .filter(Boolean)
      .map(normalizeTestPath);
    const legacyTestOnlySegments = new Set(["__tests__", "e2e", "fixtures", "tests"]);
    const legacyModules = trackedFiles
      .filter((file) => /\.(?:ts|mts)$/.test(file))
      .filter((file) => !/\.(?:test|spec|d)\.(?:ts|mts)$/.test(file))
      .filter((file) => !file.split("/").some((segment) => legacyTestOnlySegments.has(segment)))
      .sort();
    const governedModules = listNonTestTypeScriptModules(repoRoot);
    const governedSet = new Set(governedModules);
    const removedModules = legacyModules.filter((file) => !governedSet.has(file));
    const removedClassification = classify(removedModules);
    const legacyPartition = partitionFromFiles(repoRoot, legacyModules);
    const partition = partitionFromFiles(repoRoot, governedModules);

    expect(legacyModules).toHaveLength(2276);
    expect(governedModules).toHaveLength(2271);
    expect(removedModules).toEqual(exactRemovedModules);
    expect(removedClassification.modules.map(({ file, outcome }) => ({ file, outcome }))).toEqual(
      exactRemovedModules.map((file) => ({ file, outcome: "not-sql" })),
    );
    expect(removedClassification.violations).toEqual([]);
    expect(removedClassification.unresolvedMemberRoots).toEqual({ count: 0, fileList: [] });

    expect(legacyPartition.sqlExecuting).toHaveLength(377);
    expect(legacyPartition.unprovableForm).toHaveLength(3);
    expect(legacyPartition.notSql).toHaveLength(1896);
    expect(legacyPartition.unresolvedMemberRoots.count).toBe(263);
    expect(partition.sqlExecuting).toEqual(legacyPartition.sqlExecuting);
    expect(partition.unprovableForm).toEqual(legacyPartition.unprovableForm);
    expect(partition.notSql).toEqual(legacyPartition.notSql.filter((file) => !exactRemovedModules.includes(file)));
    expect(partition.notSql).toHaveLength(1891);
    expect(partition.unresolvedMemberRoots).toEqual(legacyPartition.unresolvedMemberRoots);
    expect(partition.sqlExecuting.filter((file) => !legacyPartition.sqlExecuting.includes(file))).toEqual([]);
    expect(partition.unprovableForm.filter((file) => !legacyPartition.unprovableForm.includes(file))).toEqual([]);
    expect(partition.sqlExecuting.length + partition.unprovableForm.length + partition.notSql.length).toBe(
      governedModules.length,
    );
    console.log(
      `SQL module inventory 2276 -> ${governedModules.length}; partition 377/3/1896 -> ` +
        `${partition.sqlExecuting.length}/${partition.unprovableForm.length}/${partition.notSql.length}; ` +
        `unresolvedMemberRoots=${partition.unresolvedMemberRoots.count}; removed=${removedModules.join(",")}`,
    );
  }, 120_000);

  it("keeps the committed partition equal to fresh tracked-inventory classification", () => {
    const actual = partitionFromTrackedInventory(repoRoot);
    const expected = JSON.parse(
      readFileSync(path.join(repoRoot, "scripts/check-structure/sql-execution-surface-partition.json"), "utf8"),
    );

    expect(actual).toEqual(expected);
  }, 120_000);
});
