import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import ts from "@chase-sets/typescript-compiler-api";

const root = resolve(import.meta.dirname, "../../../../..");
function rawSend(source: string) {
  const file = ts.createSourceFile("inventory.ts", source, ts.ScriptTarget.Latest, true);
  let found = false;
  function visit(node: ts.Node) {
    if (
      ts.isCallExpression(node) &&
      (node.expression.getText(file) === "fetch" || node.expression.getText(file) === "globalThis.fetch")
    )
      found = true;
    ts.forEachChild(node, visit);
  }
  visit(file);
  return found;
}
describe("staged-import-floor-owner-inventory", () => {
  it("keeps product registration empty, transport in the thin root, and no raw staged-import send", () => {
    const registry = readFileSync(resolve(root, "deployables/tcgplayer-connector-extension/src/executors.ts"), "utf8");
    expect(registry).toContain("connectorExecutors: readonly ConnectorExecutor[] = []");
    const coordinator = readFileSync(resolve(import.meta.dirname, "../domain/operation-coordinator.ts"), "utf8");
    const guard = readFileSync(resolve(import.meta.dirname, "../domain/staged-import-dispatch.ts"), "utf8");
    for (const source of [registry, coordinator, guard]) expect(rawSend(source)).toBe(false);
    expect(rawSend(`${guard}\nfetch('https://synthetic.invalid/raw-bypass');`)).toBe(true);
    expect(coordinator).toContain('executor.providerRequests === "tcgplayer-staged-import"');
    expect(guard).toContain("ports.request(new Request(request, { signal: combined }))");
    const compose = readFileSync(resolve(root, "deployables/tcgplayer-connector-extension/src/compose.ts"), "utf8");
    expect(compose).toContain("coordinate: coordinator.coordinate");
    expect(compose).toContain(
      "createConnectorOperationCoordinator({ ...database, executors, platformOrigin, request, clock })",
    );
  });
  it("enrolls the exact DB producer test and excludes it from local non-DB unit tests", () => {
    const pkg = JSON.parse(readFileSync(resolve(root, "bounded-contexts/channels/package.json"), "utf8"));
    const path = "features/connector-feed/tests/staged-import-floor-policy-production.db.test.ts";
    expect(pkg.scripts["test:db"].split(" ")).toContain(path);
    expect(pkg.scripts["test:unit"]).toContain(`--exclude ${path}`);
  });
});
