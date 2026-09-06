import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "@chase-sets/typescript-compiler-api";

// These are the ratified lexical signatures, not a computed-colour evaluator.
export const lexicalLaw = {
  stops: ["start", "mid", "end"],
  properties: [
    "--chase-logo-start",
    "--chase-logo-mid",
    "--chase-logo-end",
    "--dark-chase-logo-start",
    "--dark-chase-logo-mid",
    "--dark-chase-logo-end",
  ],
  identifiers: ["chaseLogoStart", "chaseLogoMid", "chaseLogoEnd"],
  light: ["#8a682a", "#c9a44e", "#a87e2f"],
  dark: ["#b9863b", "#edd28d", "#d4a94e"],
  constructor: "--chase-logo-${stop}",
};
const property = (stop, dark = false) => `--${dark ? "dark-" : ""}chase-logo-${stop}`;
const identifier = (stop) => `chaseLogo${stop[0].toUpperCase()}${stop.slice(1)}`;
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const names = [...lexicalLaw.properties, ...lexicalLaw.identifiers];
const detectors = {
  literal: new RegExp(`(?<![\\w$-])(?:${names.map(escape).join("|")})(?![\\w$-])`, "g"),
  raw: new RegExp(
    `(?<![0-9a-f])(?:${[...lexicalLaw.light, ...lexicalLaw.dark].join("|")})(?:[0-9a-f]{2})?(?![0-9a-f])`,
    "gi",
  ),
  constructor: new RegExp(`(?<![\\w$-])${escape(lexicalLaw.constructor)}(?![\\w$-])`, "g"),
};

export function classifyBrandFoilContent(bytes) {
  // Latin-1 preserves every byte and its offset, including NUL and malformed UTF-8.
  const source = Buffer.isBuffer(bytes) ? bytes.toString("latin1") : bytes;
  return Object.entries(detectors)
    .flatMap(([detector, pattern]) =>
      [...source.matchAll(pattern)].map((match) => ({
        detector,
        start: match.index,
        end: match.index + match[0].length,
        value: match[0],
      })),
    )
    .sort((a, b) => a.start - b.start);
}

const compact = (text) => text.replace(/\s+/g, "");
const digest = (text) => createHash("sha256").update(compact(text)).digest("hex");
const ast = (source, kind = ts.ScriptKind.TSX) =>
  ts.createSourceFile("carrier.tsx", source, ts.ScriptTarget.Latest, true, kind);
