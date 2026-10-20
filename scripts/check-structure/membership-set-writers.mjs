import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "@chase-sets/typescript-compiler-api";

const roots = ["bounded-contexts", "contracts", "deployables", "infrastructure", "packages", "scripts"];
const identity = "bounded-contexts/identity/";
const composition = `${identity}support/runtime-support/services.ts`;
const transaction = `${identity}features/account-management/api/fences.ts`;
const cutover = `${identity}features/memberships/api/membership-set-cutover.ts`;
const allowedWriterFiles = new Set([
  composition,
  transaction,
  cutover,
  `${identity}api.ts`,
  `${identity}features/memberships/api/runtime.ts`,
  `${identity}features/memberships/api/route.ts`,
  `${identity}features/invitations/api/acceptance-operation.ts`,
  `${identity}features/account-management/api/runtime.ts`,
  `${identity}support/runtime-support/production-bootstrap.ts`,
  `${identity}support/runtime-support/seed.ts`,
  `${identity}support/runtime-support/admin-qa-actor-fixtures.ts`,
]);
const appendNames = new Set([
  "appendToStream",
  "appendToStreams",
  "appendToStreamInTransaction",
  "appendToStreamsInTransaction",
  "appendToStreamsIndependently",
  "append",
  "commandHandler",
  "createAggregateCommandHandler",
]);
const allowedOwners = new Set([
  "appendPersonalIdentityRegistration",
  "grantGuestAccountForAuth",
  "acceptInvitationForUserFromAuth",
  "readInvitationAcceptanceAuthority",
  "acceptInvitationOperation",
  "membershipRoutes",
  "createMembershipRuntime",
  "createIdentityMutationPersistence",
  "provisionAdminQaActorFixture",
  "bootstrapPlatformAdminIdentity",
  "membershipReconciler",
  "reconcileRepresentativeMembership",
  "transaction",
  "append",
  "submit",
  "save",
  "reconcile",
]);
const readOnlyFactories = new Set([
  `${identity}features/consents/api/terms-acceptance-resolver.ts`,
  `${identity}support/seed-support/market-following-verification.ts`,
]);

function property(node) {
  if (!node) return null;
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression))
    return node.argumentExpression.text;
  return null;
}

