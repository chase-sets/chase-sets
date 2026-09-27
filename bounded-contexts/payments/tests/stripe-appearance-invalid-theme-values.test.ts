// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "@chase-sets/typescript-compiler-api";
import { describe, expect, it } from "vitest";
import { resolveEmbeddedSurfaceTheme } from "@chase-sets/design-system";
import type { EmbeddedSurfaceTheme } from "@chase-sets/embedded-surface-theme";
import { cssValues, repositoryRoot } from "./stripe-appearance-support";
import { createStripeConnectAppearance, createStripeElementsAppearance } from "@chase-sets/stripe-appearance";

const source = readFileSync(
  join(repositoryRoot(), "packages/design-system/src/theme/embedded-surface-theme.ts"),
  "utf8",
);
const mapBody = source.match(/const embeddedSurfaceThemeCssInputs = \{([\s\S]*?)\} as const;/)?.[1];
if (!mapBody) throw new Error("Closed input map missing");
const slots = [...mapBody.matchAll(/^\s+(\w+): "(--[\w-]+)",?$/gm)].map((match) => match[1]!);

function theme() {
  const scope = document.createElement("div");
  scope.dataset.chaseTheme = "";
  for (const [key, value] of Object.entries(cssValues("light"))) scope.style.setProperty(key, value);
  document.body.append(scope);
  const value = resolveEmbeddedSurfaceTheme({ scope });
  scope.remove();
  return value;
}

type Adapter = Readonly<{
  createStripeElementsAppearance: typeof createStripeElementsAppearance;
  createStripeConnectAppearance: typeof createStripeConnectAppearance;
}>;

function appearances(
  input: unknown,
  adapter: Adapter = { createStripeElementsAppearance, createStripeConnectAppearance },
) {
  const theme = input as EmbeddedSurfaceTheme;
  return [
    adapter.createStripeElementsAppearance({ theme }),
    adapter.createStripeElementsAppearance({ theme, includeRules: false }),
    adapter.createStripeConnectAppearance({ theme }),
  ];
}

const malformedBySlot = {
  accent: ["#1234567", "rgb(0,0 0)", "rgb(0 0 0, 0.5)", "rgba(0,0,0/0.5)", "rgb(0 0,0)"],
  smallShadow: ["0 1px 2px rgba(,,,)", "0 1px 2px rgba(1.2.3)"],
  bodyFontFamily: ['"unterminated', ",,,", "'a\"b"],
} as const;

describe("nonthrowing invalid embedded theme substitution", () => {
  it("covers every closed input including unmapped pageBackground", () => {
    expect(slots).toHaveLength(34);
    const original = theme();
    expect(original.pageBackground).toBe("#f7f5f1");
    for (const slot of slots) {
      const missing = { ...original, [slot]: undefined };
      const expected = appearances(missing);
      for (const bad of [
        "",
        " ",
        "var(--missing)",
        "url(https://example.test/x)",
        "NaN",
        "Infinity",
        "1.2.3px",
        "red; color: blue",
        null,
        42,
      ]) {
        expect(appearances({ ...original, [slot]: bad }), `${slot}: ${String(bad)}`).toEqual(expected);
      }
    }
  });

  it("rejects non-object and unknown-key data, and never truncates modalLayer", () => {
    const defaults = appearances(undefined);
    for (const bad of [null, false, 1, "theme", [], { ...theme(), unknown: "red" }]) {
      expect(appearances(bad)).toEqual(defaults);
    }
    const original = theme();
    for (const bad of ["1.2", "1abc", "-1", "9007199254740992", "Infinity", "1e3"]) {
      expect(appearances({ ...original, modalLayer: bad })).toEqual(
        appearances({ ...original, modalLayer: undefined }),
      );
    }
    expect(appearances({ ...original, mode: "invalid" })).toEqual(appearances({ ...original, mode: "light" }));
  });

  it("substitutes malformed colour, shadow and font syntax in the affected slots", () => {
    const original = theme();
    for (const [slot, values] of Object.entries(malformedBySlot)) {
      const expected = appearances({ ...original, [slot]: undefined });
      for (const bad of values) {
        expect(appearances({ ...original, [slot]: bad }), `${slot}: ${bad}`).toEqual(expected);
      }
    }
  });

  it("keeps accepted colour literals and the real dark shadow", () => {
    const original = theme();
    for (const color of [
      "#fff",
      "#ffff",
      "#ffffff",
      "#ffffff80",
      "rgb(1, 2, 3)",
      "rgba(1, 2, 3, 0.5)",
      "rgb(1 2 3 / 0.5)",
      "transparent",
    ]) {
      const input = { ...original, accent: color };
      expect(createStripeElementsAppearance({ theme: input }).variables.colorPrimary).toBe(color);
      expect(createStripeConnectAppearance({ theme: input }).variables.colorPrimary).toBe(color);
    }
    const darkShadow = "0 1px 2px rgba(6, 5, 11, 0.32)";
    expect(
      createStripeElementsAppearance({ theme: { ...original, smallShadow: darkShadow } }).rules?.[".Block"]?.boxShadow,
    ).toBe(darkShadow);
  });

  it("goes red when source validation is bypassed for mapped malformed slots", () => {
    const adapterSource = readFileSync(
      join(repositoryRoot(), "infrastructure/stripe-appearance/stripe-appearance.ts"),
      "utf8",
    );
    const bypassedSource = adapterSource.replace(
      "function valid(slot: Slot, value: unknown): value is string {",
      "$&\n  if (typeof value === 'string' && value !== '') return true;",
    );
    expect(bypassedSource).not.toBe(adapterSource);
    const output = ts.transpileModule(bypassedSource, {
      compilerOptions: { module: ts.ModuleKind.CommonJS },
    }).outputText;
    const exports: Record<string, unknown> = {};
    new Function("exports", "require", output)(exports, (name: string) => {
      throw new Error(`Unexpected adapter import: ${name}`);
    });
    const bypassed = exports as Adapter;
    const original = theme();
    for (const [slot, values] of Object.entries(malformedBySlot)) {
      expect(appearances({ ...original, [slot]: values[0] }, bypassed), slot).not.toEqual(
        appearances({ ...original, [slot]: undefined }, bypassed),
      );
    }
  });
});