function walk(node, visit) {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}
function ownerName(node) {
  if (ts.isVariableDeclaration(node)) return `variable:${node.name.getText()}`;
  if (ts.isInterfaceDeclaration(node)) return `interface:${node.name.text}`;
  if (ts.isFunctionDeclaration(node)) return `function:${node.name?.text ?? "anonymous"}`;
  if (ts.isArrowFunction(node)) return "callback";
  if (ts.isPropertyAssignment(node) || ts.isPropertySignature(node))
    return `property:${node.name.getText().replace(/^"|"$/g, "")}`;
  if (
    ts.isCallExpression(node) &&
    ["it", "test", "describe"].includes(node.expression.getText()) &&
    ts.isStringLiteral(node.arguments[0])
  ) {
    return `${node.expression.getText()}:${node.arguments[0].text}`;
  }
  if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
    const opening = ts.isJsxElement(node) ? node.openingElement : node;
    const id = opening.attributes.properties.find((attribute) => attribute.name?.getText() === "id");
    return `element:${opening.tagName.getText()}${id ? `:${id.initializer.getText()}` : ""}`;
  }
  return null;
}
// Fixed TypeScript 6.0.3 contracts: every ancestor and direct child edge is required.
// Unlisted kinds (including class/member scopes), edges and extra ancestors fail closed.
const syntax = (kind, edge, owner) => ({ kind: ts.SyntaxKind[kind], edge, owner });
const sourcePath = [syntax("SourceFile", null)];
const variablePath = (name, prefix = sourcePath) => [
  ...prefix,
  syntax("VariableStatement", "statements[]"),
  syntax("VariableDeclarationList", "declarationList"),
  syntax("VariableDeclaration", "declarations[]", `variable:${name}`),
];
const functionPath = (name) => [...sourcePath, syntax("FunctionDeclaration", "statements[]", `function:${name}`)];
const bodyPath = (name) => [...functionPath(name), syntax("Block", "body")];
const objectInitializer = syntax("ObjectLiteralExpression", "initializer");
const assignment = (name) => syntax("PropertyAssignment", "properties[]", `property:${name}`);
const element = (name, edge = "children[]") => syntax("JsxElement", edge, `element:${name}`);
const svgPath = [...sourcePath, syntax("ExpressionStatement", "statements[]"), element("svg", "expression")];
const gradientPath = (id) => [
  element("defs"),
  element(`linearGradient:${id}`),
  syntax("JsxSelfClosingElement", "children[]", "element:stop"),
];
const callbackPath = (callee, title) => [
  syntax("ExpressionStatement", "statements[]"),
  syntax("CallExpression", "expression", `${callee}:${title}`),
  syntax("ArrowFunction", "arguments[1]", "callback"),
  syntax("Block", "body"),
];
const expectationPath = (suite, title) => [
  ...sourcePath,
  ...callbackPath("describe", suite),
  ...callbackPath("it", title),
  syntax("ExpressionStatement", "statements[]"),
  syntax("CallExpression", "expression"),
];
export const brandFoilContainerPaths = {
  svgTemplate: [...variablePath("chaseSetsLogoSvg"), syntax("NoSubstitutionTemplateLiteral", "initializer")],
  svgStyle: [...svgPath, element("style")],
};
export function matchesBrandFoilAncestry(node, contract) {
  if (!Array.isArray(contract) || !contract.length) return false;
  let current = node;
  for (let index = contract.length - 1; index >= 0; index--) {
    const step = contract[index];
    if (!current || current.kind !== step.kind || (step.owner !== undefined && ownerName(current) !== step.owner))
      return false;
    if (index === 0) return step.edge === null && !current.parent;
    const parent = current.parent;
    if (!parent || typeof step.edge !== "string") return false;
    const list = /^(\w+)\[(\d*)\]$/.exec(step.edge);
    if (list) {
      const children = parent[list[1]];
      if (
        !Array.isArray(children) ||
        (list[2] === "" ? !children.includes(current) : children[Number(list[2])] !== current)
      )
        return false;
    } else if (parent[step.edge] !== current) return false;
    current = parent;
  }
  return false;
}

// Each rule admits one exact expression under one exact structural owner.
// Matching counts, as well as consuming occurrences once, detects stale and duplicate expressions.
function nodeRule(id, owner, text) {
  return { id, owner, text, count: 1 };
}
function nodeExpressions(source, rules, offset = 0, kind = ts.ScriptKind.TSX) {
  const tree = ast(source, kind);
  const nodes = [];
  walk(tree, (node) => nodes.push(node));
  return rules.map((rule) => ({
    ...rule,
    spans: nodes
      .filter(
        (node) => matchesBrandFoilAncestry(node, rule.owner) && compact(node.getText(tree)) === compact(rule.text),
      )
      // Parenthesized wrappers with the same text must not double-admit a leaf.
      .map((node) => [offset + node.getStart(tree), offset + node.end]),
  }));
}

// A bounded CSS block/declaration scanner: quoted strings and comments are atomic;
// braces identify the actual selector/at-rule owner, never a nearby line number.
function cssParts(source, offset = 0) {
  const parts = [];
  const stack = [];
  const tokens = /\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[{};]/g;
  let start = 0;
  for (const match of source.matchAll(tokens)) {
    const token = match[0];
    if (token.startsWith("/*")) {
      parts.push({
        owner: stack.join("/"),
        text: token,
        start: offset + match.index,
        end: offset + match.index + token.length,
      });
      if (!source.slice(start, match.index).trim()) start = match.index + token.length;
    } else if (token === "{") {
      stack.push(compact(source.slice(start, match.index)));
      start = match.index + 1;
    } else if (token === "}") {
      stack.pop();
      start = match.index + 1;
    } else if (token === ";") {
      const text = source.slice(start, match.index + 1);
      parts.push({ owner: stack.join("/"), text, start: offset + start, end: offset + match.index + 1 });
      start = match.index + 1;
    }
  }
  return parts;
}
function cssExpressions(source, rules, offset = 0) {
  const parts = cssParts(source, offset);
  return rules.map((rule) => ({
    ...rule,
    spans: parts
      .filter((part) => part.owner === compact(rule.owner) && compact(part.text) === compact(rule.text))
      .map((part) => [part.start, part.end]),
  }));
}
const lightSelector =
  ':root,[data-theme="light"],body:has([data-theme-choice="light"]:checked),[data-chase-theme][data-color-mode="light"],[data-chase-theme-scope][data-color-mode="light"]';