export function scanMembershipSetWriters(sources, expectedFiles) {
  if (JSON.stringify([...sources.keys()].sort()) !== JSON.stringify([...expectedFiles].sort()))
    throw new Error("incomplete Membership writer source partition");
  const rows = [];
  const violations = [];
  let appendSites = 0;
  for (const [file, source] of sources) {
    const ast = ts.createSourceFile(
      file,
      source,
      ts.ScriptTarget.Latest,
      true,
      /\.[jt]sx$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const scopes = new Map();
    function bind(node, key, value) {
      let scope = node.parent;
      while (scope.parent && !ts.isFunctionLike(scope) && !ts.isBlock(scope)) scope = scope.parent;
      const bindings = scopes.get(scope) ?? new Map();
      bindings.set(key, value);
      scopes.set(scope, bindings);
    }
    function binding(node) {
      for (let scope = node.parent; scope; scope = scope.parent) {
        const bindings = scopes.get(scope);
        if (bindings?.has(node.text)) return bindings.get(node.text);
      }
      return null;
    }
    function visit(node, work) {
      work(node);
      ts.forEachChild(node, (child) => visit(child, work));
    }
    visit(ast, (node) => {
      if (ts.isImportSpecifier(node)) bind(node, node.name.text, node.propertyName?.text ?? node.name.text);
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer)
        bind(node, node.name.text, node.initializer);
      if (ts.isParameter(node) && ts.isIdentifier(node.name)) bind(node, node.name.text, null);
      if (ts.isBindingElement(node) && ts.isIdentifier(node.name) && node.propertyName)
        bind(node, node.name.text, node.propertyName.getText(ast).replaceAll(/["']/g, ""));
    });
    function name(node, seen = new Set()) {
      if (!node || seen.has(node)) return null;
      seen.add(node);
      if (ts.isNonNullExpression(node) || ts.isAsExpression(node) || ts.isParenthesizedExpression(node))
        return name(node.expression, seen);
      const member = property(node);
      if (member === "bind") return name(node.expression, seen);
      if (member) return member;
      if (ts.isIdentifier(node)) {
        const value = binding(node);
        return typeof value === "string" ? value : value ? name(value, seen) : node.text;
      }
      if (ts.isCallExpression(node)) return name(node.expression, seen);
      return null;
    }
    function membership(node, seen = new Set()) {
      if (!node || seen.has(node)) return false;
      seen.add(node);
      if (
        ts.isStringLiteralLike(node) ||
        ts.isTemplateHead(node) ||
        ts.isTemplateMiddle(node) ||
        ts.isTemplateTail(node)
      ) {
        if (
          /^(?:identity\.membership[.-]|GrantMembership$|ChangeMembershipRole$|RevokeMembership$|ReinstateMembership$)/.test(
            node.text,
          )
        )
          return true;
      }
      if (ts.isIdentifier(node)) {
        if (
          /^(?:MembershipCommand|MembershipEvent|MembershipServices|decideMembership|createMembershipRuntime)$/.test(
            name(node) ?? "",
          )
        )
          return true;
        const value = binding(node);
        if (value && typeof value !== "string" && membership(value, seen)) return true;
      }
      if (file.startsWith(identity) && property(node) === "memberships") return true;
      let found = false;
      ts.forEachChild(node, (child) => {
        if (!found && membership(child, seen)) found = true;
      });
      return found;
    }
    visit(ast, (node) => {
      if (!ts.isCallExpression(node)) return;
      const called = name(node.expression);
      if (
        called === "createPostgresEventStore" &&
        file.startsWith(identity) &&
        file !== composition &&
        !readOnlyFactories.has(file)
      )
        violations.push(`${file}: raw EventStore factory bypasses Identity composition`);
      if (called === "createMembershipRuntime" && file !== composition)
        violations.push(`${file}: Membership runtime bypasses Identity composition`);
      if (!appendNames.has(called)) return;
      appendSites++;
      if (readOnlyFactories.has(file) && (called.startsWith("append") || called === "createAggregateCommandHandler"))
        violations.push(`${file}: non-Membership EventStore factory gained a raw append`);
      const receiver = property(node.expression?.expression);
      if (
        called === "commandHandler" &&
        ["accounts", "users", "apiKeys", "invitations", "consents", "preferences", "shippingAddresses"].includes(
          receiver,
        )
      )
        return;
      let owner = node;
      while (owner.parent) {
        if (ts.isFunctionLike(owner) && (owner.name || ts.isVariableDeclaration(owner.parent))) break;
        owner = owner.parent;
      }
      const ownerName =
        owner.name?.getText(ast) ??
        (owner.parent && ts.isVariableDeclaration(owner.parent) ? owner.parent.name.getText(ast) : "anonymous");
      if (readOnlyFactories.has(file) && membership(owner))
        violations.push(`${file}: non-Membership EventStore factory gained a Membership append`);
      if (
        (file === composition && called.startsWith("append")) ||
        (file === transaction &&
          called === "appendToStreamsInTransaction" &&
          node.arguments[1]?.getText(ast) !== "expanded")
      )
        violations.push(`${file}: raw append bypasses Membership Set planner`);
      if (
        !membership(owner) &&
        !(file === `${identity}features/account-management/api/runtime.ts` && called === "append")
      )
        return;
      const line = ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1;
      const approved = allowedWriterFiles.has(file) && allowedOwners.has(ownerName);
      rows.push({
        file,
        line,
        call: called,
        owner: ownerName,
        authority: approved ? "Identity transaction composition" : "UNCLASSIFIED",
      });
      if (!approved) violations.push(`${file}:${line}: unclassified Membership writer (${called}, ${ownerName})`);
    });
  }
  const runtime = sources.get(`${identity}features/memberships/api/runtime.ts`) ?? "";
  const wiring = sources.get(composition) ?? "";
  const boundary = sources.get(transaction) ?? "";
  if (
    !/eventStore:\s*deps\.eventStore/.test(runtime) ||
    !/createIdentityMutationPersistence\(pool, postgresEventStore/.test(wiring) ||
    !/const eventStore = mutationPersistence\.eventStore/.test(wiring) ||
    !/const memberships = createMembershipRuntime\(deps\)/.test(wiring) ||
    !/const expanded = await planMembershipSetAppends\(reader, inputs\)/.test(boundary) ||
    !/store\.appendToStreamsInTransaction\(client, expanded\)/.test(boundary)
  )
    violations.push("Membership writer authority composition is not canonical");
  return {
    scanned: sources.size,
    total: expectedFiles.length,
    appendSites,
    membershipSites: rows.length,
    rows,
    violations: [...new Set(violations)],
  };
}

export function validateMembershipSetWriters({ repoRoot }) {
  const files = [
    ...new Set(
      execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", ...roots], {
        cwd: repoRoot,
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
        timeout: 60_000,
        windowsHide: true,
      })
        .split("\0")
        .filter(Boolean),
    ),
  ];
  const production = files.filter(
    (file) =>
      /\.[cm]?[jt]sx?$/.test(file) &&
      !/\.(?:test|spec|tmp|d)\.[cm]?[jt]sx?$/.test(file) &&
      !/(?:^|\/)(?:tests|__tests__|fixtures|e2e|build|dist|coverage)(?:\/|$)/.test(file),
  );
  const excluded = files.filter((file) => !production.includes(file));
  const included = production.filter((file) => !/(?:test-support|test-fixture)\.[cm]?[jt]sx?$/.test(file));
  const sources = new Map(included.map((file) => [file, readFileSync(path.join(repoRoot, file), "utf8")]));
  const census = scanMembershipSetWriters(sources, included);
  const plantedFile = `${identity}features/synthetic-sibling/alternate.ts`;
  const planted = new Map(sources);
  planted.set(
    plantedFile,
    `import { createPostgresEventStore as connect } from "@chase-sets/event-core-postgres"; export function different(pool, input) { const { appendToStream: emit } = connect({ pool }); return emit(input); }`,
  );
  const mutant = scanMembershipSetWriters(planted, [...included, plantedFile]);
  if (
    !mutant.violations.some(
      (violation) => violation === `${plantedFile}: raw EventStore factory bypasses Identity composition`,
    )
  )
    census.violations.push("alternate-syntax sibling bypass negative control was not discriminating");
  return {
    ...census,
    partition: {
      discovered: files.length,
      production: included.length,
      excluded: excluded.length + production.length - included.length,
    },
    plantedBypass: "REJECTED",
    violations: census.violations,
  };
}
