// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
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

function appearances(input: unknown) {
  const theme = input as EmbeddedSurfaceTheme;
  return [
    createStripeElementsAppearance({ theme }),
    createStripeElementsAppearance({ theme, includeRules: false }),
    createStripeConnectAppearance({ theme }),
  ];
}

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
});