const darkSelector =
  '[data-theme="dark"],body:has([data-theme-choice="dark"]:checked),[data-chase-theme][data-color-mode="dark"],[data-chase-theme-scope][data-color-mode="dark"]';
function styleExpressions(source) {
  return cssExpressions(
    source,
    lexicalLaw.stops.flatMap((stop, index) => [
      nodeRule(`light.${stop}`, `@layer base/${lightSelector}`, `${property(stop)}: ${lexicalLaw.light[index]};`),
      nodeRule(`dark.${stop}`, "@layer base/:root", `${property(stop, true)}: ${lexicalLaw.dark[index]};`),
      ...[darkSelector, '@media (prefers-color-scheme: dark)/:root:not([data-theme="light"])'].map((selector, alias) =>
        nodeRule(
          `alias.${alias}.${stop}`,
          `@layer base/${selector}`,
          `${property(stop)}: var(${property(stop, true)});`,
        ),
      ),
    ]),
  );
}
function tokenExpressions(source) {
  return nodeExpressions(
    source,
    lexicalLaw.stops.flatMap((stop) => [
      nodeRule(
        `field.${stop}`,
        [
          ...sourcePath,
          syntax("InterfaceDeclaration", "statements[]", "interface:ThemeTokens"),
          syntax("PropertySignature", "members[]", "property:colors"),
          syntax("TypeLiteral", "type"),
          syntax("PropertySignature", "members[]", `property:${identifier(stop)}`),
        ],
        `${identifier(stop)}: string;`,
      ),
      nodeRule(
        `value.${stop}`,
        [
          ...variablePath("chaseTheme"),
          objectInitializer,
          assignment("colors"),
          objectInitializer,
          assignment(identifier(stop)),
        ],
        `${identifier(stop)}: "var(${property(stop)})"`,
      ),
      nodeRule(
        `map.${stop}`,
        [
          ...variablePath("tokenMap"),
          syntax("ArrayLiteralExpression", "initializer"),
          syntax("ArrayLiteralExpression", "elements[]"),
        ],
        `["${property(stop)}", (t) => t.colors?.${identifier(stop)}]`,
      ),
    ]),
  );
}
function fixtureExpressions(source) {
  return nodeExpressions(
    source,
    ["light", "dark"].flatMap((mode) =>
      lexicalLaw.stops.flatMap((stop, index) => [
        nodeRule(
          `${mode}.${stop}.key`,
          [
            ...sourcePath,
            syntax("ExpressionStatement", "statements[]"),
            syntax("ObjectLiteralExpression", "expression"),
            assignment(mode),
            objectInitializer,
            assignment(property(stop)),
            syntax("StringLiteral", "name"),
          ],
          JSON.stringify(property(stop)),
        ),
        nodeRule(
          `${mode}.${stop}.candidate`,
          [
            ...sourcePath,
            syntax("ExpressionStatement", "statements[]"),
            syntax("ObjectLiteralExpression", "expression"),
            assignment(mode),
            objectInitializer,
            assignment(property(stop)),
            objectInitializer,
            assignment("candidate"),
          ],
          `"candidate": "${lexicalLaw[mode][index]}"`,
        ),
      ]),
    ),
    0,
    ts.ScriptKind.JSON,
  );
}
function svgExpressions(source, offset = 0) {
  const expressions = [];
  // Preserve the element hierarchy while hiding CSS from the existing TSX parser.
  const xml = source
    .replace(/<\?xml[\s\S]*?\?>/, (text) => " ".repeat(text.length))
    .replace(/<style>([\s\S]*?)<\/style>/g, (_text, css) => `<style>${" ".repeat(css.length)}</style>`);
  const tree = ast(xml);
  const styleStarts = [];
  walk(tree, (node) => {
    if (matchesBrandFoilAncestry(node, brandFoilContainerPaths.svgStyle)) styleStarts.push(node.getStart(tree));
  });
  const styles = [...source.matchAll(/<style>([\s\S]*?)<\/style>/g)].filter((match) =>
    styleStarts.includes(match.index),
  );
  const comment = `/* brand foil: the design-system presentation term for the gold gradient
       carried by ${property("start")}/mid/end. Distinct from "holofoil", the
       catalog finish option key owned by bounded-contexts/catalog/GLOSSARY.md. */`;
  for (const style of styles) {
    const start = offset + style.index + "<style>".length;
    expressions.push(
      ...cssExpressions(
        style[1],
        [
          nodeRule("brand-law", "", comment),
          ...lexicalLaw.stops.flatMap((stop, index) => [
            nodeRule(`root.light.${stop}`, ":root", `${property(stop)}: ${lexicalLaw.light[index]};`),
            nodeRule(
              `root.dark.${stop}`,
              "@media (prefers-color-scheme: dark)/:root",
              `${property(stop)}: ${lexicalLaw.dark[index]};`,
            ),
          ]),
        ],
        start,
      ),
    );
  }
  expressions.push(
    ...nodeExpressions(
      xml,
      lexicalLaw.stops.map((stop, index) =>
        nodeRule(
          `gradient.${stop}`,
          [...svgPath, ...gradientPath('"logoGradient"')],
          `<stop offset="${["0", "0.52", "1"][index]}" stop-color="var(${property(stop)})"/>`,
        ),
      ),
      offset,
    ),
  );
  if (styles.length !== 1) expressions.push({ id: "svg.style", count: 1, spans: [] });
  return expressions;
}
function logoExpressions(source) {
  const tree = ast(source);
  const expressions = [];
  walk(tree, (node) => {
    if (
      matchesBrandFoilAncestry(node, brandFoilContainerPaths.svgTemplate) &&
      node.parent.parent.parent.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
    ) {
      expressions.push(...svgExpressions(source.slice(node.getStart(tree) + 1, node.end - 1), node.getStart(tree) + 1));
    }
  });
  if (!expressions.length) expressions.push({ id: "chaseSetsLogoSvg", count: 1, spans: [] });
  expressions.push(
    ...nodeExpressions(
      source,
      lexicalLaw.stops.flatMap((stop, index) => [
        ...["light", "dark"].map((mode) =>
          nodeRule(
            `palette.${mode}.${stop}`,
            [...variablePath(`${mode}Palette`, bodyPath("ChaseSetsLogo")), objectInitializer, assignment(stop)],
            `${stop}: "${lexicalLaw[mode][index]}"`,
          ),
        ),
        nodeRule(
          `component.${stop}`,
          [
            ...bodyPath("ChaseSetsLogo"),
            syntax("ReturnStatement", "statements[]"),
            syntax("ParenthesizedExpression", "expression"),
            element("svg", "expression"),
            ...gradientPath("{gradientId}"),
          ],
          `<stop offset="${["0", "0.52", "1"][index]}" stopColor={colorMode === "auto" ? "var(${property(stop)}, ${lexicalLaw.light[index]})" : forcedPalette.${stop}} />`,
        ),
      ]),
    ),
  );
  return expressions;
}
function iconExpressions(source) {
  return nodeExpressions(source, [
    nodeRule(
      "foil.map",
      variablePath("foil"),
      `foil = Object.fromEntries(["start", "mid", "end"].map((stop) => {
        const entry = fixture.light[\`${lexicalLaw.constructor}\`];
        if (!entry || typeof entry.candidate !== "string") {
          throw new Error(\`fixture light ${lexicalLaw.constructor} candidate missing at \${fixturePath}\`);
        }
        return [stop, entry.candidate];
      }),)`,
    ),
  ]);
}
function ogExpressions(source) {
  return nodeExpressions(
    source,
    lexicalLaw.stops.map((stop, index) =>
      nodeRule(
        `palette.${stop}`,
        [...variablePath("palette"), objectInitializer, assignment(`gradient${stop[0].toUpperCase()}${stop.slice(1)}`)],
        `gradient${stop[0].toUpperCase()}${stop.slice(1)}: "${lexicalLaw.dark[index]}"`,
      ),
    ),
  );
}
function componentTestExpressions(source) {
  const owner = expectationPath("design system components", "renders the Chase Sets logo and uses it in seller badges");
  return nodeExpressions(source, [
    nodeRule("svg.expectation", owner, `expect(chaseSetsLogoSvg).toContain("${lexicalLaw.light[1]}")`),
    nodeRule(
      "component.expectation",
      owner,
      `expect(logoMarkup).toContain("var(${property("mid")}, ${lexicalLaw.light[1]})")`,
    ),
  ]);
}
const nameArray = () => `[${lexicalLaw.stops.map((stop) => JSON.stringify(property(stop))).join(", ")}]`;
function evidenceExpressions(source) {
  return nodeExpressions(source, [
    nodeRule(
      "foilCandidates.return",
      [...bodyPath("foilCandidates"), syntax("ReturnStatement", "statements[]")],
      `return ${nameArray()}.map((name) => hexToRgbString(fixture[mode][name]!.candidate),);`,
    ),
  ]);
}
function representationExpressions(source) {
  const owner = expectationPath(
    "raster generator literal parity",
    "holds the OG generator to the fixture's dark foil candidates and its four palette literals to their shipped bytes",
  );
  return nodeExpressions(source, [
    ...["light", "dark"].map((mode) =>
      nodeRule(
        `${mode}CandidateStops`,
        [...variablePath(`${mode}CandidateStops`), syntax("CallExpression", "initializer")],
        `${nameArray()}.map((name) => fixture.${mode}[name].candidate,)`,
      ),
    ),
    ...lexicalLaw.stops.map((stop) =>
      nodeRule(
        `parity.${stop}`,
        owner,
        `expect(literal("gradient${stop[0].toUpperCase()}${stop.slice(1)}")).toBe(fixture.dark["${property(stop)}"].candidate)`,
      ),
    ),
  ]);
}
function documentationExpressions(source) {
  const paragraph = `"Brand foil" is the visual-identity term for the gold gradient carried by the ${lexicalLaw.stops.map((stop) => `\`${property(stop)}\``).join("/")} tokens (exposed through \`ThemeTokens\` as ${lexicalLaw.stops.map((stop) => `\`${identifier(stop)}\``).join("/")}). It is deliberately distinct from \`holofoil\`, the catalog finish value owned by the Catalog context (\`bounded-contexts/catalog/GLOSSARY.md\`, the \`holofoil\` option key under Provider Option Value Synonym). Design-system docs and code use "brand foil" only for the identity gradient and never for card finishes; catalog finish vocabulary stays in the Catalog glossary.`;
  const spans = [];
  for (const match of source.matchAll(/^### Brand foil vs holofoil\r?\n\r?\n([^\r\n]+)/gm)) {
    if (match[1] === paragraph)
      spans.push([match.index + match[0].length - match[1].length, match.index + match[0].length]);
  }
  return [{ id: "brand-foil-paragraph", count: 1, spans }];
}

