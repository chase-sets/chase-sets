import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "@chase-sets/typescript-compiler-api";
import { describe, expect, it } from "vitest";
import { DB_TEST_SCRIPT_SELECTOR, runWorkspaceScripts } from "../../../../../../scripts/run-workspaces.mjs";

const repoRoot = fileURLToPath(new URL("../../../../../../", import.meta.url));
const roots = ["bounded-contexts", "contracts", "deployables", "infrastructure", "packages"];
const mapperPath =
  "bounded-contexts/notifications/features/notification-center/integrations/source-events/notification-intents.ts";
const dbFile = "features/notification-center/integrations/source-events/cancellation-delivery.db.test.ts";
const normalize = (value: string) => value.replaceAll("\\", "/");

function trackedFiles() {
  return execFileSync("git", ["ls-files", "--cached", "-z", "--", ...roots], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  })
    .split("\0")
    .filter(Boolean)
    .sort();
}

function partition(files: readonly string[]) {
  const production: string[] = [];
  const excluded: string[] = [];
  for (const file of files) {
    if (!roots.some((root) => file.startsWith(`${root}/`))) throw new Error(`Source outside workspace roots: ${file}`);
    if (
      /\.[cm]?[jt]sx?$/.test(file) &&
      !/\.(?:test|spec|tmp|d)\.[cm]?[jt]sx?$/.test(file) &&
      !/(?:^|\/)(?:tests|__tests__|fixtures|e2e|build|dist|coverage)(?:\/|$)/.test(file)
    )
      production.push(file);
    else excluded.push(file);
  }
  if (new Set(files).size !== files.length || production.length + excluded.length !== files.length)
    throw new Error("Incomplete source partition");
  return { production, excluded };
}

function visit(node: ts.Node, callback: (node: ts.Node) => void) {
  callback(node);
  ts.forEachChild(node, (child) => visit(child, callback));
}

type Owner = ts.FunctionLikeDeclaration | ts.SourceFile;
function owner(node: ts.Node): Owner {
  let current = node.parent;
  while (current && !ts.isFunctionLike(current) && !ts.isSourceFile(current)) current = current.parent;
  return current as Owner;
}

function unwrap(node: ts.Node): ts.Node {
  while (
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isParenthesizedExpression(node) ||
    ts.isNonNullExpression(node)
  )
    node = node.expression;
  return node;
}

