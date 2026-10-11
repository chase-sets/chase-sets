import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "@chase-sets/typescript-compiler-api";

/** In-memory bypass only; exact anchors fail loudly if the candidate control moves. */
export function loadMutant<T>(
  sourceUrl: URL,
  anchor: string,
  replacement: string,
  bindings: Readonly<Record<string, unknown>>,
): T {
  const source = readFileSync(sourceUrl, "utf8");
  if (source.split(anchor).length !== 2) throw new Error(`live-export-snapshot-mutant-anchor-moved: ${anchor}`);
  const exports: Record<string, unknown> = {};
  runInNewContext(
    ts.transpileModule(source.replace(anchor, replacement), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText,
    {
      exports,
      require: (specifier: string) => {
        if (!Object.hasOwn(bindings, specifier))
          throw new Error(`live-export-snapshot-mutant-import-unbound: ${specifier}`);
        return bindings[specifier];
      },
    },
  );
  return exports as T;
}