function proofExpressions(source) {
  const tree = ast(source);
  const spans = [];
  for (const statement of tree.statements) {
    if (!ts.isVariableStatement(statement) || !(statement.declarationList.flags & ts.NodeFlags.Const)) continue;
    for (const node of statement.declarationList.declarations) {
      if (
        node.name.getText(tree) === "aggregateFixture" &&
        node.initializer &&
        ts.isStringLiteral(node.initializer) &&
        node.initializer.text === `${lexicalLaw.light[0].toUpperCase()}80`
      )
        spans.push([node.initializer.getStart(tree), node.initializer.end]);
    }
  }
  return [{ id: "aggregateFixture", count: 1, spans }];
}

// Candidate-bound definition fingerprints cover only named AST declarations.
// They never exempt a file, its other declarations, comments, or executable samples.
const definitionContracts = {
  validator: [["variable:lexicalLaw", "3894e8d558441567a2b555dbc2c3421c3e47d708c3386c7f6934c41138a805c5"]],
  tests: [
    ["function:lexicalCases", "a17b68e2a414787145c3c5c2f1a8a3d741b73e4d374a884cfc4bb44310345296"],
    ["function:misplacedUses", "a9bda6f89aa2ccf5e3e1d767d8d47d2303a2b01a641a8b2a9b0b5e18e1373a7e"],
  ],
};
const definitionPaths = {
  "variable:lexicalLaw": variablePath("lexicalLaw"),
  "function:lexicalCases": functionPath("lexicalCases"),
  "function:misplacedUses": functionPath("misplacedUses"),
};
function definitionExpressions(source, contracts) {
  const tree = ast(source);
  const nodes = [];
  walk(tree, (node) => nodes.push(node));
  return contracts.map(([owner, expectedDigest]) => ({
    id: owner,
    count: 1,
    spans: nodes
      .filter(
        (node) =>
          matchesBrandFoilAncestry(node, definitionPaths[owner]) && digest(node.getText(tree)) === expectedDigest,
      )
      .map((node) => [node.getStart(tree), node.end]),
  }));
}

