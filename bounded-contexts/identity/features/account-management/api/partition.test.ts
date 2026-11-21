import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "@chase-sets/typescript-compiler-api";
import { describe, expect, it } from "vitest";
import { actionFields, actionTargetField, routeActions } from "../domain/contract";
import manifest from "../../../context.json";

const root = path.resolve(import.meta.dirname, "../../..");
const pages = {
  "/account": "accounts/ui/account-profile-page.tsx",
  "/account/shipping-addresses": "shipping-addresses/ui/shipping-address-page.tsx",
  "/account/consents": "consents/ui/consent-history-page.tsx",
  "/account/security": "api-keys/ui/account-security-page.tsx",
  "/account/team": "memberships/ui/account-team-page.tsx",
} as const;

function parse(file: string, source = readFileSync(file, "utf8")) {
  return ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}
function importsAccountMutationForm(file: ts.SourceFile) {
  return file.statements.some((statement) => {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== "../../account-management/ui/controller"
    )
      return false;
    const clause = statement.importClause;
    return (
      clause !== undefined &&
      !clause.isTypeOnly &&
      clause.namedBindings !== undefined &&
      ts.isNamedImports(clause.namedBindings) &&
      clause.namedBindings.elements.some(
        (binding) =>
          !binding.isTypeOnly && binding.propertyName?.text === "AccountMutationForm" && binding.name.text === "Form",
      )
    );
  });
}
function routeIntents(file: ts.SourceFile) {
  const intents: string[] = [];
  function visit(node: ts.Node) {
    if (
      ts.isPropertyAssignment(node) &&
      node.name.getText(file) === "intents" &&
      ts.isObjectLiteralExpression(node.initializer)
    ) {
      for (const property of node.initializer.properties)
        if (property.name && (ts.isStringLiteral(property.name) || ts.isIdentifier(property.name)))
          intents.push(property.name.text);
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return intents.sort();
}
function formPartition(file: ts.SourceFile) {
  const forms: { intents: string[]; fields: string[] }[] = [];
  function attribute(node: ts.JsxOpeningElement | ts.JsxSelfClosingElement, name: string) {
    const value = node.attributes.properties.find(
      (attribute) => ts.isJsxAttribute(attribute) && attribute.name.getText(file) === name,
    );
    return value && ts.isJsxAttribute(value) && value.initializer && ts.isStringLiteral(value.initializer)
      ? value.initializer.text
      : null;
  }
  function visit(node: ts.Node) {
    if (ts.isJsxElement(node) && ["form", "Form", "RouterForm"].includes(node.openingElement.tagName.getText(file))) {
      if (node.openingElement.tagName.getText(file) !== "Form") throw new Error("uncontrolled-form");
      const fields: string[] = [];
      const intents: string[] = [];
      function controls(child: ts.Node) {
        if (ts.isJsxSelfClosingElement(child) || ts.isJsxOpeningElement(child)) {
          const name = attribute(child, "name");
          if (name) fields.push(name);
          const value = attribute(child, "value");
          if (name === "intent" && value) intents.push(value);
        }
        ts.forEachChild(child, controls);
      }
      controls(node);
      forms.push({ fields, intents });
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return forms;
}

describe("issue-7168-ac1-derived-partition", () => {
  it("reconciles all 15 real route/form/client/manifest actions and refuses source drift mutants", () => {
    const derived: string[] = [];
    for (const [route, actions] of Object.entries(routeActions)) {
      const slug = route === "/account" ? "account" : `account-${route.split("/").at(-1)}`;
      const file = parse(path.join(root, `routes/marketplace/${slug}.tsx`));
      expect(routeIntents(file)).toEqual([...actions].sort());
      derived.push(...routeIntents(file));
      const source = readFileSync(path.join(root, `features/${pages[route as keyof typeof pages]}`), "utf8");
      const page = parse("page.tsx", source);
      expect(importsAccountMutationForm(page), route).toBe(true);
      const forms = formPartition(page);
      expect(forms.flatMap((form) => form.intents).sort()).toEqual([...actions].sort());
      for (const form of forms) {
        const action = form.intents[0] as keyof typeof actionFields;
        const allowed: readonly string[] = [
          "intent",
          ...actionFields[action],
          ...(actionTargetField[action] ? [actionTargetField[action]] : []),
          ...(action === "create-api-key" ? ["purpose"] : []),
        ];
        expect(form.fields.every((field) => allowed.includes(field))).toBe(true);
      }
      expect(() =>
        formPartition(parse("mutant.tsx", source.replace("<Form ", "<form ").replace("</Form>", "</form>"))),
      ).toThrow("uncontrolled-form");
    }
    expect(derived.sort()).toEqual(Object.keys(actionFields).sort());
    expect(derived).toHaveLength(15);
    const client = readFileSync(path.join(root, "support/shell-support/api/client.ts"), "utf8");
    expect((client.match(/return ownerResponse<T>/g) ?? []).length).toBe(15);
    expect(manifest.slices).toContain("account-management");
    const mutant = parse("mutant.tsx", 'const x = { intents: { "sixteenth": () => 1 } };');
    expect(routeIntents(mutant).every((action) => Object.hasOwn(actionFields, action))).toBe(false);
  });

  it("rejects type-only or substitute Form imports", () => {
    for (const source of [
      'import type { AccountMutationForm as Form } from "../../account-management/ui/controller";',
      'import { type AccountMutationForm as Form } from "../../account-management/ui/controller";',
      'import { AccountMutationForm as Form } from "./substitute";',
      'import { OtherForm as Form } from "../../account-management/ui/controller";',
    ]) {
      expect(importsAccountMutationForm(parse("mutant.tsx", source)), source).toBe(false);
    }
  });
});
