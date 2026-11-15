import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { flattenAvailableMcpTools } from "@chase-sets/platform-runtime/mcp-contracts";
import ts from "@chase-sets/typescript-compiler-api";

function decode(node: ts.Node): unknown {
  if (ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) return decode(node.expression);
  if (ts.isStringLiteral(node) || ts.isNumericLiteral(node))
    return ts.isNumericLiteral(node) ? Number(node.text) : node.text;
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (node.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isArrayLiteralExpression(node)) return node.elements.map(decode);
  if (ts.isObjectLiteralExpression(node))
    return Object.fromEntries(
      node.properties.map((property) => {
        if (!ts.isPropertyAssignment(property)) throw new Error("Generated catalog must contain only data.");
        const name = property.name;
        if (!ts.isIdentifier(name) && !ts.isStringLiteral(name)) throw new Error("Unexpected catalog property.");
        return [name.text, decode(property.initializer)];
      }),
    );
  throw new Error("Generated catalog must contain only data.");
}

const root = new URL("../../../../../", import.meta.url);
describe("Listing MCP mirrors", () => {
  const names = [
    "marketplace.create-listing",
    "marketplace.update-listing-price",
    "marketplace.publish-listing",
    "marketplace.unpublish-listing",
  ];
  const registration = JSON.parse(
    readFileSync(new URL("docs/api/agent-connectors/native-mcp-registration.json", root), "utf8"),
  ) as { tools: { name: string; input_schema: unknown }[] };
  it.each(names)("requires and mirrors the full attempt contract for %s", (name) => {
    const source = flattenAvailableMcpTools().find((tool) => tool.name === name)!;
    expect(source.inputSchema.required).toEqual(expect.arrayContaining(["idempotencyKey", "requestHash"]));
    expect(registration.tools.find((tool) => tool.name === name)!.input_schema).toEqual(source.inputSchema);
    const stale = {
      ...source.inputSchema,
      required: source.inputSchema.required?.filter((key) => key !== "requestHash"),
    };
    expect(stale).not.toEqual(source.inputSchema);
  });
  it("keeps the public catalog's serialized Listing schemas equal to source", () => {
    const text = readFileSync(
      new URL("bounded-contexts/public-presence/features/developer-portal/domain/generated/mcp-tool-catalog.ts", root),
      "utf8",
    );
    const ast = ts.createSourceFile("catalog.ts", text, ts.ScriptTarget.Latest, true);
    const declaration = ast.statements
      .filter(ts.isVariableStatement)
      .flatMap((statement) => [...statement.declarationList.declarations])
      .find((node) => node.name.getText(ast) === "mcpToolCatalog")!;
    const catalog = decode(declaration.initializer!) as { name: string; inputSchema: unknown }[];
    for (const name of names) {
      const source = flattenAvailableMcpTools().find((tool) => tool.name === name)!;
      expect(catalog.find((tool) => tool.name === name)!.inputSchema).toEqual(source.inputSchema);
    }
  });
});