export const brandFoilRegistry = [
  {
    path: "packages/design-system/src/styles/styles.css",
    role: "value-authority",
    counts: [18, 6, 0],
    validate: styleExpressions,
  },
  {
    path: "packages/design-system/src/theme/tokens.ts",
    role: "value-authority",
    counts: [15, 0, 0],
    validate: tokenExpressions,
  },
  {
    path: "packages/design-system/src/theme/__fixtures__/ink-foil-candidate-tokens.json",
    role: "value-authority",
    counts: [6, 6, 0],
    validate: fixtureExpressions,
  },
  {
    path: "packages/design-system/src/brand/chase-sets-logo.tsx",
    role: "wordmark",
    counts: [13, 15, 0],
    validate: logoExpressions,
  },
  {
    path: "packages/design-system/src/brand/chase-sets-logo.svg",
    role: "wordmark",
    counts: [10, 6, 0],
    validate: svgExpressions,
  },
  {
    path: "scripts/generate-brand-icons.mjs",
    role: "wordmark-raster-generator",
    counts: [0, 0, 2],
    validate: iconExpressions,
  },
  {
    path: "bounded-contexts/public-presence/features/waitlist/ui/assets/generate-og-images.mjs",
    role: "wordmark-raster-generator",
    counts: [0, 3, 0],
    validate: ogExpressions,
  },
  {
    path: "packages/design-system/src/__tests__/design-system-components.test.tsx",
    role: "verification",
    counts: [1, 2, 0],
    validate: componentTestExpressions,
  },
  {
    path: "deployables/marketplace/e2e/ink-foil-visual-identity.evidence.spec.ts",
    role: "verification",
    counts: [3, 0, 0],
    validate: evidenceExpressions,
  },
  {
    path: "scripts/check-structure/brand-mark-representations.test.mjs",
    role: "verification",
    counts: [9, 0, 0],
    validate: representationExpressions,
  },
  {
    path: "packages/design-system/README.md",
    role: "documentation",
    counts: [6, 0, 0],
    validate: documentationExpressions,
  },
  {
    path: "scripts/check-structure/brand-foil-sites.mjs",
    role: "detector-definition",
    counts: [9, 6, 1],
    validate: (source) => definitionExpressions(source, definitionContracts.validator),
  },
  {
    path: "scripts/check-structure/brand-foil-sites.test.mjs",
    role: "detector-definition",
    counts: [13, 11, 2],
    validate: (source) => definitionExpressions(source, definitionContracts.tests),
  },
  {
    path: "scripts/check-structure/brand-foil-proof.mjs",
    role: "verification",
    counts: [0, 1, 0],
    validate: proofExpressions,
  },
];

