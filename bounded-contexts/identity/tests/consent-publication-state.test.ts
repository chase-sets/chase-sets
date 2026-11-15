import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "@chase-sets/typescript-compiler-api";
import { describe, expect, it } from "vitest";

/**
 * The compiled publication state Consent activation reads.
 *
 * No policy is consent-activatable yet, so no Consent Bundle member can become a
 * requirement. The state is read from every generated `*-publication.ts` record
 * by policy key and literal boolean, never from text matches, so a missing,
 * extra, or activatable record each fails by name.
 */

const generatedDirectory = path.resolve(import.meta.dirname, "../../../contracts/public-docs/generated");

const nonActivatablePolicies = [
  "agent-connector-terms",
  "authenticity-service-terms",
  "founders-offer-terms",
  "payments-terms",
  "privacy-policy",
  "seller-agreement",
  "terms-of-service",
];

type PublicationRecordFact = Readonly<{
  file: string;
  policyKey: string | undefined;
  consentActivatable: boolean | undefined;
}>;

function readGeneratedPublicationSources(directory: string) {
  return new Map<string, string>(
    readdirSync(directory)
      .filter((name) => name.endsWith("-publication.ts"))
      .sort()
      .map((name): [string, string] => [name, readFileSync(path.join(directory, name), "utf8")]),
  );
}

function unwrap(node: ts.Expression): ts.Expression {
  return ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isParenthesizedExpression(node)
    ? unwrap(node.expression)
    : node;
}

// A publication record is an exported constant checked against PublicPolicyPublicationRecord.
function readPublicationRecords(sources: ReadonlyMap<string, string>): PublicationRecordFact[] {
  return [...sources].flatMap(([file, text]) => {
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    return source.statements.filter(ts.isVariableStatement).flatMap((statement) =>
      statement.declarationList.declarations.flatMap((declaration) => {
        const initializer = declaration.initializer;
        if (
          !initializer ||
          !ts.isSatisfiesExpression(initializer) ||
          !/^PublicPolicyPublicationRecord\b/.test(initializer.type.getText(source))
        ) {
          return [];
        }
        const record = unwrap(initializer);
        const member = (name: string) => {
          const found = ts.isObjectLiteralExpression(record)
            ? record.properties.find((property) => property.name?.getText(source) === name)
            : undefined;
          return found && ts.isPropertyAssignment(found) ? found.initializer : undefined;
        };
        const policyKey = member("policyKey");
        const consentActivatable = member("consentActivatable")?.kind;
        return [
          {
            file,
            policyKey: policyKey && ts.isStringLiteral(policyKey) ? policyKey.text : undefined,
            consentActivatable:
              consentActivatable === ts.SyntaxKind.TrueKeyword
                ? true
                : consentActivatable === ts.SyntaxKind.FalseKeyword
                  ? false
                  : undefined,
          },
        ];
      }),
    );
  });
}

function collectPublicationStateViolations(records: readonly PublicationRecordFact[]) {
  const violations: string[] = [];
  for (const { file, policyKey, consentActivatable } of records) {
    if (!policyKey) violations.push(`${file}: publication record has no literal policyKey`);
    else if (!nonActivatablePolicies.includes(policyKey))
      violations.push(`${policyKey}: unexpected publication record`);
    if (consentActivatable !== false) {
      violations.push(`${policyKey ?? file}: consentActivatable must be the literal false`);
    }
  }
  for (const policyKey of nonActivatablePolicies) {
    const found = records.filter((record) => record.policyKey === policyKey).length;
    if (found !== 1) violations.push(`${policyKey}: expected one publication record, found ${found}`);
  }
  return violations;
}

describe("Consent publication state", () => {
  const sources = readGeneratedPublicationSources(generatedDirectory);

  it("compiles exactly the seven named policies, each non-activatable", () => {
    const records = readPublicationRecords(sources);

    expect(records.map(({ policyKey, consentActivatable }) => [policyKey, consentActivatable])).toEqual(
      nonActivatablePolicies.map((policyKey) => [policyKey, false]),
    );
    expect(collectPublicationStateViolations(records)).toEqual([]);
  });

  // Synthetic in-memory controls; the generated files are never edited.
  it("fails a missing, extra, activatable, or non-literal record by name", () => {
    const violationsWith = (edit: (draft: Map<string, string>) => void) => {
      const draft = new Map(sources);
      edit(draft);
      return collectPublicationStateViolations(readPublicationRecords(draft));
    };
    const replaceIn = (draft: Map<string, string>, file: string, from: string, to: string) => {
      const text = draft.get(file) ?? "";
      expect(text.split(from), `${from} must occur once in ${file}`).toHaveLength(2);
      draft.set(file, text.replace(from, to));
    };

    expect(violationsWith((draft) => draft.delete("privacy-policy-publication.ts"))).toEqual([
      "privacy-policy: expected one publication record, found 0",
    ]);
    expect(
      violationsWith((draft) =>
        draft.set(
          "synthetic-eighth-policy-publication.ts",
          'export const record = { policyKey: "synthetic-eighth-policy", consentActivatable: false } as const satisfies PublicPolicyPublicationRecord<"synthetic-eighth-policy">;\n',
        ),
      ),
    ).toEqual(["synthetic-eighth-policy: unexpected publication record"]);
    expect(
      violationsWith((draft) =>
        replaceIn(draft, "terms-of-service-publication.ts", "consentActivatable: false", "consentActivatable: true"),
      ),
    ).toEqual(["terms-of-service: consentActivatable must be the literal false"]);
    expect(
      violationsWith((draft) =>
        replaceIn(draft, "seller-agreement-publication.ts", "consentActivatable: false", "consentActivatable: !true"),
      ),
    ).toEqual(["seller-agreement: consentActivatable must be the literal false"]);
  });

  it("fails closed when the generated publication directory cannot be read", () => {
    expect(() => readGeneratedPublicationSources(path.join(generatedDirectory, "synthetic-missing"))).toThrow(/ENOENT/);
  });
});
