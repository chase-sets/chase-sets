import { describe, expect, it } from "vitest";
import { SearchControlBar, SearchInput } from "../index";

/**
 * Type-only tripwire for the `SearchControlBar` discriminated union (issue #3426).
 * `filterControlsVisibility="desktop"` must not typecheck without `mobileFilters`.
 * This function is never called — its value is the `// @ts-expect-error` below,
 * verified by `pnpm run verify:typecheck`.
 */
function desktopFilterVisibilityRequiresMobileFilters() {
  const search = <SearchInput label="Search" hideLabel />;

  // @ts-expect-error — "desktop" visibility requires a `mobileFilters` counterpart.
  return <SearchControlBar search={search} filterControlsVisibility="desktop" />;
}

describe("SearchControlBar prop contract", () => {
  it("keeps the negative type fixture referenced so it is not tree-shaken or deleted as dead code", () => {
    expect(typeof desktopFilterVisibilityRequiresMobileFilters).toBe("function");
  });
});