const recognizedIndexModes = new Set(["100644", "100755", "120000"]);
function nulRecords(bytes, label) {
  const records = [];
  let start = 0;
  for (let end = 0; end < bytes.length; end++) {
    if (bytes[end] !== 0) continue;
    if (end === start) throw new Error(`${label}: empty record`);
    records.push(bytes.subarray(start, end));
    start = end + 1;
  }
  if (start !== bytes.length) throw new Error(`${label}: unterminated record`);
  return records;
}

export function reconcileIndexedPathRecords(enumerated, staged) {
  const paths = nulRecords(enumerated, "Git enumeration");
  const enumeratedByBytes = new Map();
  for (const pathBytes of paths) {
    const key = pathBytes.toString("hex");
    if (enumeratedByBytes.has(key)) throw new Error("Git enumeration: duplicate path");
    enumeratedByBytes.set(key, pathBytes);
  }

  const stagedByBytes = new Map();
  for (const record of nulRecords(staged, "Git stage records")) {
    const tab = record.indexOf(9);
    if (tab <= 0 || tab === record.length - 1) throw new Error("Git stage records: malformed record");
    const header = record.subarray(0, tab).toString("ascii");
    const match = /^([0-7]{6}) ([0-9a-f]{40}|[0-9a-f]{64}) ([0-3])$/.exec(header);
    if (!match) throw new Error("Git stage records: malformed header");
    const pathBytes = record.subarray(tab + 1);
    const key = pathBytes.toString("hex");
    if (!enumeratedByBytes.has(key)) throw new Error("Git stage records: path missing from enumeration");
    if (stagedByBytes.has(key)) throw new Error("Git stage records: duplicate or multiple stages");
    const [, mode, oid, stage] = match;
    if (stage !== "0") throw new Error("Git stage records: nonzero stage");
    if (!recognizedIndexModes.has(mode)) throw new Error(`Git stage records: unknown mode ${mode}`);
    stagedByBytes.set(key, { pathBytes: enumeratedByBytes.get(key), mode, oid, stage: 0 });
  }

  return paths.map((pathBytes) => {
    const entry = stagedByBytes.get(pathBytes.toString("hex"));
    if (!entry) throw new Error("Git stage records: enumerated path has no stage-0 entry");
    return entry;
  });
}

