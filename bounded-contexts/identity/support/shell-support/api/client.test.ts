import { describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "@chase-sets/typescript-compiler-api";
import { createIdentityApiClient } from "./client";

function buildClient() {
  const requests: Request[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    requests.push(request);
    return Response.json({ id: "acc_1", version: 2, status: "active" });
  });
  return {
    client: createIdentityApiClient({ baseUrl: "https://identity.test/api/identity", fetch }),
    requests,
  };
}

describe("Identity API account enforcement client", () => {
  it("identity-preference-write-caller-inventory", async () => {
    const root = fileURLToPath(new URL("../../../../../", import.meta.url));
    const files = execFileSync(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard", "--", "bounded-contexts", "deployables"],
      { cwd: root, encoding: "utf8" },
    )
      .split(/\r?\n/)
      .filter(
        (file) =>
          /\.[cm]?[jt]sx?$/.test(file) && !/(?:\/tests\/|\/__tests__\/|\.(?:test|spec)\.[cm]?[jt]sx?$)/.test(file),
      );
    const sources = new Map(files.map((file) => [file, readFileSync(path.join(root, file), "utf8")]));
    const classified = [
      "bounded-contexts/identity/features/preferences/api/route.ts:writeUserPreferences",
      "bounded-contexts/identity/features/preferences/api/runtime.ts:SetUserPreferences",
      "bounded-contexts/identity/features/preferences/api/runtime.ts:SetUserPreferences",
      "bounded-contexts/identity/support/shell-support/api/client.ts:Hono PUT",
      "bounded-contexts/identity/support/shell-support/ui/user-preferences-account-menu.ts:updateUserPreferences",
      "deployables/admin-web/app/admin-root-shell.tsx:useUserPreferencesAccountMenu",
      "deployables/admin-web/app/admin-section-layout.tsx:useUserPreferencesAccountMenu",
      "deployables/marketplace/app/routes/layout.tsx:useUserPreferencesAccountMenu",
    ].sort();
    const inspect = (input: Map<string, string>) => {
      const found: string[] = [];
      for (const [file, source] of input) {
        if (!/preferences|UserPreferences|createIdentityApiClient/.test(source)) continue;
        const tree = ts.createSourceFile(
          file,
          source,
          ts.ScriptTarget.Latest,
          true,
          file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
        );
        const name = (node: ts.Node): string | null =>
          ts.isIdentifier(node)
            ? node.text
            : ts.isPropertyAccessExpression(node)
              ? node.name.text
              : ts.isElementAccessExpression(node) &&
                  node.argumentExpression &&
                  ts.isStringLiteral(node.argumentExpression)
                ? node.argumentExpression.text
                : null;
        const clients = new Set<string>();
        const segments = new Set<string>();
        const discover = (node: ts.Node) => {
          if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
            if (
              ts.isCallExpression(node.initializer) &&
              (name(node.initializer.expression) === "createIdentityApiClient" ||
                (name(node.initializer.expression) === "honoClientResource" && source.includes("buildIdentityApi")))
            )
              clients.add(node.name.text);
            if (ts.isStringLiteral(node.initializer) && node.initializer.text === "preferences")
              segments.add(node.name.text);
          }
          ts.forEachChild(node, discover);
        };
        discover(tree);
        const receiver = (node: ts.Expression): string | null => {
          while (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) node = node.expression;
          return ts.isIdentifier(node) ? node.text : null;
        };
        const visit = (node: ts.Node) => {
          if (ts.isCallExpression(node)) {
            const method = name(node.expression);
            if (
              ["updateUserPreferences", "writeUserPreferences", "useUserPreferencesAccountMenu"].includes(method ?? "")
            )
              found.push(`${file}:${method}`);
            if (
              ["$put", "$post", "$patch", "$delete"].includes(method ?? "") &&
              /preferences/.test(node.expression.getText(tree))
            )
              found.push(`${file}:Hono ${method!.slice(1).toUpperCase()}`);
          }
          if (ts.isPropertyAssignment(node) && name(node.name) === "type") {
            const value = ts.isAsExpression(node.initializer) ? node.initializer.expression : node.initializer;
            if (ts.isStringLiteral(value) && value.text === "SetUserPreferences")
              found.push(`${file}:SetUserPreferences`);
          }
          if (
            ts.isImportSpecifier(node) &&
            node.propertyName &&
            ["useUserPreferencesAccountMenu", "updateUserPreferences", "writeUserPreferences"].includes(
              node.propertyName.text,
            )
          )
            found.push(`${file}:INDETERMINATE alias`);
          if (
            ts.isVariableDeclaration(node) &&
            node.initializer &&
            ["preferences", "updateUserPreferences", "writeUserPreferences", "useUserPreferencesAccountMenu"].includes(
              name(node.initializer) ?? "",
            )
          )
            found.push(`${file}:INDETERMINATE alias`);
          if (ts.isBindingElement(node)) {
            const bound = name(node.propertyName ?? node.name);
            const declaration = node.parent.parent;
            if (
              ["updateUserPreferences", "writeUserPreferences", "useUserPreferencesAccountMenu"].includes(
                bound ?? "",
              ) ||
              (bound === "preferences" &&
                ts.isVariableDeclaration(declaration) &&
                declaration.initializer &&
                clients.has(name(declaration.initializer) ?? ""))
            )
              found.push(`${file}:INDETERMINATE alias`);
          }
          if (
            ts.isElementAccessExpression(node) &&
            !ts.isStringLiteral(node.argumentExpression) &&
            (/preferences/.test(node.expression.getText(tree)) ||
              segments.has(name(node.argumentExpression) ?? "") ||
              clients.has(receiver(node.expression) ?? ""))
          )
            found.push(`${file}:INDETERMINATE computed`);
          ts.forEachChild(node, visit);
        };
        visit(tree);
      }
      return found.sort();
    };
    expect(inspect(sources)).toEqual(classified);
    const fixture = "deployables/marketplace/app/new-preference-writer.tsx";
    const control = (source: string) => inspect(new Map([...sources, [fixture, source]]));
    for (const source of [
      'client.preferences.$put({json:{colorMode:"dark"}})',
      'client["preferences"]["$put"]({json:{colorMode:"dark"}})',
      'api.updateUserPreferences({colorMode:"dark"})',
      'useUserPreferencesAccountMenu("dark", "usr_fixture")',
      "const writer = client.preferences; writer.$put({})",
      "client.preferences[method]({})",
      "const { updateUserPreferences: save } = api; save({})",
      "services.preferences.writeUserPreferences({})",
      'const command = { type: "SetUserPreferences", userId: "usr_fixture" }',
      'const key = "preferences"; client[key].$put({})',
      "const identity = createIdentityApiClient(); const { preferences: writer } = identity; writer.$put({})",
      "const identity = createIdentityApiClient(); identity[method]({})",
    ])
      expect(control(source), source).not.toEqual(classified);
    expect(control("client.preferences.$get({})")).toEqual(classified);
    expect(
      inspect(
        new Map([
          ...sources,
          ["bounded-contexts/identity/features/preferences/api/new-client.ts", "client.preferences.$put({})"],
        ]),
      ),
    ).not.toEqual(classified);
    expect(files.some((file) => file.startsWith("artifacts/"))).toBe(false);
    const manifest = JSON.parse(readFileSync(path.join(root, "bounded-contexts/identity/context.json"), "utf8"));
    const inventory = manifest.mutationConsistencyInventory;
    const entry = inventory.find((row: { id: string }) => row.id === "identity.user-preferences-api-command-snapshots");
    expect(entry.proof.authoritativeResponse).toContain("writeUserPreferences");
    expect(readFileSync(path.join(root, "deployables/marketplace/e2e/critical-flows.spec.ts"), "utf8")).toMatch(
      /request\.put\("\/api\/identity\/preferences",\s*\{\s*headers: \{ "Idempotency-Key": crypto\.randomUUID\(\) \}/,
    );
    const fixtureRoot = mkdtempSync(path.join(tmpdir(), "cs-7164-census-"));
    try {
      const route = path.join(fixtureRoot, "bounded-contexts/identity/features/preferences/api/new-route.ts");
      mkdirSync(path.dirname(route), { recursive: true });
      writeFileSync(route, 'app.put("/", async c => c.json({}));');
      const checker = await import(
        pathToFileURL(path.join(root, "scripts/check-structure/read-after-write-inventory.mjs")).href
      );
      const contexts = new Map([
        [
          "bounded-contexts/identity",
          {
            root: "bounded-contexts/identity",
            rootAbs: path.join(fixtureRoot, "bounded-contexts/identity"),
            packageName: manifest.packageName,
            manifest: {
              contextName: "identity",
              packageName: manifest.packageName,
              projectionGroups: [],
              apiMounts: [],
            },
          },
        ],
      ]);
      const result = await checker.validateReadAfterWriteRouteInventory({
        repoRoot: fixtureRoot,
        contextManifests: contexts,
        frozenBaselineSurfaces: new Set(),
      });
      expect(
        result.violations.some(
          (violation: string) => violation.includes("new-route.ts") && violation.includes("unclassified"),
        ),
      ).toBe(true);
    } finally {
      // mkdtemp's exact child is the only recursive removal target.
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });
  it("preference-write-client-interruption-matrix", async () => {
    const { client, requests } = buildClient();
    await client.updateUserPreferences({ colorMode: "dark" });
    await client.updateUserPreferences({ colorMode: "light" });
    const keys = requests.map((request) => request.headers.get("Idempotency-Key"));
    expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(keys[1]).not.toBe(keys[0]);
    await expect(requests[0].json()).resolves.toEqual({ colorMode: "dark" });
  });
  it("keeps the one-argument lifecycle calls as literal empty JSON objects", async () => {
    const { client, requests } = buildClient();

    await client.suspendAccount("acc_1");
    await client.reactivateAccount("acc_1");
    await client.closeAccount("acc_1");

    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
      "/api/identity/accounts/acc_1/suspend",
      "/api/identity/accounts/acc_1/reactivate",
      "/api/identity/accounts/acc_1/close",
    ]);
    await expect(Promise.all(requests.map((request) => request.clone().json()))).resolves.toEqual([{}, {}, {}]);
  });

  it("forwards a supplied structured lifecycle body unchanged", async () => {
    const { client, requests } = buildClient();
    const body = {
      reason: "policy-violation" as const,
      reference: {
        kind: "support-request" as const,
        supportRequestId: "sup_01ARYZ6S41TSV4RRFFQ69G5FAV" as const,
      },
    };

    await client.suspendAccount("acc_1", body);

    await expect(requests[0]?.json()).resolves.toEqual(body);
  });
});
