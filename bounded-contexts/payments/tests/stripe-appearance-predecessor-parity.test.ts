// @vitest-environment jsdom
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import ts from "@chase-sets/typescript-compiler-api";
import { describe, expect, it } from "vitest";
import { resolveEmbeddedSurfaceTheme } from "@chase-sets/design-system";
import { resolveThemeTokenValue } from "../../../packages/design-system/src/theme/internal-token-values";
import { cssValues } from "./stripe-appearance-support";
import { createStripeConnectAppearance, createStripeElementsAppearance } from "@chase-sets/stripe-appearance";

const predecessorHead = "49300aad3b1c17f230afd42da09e549ad51a3e46";
const predecessorPath = "packages/design-system/src/theme/stripe-appearance.ts";
const predecessorSource = execFileSync("git", ["show", `${predecessorHead}:${predecessorPath}`], { encoding: "utf8" });
const predecessorDigest = createHash("sha256").update(predecessorSource).digest("hex");

type Predecessor = {
  createStripeElementsAppearance: (options: {
    scope: Element;
    includeRules: boolean;
  }) => ReturnType<typeof createStripeElementsAppearance>;
  createStripeConnectAppearance: (options: { scope: Element }) => ReturnType<typeof createStripeConnectAppearance>;
};

function predecessor(): Predecessor {
  const output = ts.transpileModule(predecessorSource, {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  }).outputText;
  const exports: Record<string, unknown> = {};
  // Only the exact predecessor's one internal import is allowed. No candidate module is evaluated here.
  const requirePredecessor = (name: string) => {
    if (name !== "./internal-token-values") throw new Error(`Unexpected predecessor import: ${name}`);
    return { resolveThemeTokenValue };
  };
  new Function("exports", "require", output)(exports, requirePredecessor);
  return exports as Predecessor;
}

describe("dispatch-base predecessor parity", () => {
  it("pins a resolvable source symbol and digest", () => {
    expect(predecessorDigest).toBe("13b2ddf3c4870009c9f0696d522e2de3635d52d16ca2f8053ec62c284ca8f231");
    expect(predecessorSource).toContain("export function createStripeConnectAppearance");
    expect(predecessorSource).toContain("export function createStripeElementsAppearance");
  });

  it.each(["light", "dark"] as const)("equals the predecessor on default, scoped and absent %s inputs", (mode) => {
    const old = predecessor();
    const scope = document.createElement("div");
    scope.dataset.chaseTheme = "";
    scope.dataset.colorMode = mode;
    const child = document.createElement("div");
    scope.appendChild(child);
    document.body.append(scope);
    try {
      for (const values of [cssValues(mode), {}, { "--primary": "#123abc", "--radius": "1.125rem" }]) {
        scope.removeAttribute("style");
        for (const [name, value] of Object.entries(values)) scope.style.setProperty(name, value);
        const inputDigest = createHash("sha256").update(JSON.stringify(values)).digest("hex");
        expect(inputDigest).toMatch(/^[0-9a-f]{64}$/);
        console.log(`predecessor=${predecessorHead} source=${predecessorDigest} mode=${mode} input=${inputDigest}`);
        for (const includeRules of [true, false]) {
          expect(
            createStripeElementsAppearance({ theme: resolveEmbeddedSurfaceTheme({ scope: child }), includeRules }),
          ).toEqual(old.createStripeElementsAppearance({ scope: child, includeRules }));
        }
        expect(createStripeConnectAppearance({ theme: resolveEmbeddedSurfaceTheme({ scope: child }) })).toEqual(
          old.createStripeConnectAppearance({ scope: child }),
        );
      }
    } finally {
      scope.remove();
    }
  });

  it("rejects key, value, rule, conversion, default and nesting mutants", () => {
    const old = predecessor();
    const scope = document.createElement("div");
    scope.dataset.chaseTheme = "";
    document.body.append(scope);
    try {
      const expected = old.createStripeElementsAppearance({ scope, includeRules: true });
      const actual = createStripeElementsAppearance({ theme: resolveEmbeddedSurfaceTheme({ scope }) });
      expect(actual).toEqual(expected);
      for (const mutate of [
        (value: Record<string, unknown>) => {
          delete (value.variables as Record<string, unknown>).colorPrimary;
        },
        (value: Record<string, unknown>) => {
          (value.variables as Record<string, unknown>).colorPrimary = "#000000";
        },
        (value: Record<string, unknown>) => {
          delete (value.rules as Record<string, unknown>)[".Input"];
        },
        (value: Record<string, unknown>) => {
          (value.variables as Record<string, unknown>).borderRadius = "8px";
        },
        (value: Record<string, unknown>) => {
          (value.variables as Record<string, unknown>).colorBackground = "#000000";
        },
        (value: Record<string, unknown>) => {
          value.rules = { nested: value.rules };
        },
      ]) {
        const mutant = structuredClone(actual) as Record<string, unknown>;
        mutate(mutant);
        expect(mutant).not.toEqual(expected);
      }
      expect(
        createStripeElementsAppearance({ theme: resolveEmbeddedSurfaceTheme({ scope }), includeRules: false }),
      ).toEqual(old.createStripeElementsAppearance({ scope, includeRules: false }));
    } finally {
      scope.remove();
    }
  });
});