function indexedPathEntries(repoRoot) {
  const options = {
    cwd: repoRoot,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  };
  return {
    entries: reconcileIndexedPathRecords(
    execFileSync("git", ["ls-files", "-z"], options),
    execFileSync("git", ["ls-files", "--stage", "-z"], options),
    ),
    options,
  };
}

function readIndexedPath(repoRoot, entry, options) {
  const worktreePath = Buffer.concat([Buffer.from(path.resolve(repoRoot) + path.sep), entry.pathBytes]);
  if (entry.mode === "100644" || entry.mode === "100755") return readFileSync(worktreePath);

  lstatSync(worktreePath);
  const bytes = execFileSync("git", ["cat-file", "blob", entry.oid], options);
  const algorithm = entry.oid.length === 40 ? "sha1" : "sha256";
  const actualOid = createHash(algorithm)
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest("hex");
  if (actualOid !== entry.oid) throw new Error(`Git object mismatch for ${entry.oid}`);
  return bytes;
}

export function discoverBrandFoilSites(repoRoot) {
  const result = { tracked: 0, scanned: 0, bytes: 0, nul: 0, readFailures: [], carriers: [] };
  let entries;
  let options;
  try {
    ({ entries, options } = indexedPathEntries(repoRoot));
  } catch (error) {
    result.readFailures.push(`Git index: ${error.message}`);
    return result;
  }
  result.tracked = entries.length;
  for (const entry of entries) {
    const { pathBytes } = entry;
    const relativePath = pathBytes.toString("utf8");
    try {
      const bytes = readIndexedPath(repoRoot, entry, options);
      result.scanned++;
      result.bytes += bytes.length;
      if (bytes.includes(0)) result.nul++;
      const occurrences = classifyBrandFoilContent(bytes);
      if (occurrences.length)
        result.carriers.push({ path: relativePath, source: bytes.toString("latin1"), occurrences });
    } catch (error) {
      result.readFailures.push(`${relativePath}: ${error.code ?? error.message}`);
    }
  }
  return result;
}