function scan(files: readonly string[], sources: ReadonlyMap<string, string>, expectedFiles = trackedFiles()) {
  if (JSON.stringify([...files].sort()) !== JSON.stringify([...expectedFiles].sort()))
    throw new Error("Omitted tracked source discovery");
  const { production, excluded } = partition(files);
  if (sources.size !== production.length || production.some((file) => !sources.has(file)))
    throw new Error("Unreadable or omitted production source partition");
  const absolute = (file: string) => normalize(path.resolve(repoRoot, file));
  const sourceByAbsolute = new Map([...sources].map(([file, source]) => [absolute(file), source]));
  const options: ts.CompilerOptions = {
    noLib: true,
    noResolve: true,
    allowJs: true,
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
  };
  const host = ts.createCompilerHost(options);
  host.readFile = (file) => sourceByAbsolute.get(normalize(file));
  host.fileExists = (file) => sourceByAbsolute.has(normalize(file));
  host.getSourceFile = (file, languageVersion) => {
    const source = host.readFile(file);
    return source === undefined ? undefined : ts.createSourceFile(file, source, languageVersion, true);
  };
  const program = ts.createProgram(production.map(absolute), options, host);
  const checker = program.getTypeChecker();
  const loaded = program.getSourceFiles();
  if (loaded.length !== production.length) throw new Error("Incomplete compiler source partition");
  const edges = new Map<Owner, Set<Owner>>();
  const sinks = new Set<Owner>();
  const cancellationOwners = new Set<Owner>();
  const objects: ts.ObjectLiteralExpression[] = [];

  function declarations(node: ts.Node): readonly ts.Declaration[] {
    let symbol = ts.isShorthandPropertyAssignment(node.parent)
      ? checker.getShorthandAssignmentValueSymbol(node.parent)
      : checker.getSymbolAtLocation(node);
    if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
    return symbol?.declarations ?? [];
  }
  function values(node: ts.Node | undefined, seen = new Set<ts.Node>()): ts.Node[] {
    if (!node || seen.has(node)) return [];
    node = unwrap(node);
    const next = new Set(seen).add(node);
    if (ts.isIdentifier(node))
      return declarations(node).flatMap((declaration) => {
        if (ts.isVariableDeclaration(declaration) || ts.isParameter(declaration) || ts.isBindingElement(declaration))
          return values(declaration.initializer, next);
        if (ts.isFunctionDeclaration(declaration)) return [declaration];
        if (ts.isShorthandPropertyAssignment(declaration)) return values(declaration.name, next);
        return [];
      });
    if (ts.isConditionalExpression(node)) return [...values(node.whenTrue, next), ...values(node.whenFalse, next)];
    if (ts.isPropertyAccessExpression(node))
      return values(node.expression, next).flatMap((value) =>
        ts.isObjectLiteralExpression(value) ? values(property(value, node.name.text), next) : [],
      );
    return [node];
  }
  function strings(node: ts.Node | undefined, seen = new Set<ts.Node>()): string[] {
    if (!node || seen.has(node)) return [];
    const next = new Set(seen).add(node);
    return values(node).flatMap((value) => {
      if (ts.isStringLiteralLike(value)) return [value.text];
      if (ts.isBinaryExpression(value) && value.operatorToken.kind === ts.SyntaxKind.PlusToken)
        return strings(value.left, next).flatMap((left) => strings(value.right, next).map((right) => left + right));
      if (ts.isTemplateExpression(value)) {
        let result = [value.head.text];
        for (const span of value.templateSpans)
          result = result.flatMap((left) =>
            strings(span.expression, next).map((right) => left + right + span.literal.text),
          );
        return result;
      }
      return [];
    });
  }
  function property(object: ts.ObjectLiteralExpression, name: string): ts.Node | undefined {
    for (const member of object.properties) {
      if (
        (ts.isPropertyAssignment(member) || ts.isShorthandPropertyAssignment(member)) &&
        (ts.isComputedPropertyName(member.name)
          ? strings(member.name.expression).includes(name)
          : member.name.getText().replace(/^["']|["']$/g, "") === name)
      )
        return ts.isPropertyAssignment(member) ? member.initializer : member.name;
    }
    return undefined;
  }
  function connect(from: Owner, to: Owner) {
    if (from === to) return;
    if (!edges.has(from)) edges.set(from, new Set());
    edges.get(from)!.add(to);
  }
  function functionTargets(node: ts.Node, seen = new Set<ts.Node>()): Owner[] {
    if (seen.has(node)) return [];
    const next = new Set(seen).add(node);
    return declarations(node).flatMap((declaration) => {
      if (ts.isFunctionDeclaration(declaration)) return [declaration];
      if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
        const value = unwrap(declaration.initializer);
        if (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) return [value];
        if (ts.isIdentifier(value)) return functionTargets(value, next);
      }
      return [];
    });
  }
  function isSink(node: ts.Node, seen = new Set<ts.Node>()): boolean {
    node = unwrap(node);
    if (seen.has(node)) return false;
    const next = new Set(seen).add(node);
    if (ts.isPropertyAccessExpression(node) && node.name.text === "enqueueNotification") return true;
    if (ts.isElementAccessExpression(node) && strings(node.argumentExpression).includes("enqueueNotification"))
      return true;
    if (ts.isIdentifier(node))
      return declarations(node).some((declaration) => {
        if (ts.isBindingElement(declaration))
          return (declaration.propertyName ?? declaration.name).getText() === "enqueueNotification";
        return (
          ts.isVariableDeclaration(declaration) &&
          declaration.initializer !== undefined &&
          isSink(declaration.initializer, next)
        );
      });
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "bind"
    )
      return isSink(node.expression.expression, next);
    return false;
  }
  function hasEmail(node: ts.Node | undefined, seen = new Set<ts.Node>()): boolean {
    if (!node || seen.has(node)) return false;
    const next = new Set(seen).add(node);
    return values(node).some((value) => {
      if (ts.isArrayLiteralExpression(value)) return value.elements.some((element) => hasEmail(element, next));
      if (ts.isSpreadElement(value)) return hasEmail(value.expression, next);
      if (ts.isObjectLiteralExpression(value))
        return strings(property(value, "channel")).includes("email") || property(value, "to") !== undefined;
      return false;
    });
  }
  for (const source of loaded) {
    visit(source, (node) => {
      const current = owner(node);
      if (ts.isFunctionLike(node) && !ts.isSourceFile(current)) connect(current, node as Owner);
      if (ts.isObjectLiteralExpression(node)) objects.push(node);
      if (ts.isCallExpression(node) && isSink(node.expression)) sinks.add(current);
      if (ts.isIdentifier(node) && !ts.isSourceFile(current)) {
        for (const target of functionTargets(node)) connect(current, target);
      }
      if (
        ts.isPropertyAssignment(node) &&
        strings(ts.isComputedPropertyName(node.name) ? node.name.expression : node.name).includes(
          "ordering.order.cancelled",
        )
      ) {
        cancellationOwners.add(current);
        if (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
          cancellationOwners.add(node.initializer);
      }
      if (
        ts.isPropertyAssignment(node) &&
        (ts.isStringLiteralLike(node.initializer) || ts.isBinaryExpression(node.initializer)) &&
        strings(node.initializer).some((value) => value === "ordering.order.cancelled")
      )
        cancellationOwners.add(current);
      if (
        ts.isBinaryExpression(node) &&
        (ts.isStringLiteralLike(node.right) || ts.isBinaryExpression(node.right)) &&
        strings(node.right).includes("ordering.order.cancelled")
      )
        cancellationOwners.add(current);
    });
  }
  const incoming = new Map<Owner, Set<Owner>>();
  for (const [caller, callees] of edges)
    for (const callee of callees) {
      if (!incoming.has(callee)) incoming.set(callee, new Set());
      incoming.get(callee)!.add(caller);
    }
  function ancestors(starts: Iterable<Owner>) {
    const found = new Set(starts);
    const pending = [...found];
    while (pending.length) {
      for (const caller of incoming.get(pending.pop()!) ?? []) {
        if (!found.has(caller)) {
          found.add(caller);
          pending.push(caller);
        }
      }
    }
    return found;
  }
  const sinkCallers = ancestors(sinks);
  const cancellationReach = new Set(cancellationOwners);
  const pendingCancellation = [...cancellationOwners];
  while (pendingCancellation.length) {
    for (const callee of edges.get(pendingCancellation.pop()!) ?? []) {
      if (!cancellationReach.has(callee)) {
        cancellationReach.add(callee);
        pendingCancellation.push(callee);
      }
    }
  }
  const authors: string[] = [];
  let safeMessages = 0;
  let forwardingMessages = 0;
  for (const object of objects) {
    const messageType = property(object, "messageType");
    if (!messageType) continue;
    const types = strings(messageType);
    const current = owner(object);
    const cancellation =
      types.some((value) => value === "ordering.order.cancelled" || value.startsWith("ordering.order.cancelled.")) ||
      strings(property(object, "templateId")).includes("order_cancelled");
    if (types.length === 0 && !cancellation) {
      // Generic adapters forward the caller's message; a cancellation owner cannot hide an unresolved author.
      if (cancellationReach.has(current) && (hasEmail(property(object, "channels")) || property(object, "to")))
        throw new Error(`Unresolved cancellation message in ${object.getSourceFile().fileName}`);
      forwardingMessages++;
      continue;
    }
    if (!cancellation) {
      safeMessages++;
      continue;
    }
    if (!hasEmail(property(object, "channels")) && !property(object, "to")) continue;
    const callersWithSink = [...ancestors([current])].filter((caller) => sinkCallers.has(caller));
    if (callersWithSink.length === 0)
      throw new Error(`Unresolved cancellation outbox composition: ${object.getSourceFile().fileName}`);
    const name = ts.isFunctionDeclaration(current)
      ? current.name?.text
      : ts.isVariableDeclaration(current.parent)
        ? current.parent.name.getText()
        : "closure";
    authors.push(`${normalize(path.relative(repoRoot, object.getSourceFile().fileName))}#${name}`);
  }
  const retired = [
    "mapOrderPaymentDeadlineCancelledToTransactionalEmail",
    "OrderPaymentDeadlineCancelledEmailIntentInput",
    "OrderingOrderCancelledEmailData",
    "order_payment_deadline_cancelled",
    "reorderHref",
    "reorderFrom",
    "reorderCTA",
  ];
  for (const [file, source] of sources)
    for (const token of retired)
      if (source.includes(token)) throw new Error(`Retired cancellation token ${token} in ${file}`);
  return {
    authors: authors.sort(),
    total: files.length,
    scanned: production.length,
    excluded: excluded.length,
    safeMessages,
    forwardingMessages,
    sinks: sinks.size,
  };
}

function assertOneProducer(result: ReturnType<typeof scan>) {
  expect(result.authors, "cancellation email structural producers").toEqual([
    `${mapperPath}#mapOrderCancelledToNotification`,
  ]);
  expect(result.total).toBe(result.scanned + result.excluded);
  expect(result.safeMessages).toBeGreaterThan(0);
  expect(result.sinks).toBeGreaterThan(0);
}

describe("cancellation delivery ownership", () => {
  it("cancellation email has one structural producer", () => {
    const files = trackedFiles();
    const sources = new Map(
      partition(files).production.map((file) => [file, readFileSync(path.join(repoRoot, file), "utf8")]),
    );
    const result = scan(files, sources);
    console.log("Cancellation producer inventory", result);
    assertOneProducer(result);
  });

  it("cancellation structural discovery rejects omitted or unreadable source", () => {
    const files = trackedFiles();
    const sources = new Map(
      partition(files).production.map((file) => [file, readFileSync(path.join(repoRoot, file), "utf8")]),
    );
    sources.delete(mapperPath);
    expect(() => scan(files, sources)).toThrow("Unreadable or omitted production source partition");
    expect(() =>
      scan(
        files.filter((file) => file !== mapperPath),
        sources,
      ),
    ).toThrow("Omitted tracked source discovery");
  });

  it("cancellation structural producer follows imported aliases and closure ownership", () => {
    const files = trackedFiles();
    const sources = new Map(
      partition(files).production.map((file) => [file, readFileSync(path.join(repoRoot, file), "utf8")]),
    );
    const sibling = "bounded-contexts/pricing/features/synthetic-emission.ts";
    const helper = "bounded-contexts/pricing/features/synthetic-composition.ts";
    const helperSource = `export function compose() { return { messageType: "ordering." + "order." + "cancelled", channels: [{ channel: "email", to: [{ email: "synthetic@example.test" }] }], templateId: "order_" + "cancelled" }; }`;
    const siblingSource = `import { compose as differentName } from "./synthetic-composition";
      export function install(outbox) { const transmit = outbox.enqueueNotification.bind(outbox);
        return { ["ordering." + "order." + "cancelled"]: async () => { await transmit({ message: differentName() }); } }; }`;
    const mutantFiles = [...files, sibling, helper].sort();
    const mutantSources = new Map([...sources, [sibling, siblingSource], [helper, helperSource]]);
    expect(() => assertOneProducer(scan(mutantFiles, mutantSources, mutantFiles))).toThrow(
      "cancellation email structural producers",
    );
    mutantSources.set(helper, helperSource.replaceAll('"cancelled"', '"created"'));
    assertOneProducer(scan(mutantFiles, mutantSources, mutantFiles));
  });

  it("cancellation DB profile is selected and unit-excluded", async () => {
    const manifests = trackedFiles().filter((file) => /^[^/]+\/[^/]+\/package\.json$/.test(file));
    const workspaces = manifests.map((file) => {
      const packageJson = JSON.parse(readFileSync(path.join(repoRoot, file), "utf8")) as {
        name: string;
        scripts: Record<string, string>;
        chaseSets?: { testProfile?: string };
      };
      return { name: packageJson.name, packageJson };
    });
    const notifications = workspaces.find((workspace) => workspace.name === "@chase-sets/notifications");
    if (!notifications) throw new Error("Notifications workspace absent");
    async function assertEnrollment(candidates: typeof workspaces) {
      const invocations: string[][] = [];
      await runWorkspaceScripts({
        argv: [DB_TEST_SCRIPT_SELECTOR, "--workspace=@chase-sets/notifications"],
        listWorkspaces: () => candidates,
        loadEnvironment: () => undefined,
        appendSummary: () => undefined,
        run: async (_command, args) => {
          invocations.push([...args]);
        },
      });
      expect(invocations, "exactly one Notifications DB script invocation").toHaveLength(1);
      expect(invocations[0]?.slice(-4)).toEqual(["--filter", "@chase-sets/notifications", "run", "test:db"]);
      const selected = candidates.find((workspace) => workspace.name === notifications!.name)!;
      expect(selected.packageJson.chaseSets?.testProfile).toBe("db");
      expect(selected.packageJson.scripts["test:db"]).toBe(`vitest run --config ./tests/vitest.config.mjs ${dbFile}`);
      for (const script of ["test", "test:unit", "test:fast", "test:watch"])
        expect(selected.packageJson.scripts[script], `${script} excludes DB tests`).toContain(
          "--exclude **/*.db.test.ts",
        );
    }
    await assertEnrollment(workspaces);
    const withoutScript = structuredClone(workspaces);
    delete withoutScript.find((workspace) => workspace.name === notifications.name)!.packageJson.scripts["test:db"];
    await expect(assertEnrollment(withoutScript)).rejects.toThrow("exactly one Notifications DB script invocation");
    const withoutExclusion = structuredClone(workspaces);
    const scripts = withoutExclusion.find((workspace) => workspace.name === notifications.name)!.packageJson.scripts;
    scripts["test:unit"] = scripts["test:unit"]!.replace(" --exclude **/*.db.test.ts", "");
    await expect(assertEnrollment(withoutExclusion)).rejects.toThrow("test:unit excludes DB tests");
  });
});
