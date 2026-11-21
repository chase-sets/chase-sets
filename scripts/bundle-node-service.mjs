import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { isBuiltin } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import ts from "@chase-sets/typescript-compiler-api";
import { acquireHeavySlot } from "./lib/heavy-slot.mjs";

const defaultRepoRoot = fileURLToPath(new URL("../", import.meta.url));
const services = new Set(["platform-api", "platform-worker"]);
const assetCopies = [
  {
    source: "bounded-contexts/platform-operations/features/support-requests/api/evidence-canonicalization.ts",
    reference: "./__fixtures__/evidence/",
    destination: "__fixtures__/evidence",
  },
  {
    source: "deployables/platform-api/src/main.ts",
    reference: "../../agent-apps/build/product-cards.html",
    destination: "product-cards.html",
    // Standalone API builds can run without the widget. Docker builds Agent Apps first.
    optional: true,
  },
];
const portable = (value) => value.replaceAll("\\", "/");

function relocateAssetReferences(contents, source, usedAssets) {
  const file = ts.createSourceFile(source, contents, ts.ScriptTarget.Latest, true);
  const replacements = [];
  function visit(node) {
    if (
      ts.isPropertyAccessExpression(node) &&
      node.name.text === "url" &&
      ts.isMetaProperty(node.expression) &&
      node.expression.keywordToken === ts.SyntaxKind.ImportKeyword &&
      node.expression.name.text === "meta"
    ) {
      const parent = node.parent;
      const literal =
        ts.isNewExpression(parent) &&
        ts.isIdentifier(parent.expression) &&
        parent.expression.text === "URL" &&
        parent.arguments?.[1] === node &&
        ts.isStringLiteral(parent.arguments[0])
          ? parent.arguments[0]
          : undefined;
      const copy = literal && assetCopies.find((copy) => copy.source === source && copy.reference === literal.text);
      if (!copy) {
        throw new Error(
          `Unlisted import.meta.url asset reference in ${source}:${file.getLineAndCharacterOfPosition(node.pos).line + 1}`,
        );
      }
      usedAssets.add(copy);
      const bundledReference = `./${copy.destination}${copy.reference.endsWith("/") ? "/" : ""}`;
      if (bundledReference !== literal.text) {
        replacements.push({ start: literal.getStart(file), end: literal.end, text: JSON.stringify(bundledReference) });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  for (const { start, end, text } of replacements.reverse()) {
    contents = contents.slice(0, start) + text + contents.slice(end);
  }
  return contents;
}

export async function bundleNodeService({ repoRoot = defaultRepoRoot, deployable }) {
  if (!services.has(deployable)) throw new Error(`Unknown Node service: ${deployable}`);
  const root = path.resolve(repoRoot);
  const service = path.join(root, "deployables", deployable);
  const outdir = path.join(service, "dist");
  // The closed service names above keep cleanup inside the selected service's dist.
  await rm(outdir, { recursive: true, force: true });
  const externals = [];
  const usedAssets = new Set();
  const result = await build({
    absWorkingDir: root,
    entryPoints: {
      "observability-prelude": path.join(service, "src/observability-prelude.ts"),
      service: path.join(service, "src/main.ts"),
    },
    outdir,
    bundle: true,
    splitting: true,
    format: "esm",
    platform: "node",
    target: "node24",
    conditions: ["node"],
    mainFields: ["main"],
    sourcemap: true,
    metafile: true,
    logLevel: "silent",
    plugins: [
      {
        name: "workspace-code-only",
        setup(bundler) {
          bundler.onResolve({ filter: /.*/ }, async (args) => {
            if (args.pluginData?.resolved || isBuiltin(args.path)) return;
            const resolved = await bundler.resolve(args.path, {
              resolveDir: args.resolveDir,
              kind: args.kind,
              importer: args.importer,
              pluginData: { resolved: true },
            });
            if (resolved.errors.length) return { errors: resolved.errors };
            if (!portable(resolved.path).includes("/node_modules/")) return resolved;
            const external = portable(path.relative(outdir, resolved.path));
            const specifier = external.startsWith(".") ? external : `./${external}`;
            externals.push({
              importer: args.importer,
              specifier: args.path,
              resolved: resolved.path,
              external: specifier,
            });
            return { path: specifier, external: true };
          });
          bundler.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, async (args) => {
            const source = portable(path.relative(root, args.path));
            const contents = await readFile(args.path, "utf8");
            const relocated = relocateAssetReferences(contents, source, usedAssets);
            if (relocated !== contents) {
              return {
                contents: relocated,
                loader: path.extname(args.path).replace(/^\.[cm]?/, ""),
                resolveDir: path.dirname(args.path),
              };
            }
          });
        },
      },
    ],
  });
  for (const copy of usedAssets) {
    const source = path.resolve(root, path.dirname(copy.source), copy.reference);
    const destination = path.join(outdir, copy.destination);
    await mkdir(path.dirname(destination), { recursive: true });
    try {
      await cp(source, destination, { recursive: true });
    } catch (error) {
      if (!copy.optional || error.code !== "ENOENT" || error.path !== source) throw error;
    }
  }
  // Static service imports must not run until the prelude has installed instrumentation.
  await writeFile(
    path.join(outdir, "main.js"),
    'import "./observability-prelude.js";\nawait import("./service.js");\n',
  );
  await writeFile(
    path.join(outdir, "metafile.json"),
    JSON.stringify({ ...result.metafile, externals }, null, 2) + "\n",
  );
  return { metafile: result.metafile, externals };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  acquireHeavySlot("build");
  await bundleNodeService({ deployable: process.argv[2] });
}