export function validateBrandFoilDiscovery(discovery, registry = brandFoilRegistry) {
  const violations = discovery.readFailures.map((failure) => `brand foil read failure: ${failure}`);
  const inventory = [];
  const carrierPaths = new Set(discovery.carriers.map((carrier) => carrier.path));
  for (const entry of registry) {
    if (!carrierPaths.has(entry.path))
      violations.push(`${entry.path}: role=${entry.role} expression=registry stale or missing carrier`);
  }
  for (const carrier of discovery.carriers) {
    const entries = registry.filter((entry) => entry.path === carrier.path);
    const entry = entries[0];
    const errors = [];
    let expressions = [];
    if (entries.length !== 1) errors.push(`expression=registry expected one role, found ${entries.length}`);
    else {
      const canonicalRole = brandFoilRegistry.find((row) => row.path === carrier.path)?.role;
      if (entry.role !== canonicalRole) errors.push(`expression=role expected=${canonicalRole} actual=${entry.role}`);
      try {
        expressions = entry.validate(carrier.source);
      } catch (error) {
        errors.push(`expression=parser ${error.message}`);
      }
      for (const expression of expressions) {
        if (expression.spans.length !== expression.count)
          errors.push(`expression=${expression.id} expected=${expression.count} actual=${expression.spans.length}`);
      }
      for (const occurrence of carrier.occurrences) {
        const consumers = expressions.filter((expression) =>
          expression.spans.some(([start, end]) => occurrence.start >= start && occurrence.end <= end),
        );
        if (consumers.length !== 1)
          errors.push(
            `expression=${consumers.map((expression) => expression.id).join(",") || "unmatched"} detector=${occurrence.detector} byte=${occurrence.start} consumers=${consumers.length}`,
          );
      }
      const counts = Object.keys(detectors).map(
        (detector) => carrier.occurrences.filter((hit) => hit.detector === detector).length,
      );
      if (counts.some((count, index) => count !== entry.counts[index]))
        errors.push(`expression=cardinality expected=${entry.counts} actual=${counts}`);
    }
    const detectorKinds = [...new Set(carrier.occurrences.map((hit) => hit.detector))];
    violations.push(
      ...errors.map(
        (error) =>
          `${carrier.path}: role=${entry?.role ?? "unregistered"} detectors=${detectorKinds.join(",")} ${error}`,
      ),
    );
    inventory.push({
      path: carrier.path,
      role: entry?.role ?? "unregistered",
      allowed: errors.length === 0,
      detectors: detectorKinds,
      expressions: expressions.map(({ id, spans }) => ({
        id,
        occurrences: carrier.occurrences.filter((hit) =>
          spans.some(([start, end]) => hit.start >= start && hit.end <= end),
        ).length,
      })),
    });
  }
  const counts = Object.fromEntries(
    Object.keys(detectors).map((detector) => [
      detector,
      inventory.filter((row) => row.detectors.includes(detector)).length,
    ]),
  );
  const allowed = inventory.filter((row) => row.allowed).length;
  const summary = {
    tracked: discovery.tracked,
    scanned: discovery.scanned,
    bytes: discovery.bytes,
    readFailures: discovery.readFailures.length,
    nul: discovery.nul,
    ...counts,
    token: inventory.filter((row) => row.detectors.includes("literal") || row.detectors.includes("constructor")).length,
    union: inventory.length,
    allowed,
    violations: inventory.length - allowed,
    roles: Object.fromEntries(
      [...new Set(registry.map((entry) => entry.role))].map((role) => [
        role,
        inventory.filter((row) => row.role === role).length,
      ]),
    ),
  };
  return { ok: violations.length === 0, violations, inventory, summary };
}

export function validateBrandFoilSites({ repoRoot, registry = brandFoilRegistry, log = console.log } = {}) {
  const result = validateBrandFoilDiscovery(discoverBrandFoilSites(repoRoot), registry);
  log(
    `Brand foil: ${JSON.stringify(result.summary)}; allowed + violations = union: ${result.summary.allowed} + ${result.summary.violations} = ${result.summary.union}`,
  );
  return result;
}
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const result = validateBrandFoilSites({ repoRoot: process.cwd() });
  for (const violation of result.violations) console.error(violation);
  process.exitCode = result.ok ? 0 : 1;
}
