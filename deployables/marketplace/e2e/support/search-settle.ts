import { expect, type Locator, type Page } from "@playwright/test";

/** Wait for the search transition to finish and for its Result Set count to stop changing. */
export async function settleSearchResults(page: Page, resultSet: Locator): Promise<number> {
  let previousCount: number | undefined;
  let settledCount = -1;

  await expect
    .poll(
      async () => {
        await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
        const count = await resultSet.count();
        const stable = count === previousCount;
        previousCount = count;
        if (stable) settledCount = count;
        return stable;
      },
      { message: "Result Set must settle at a stable count after its loading state clears" },
    )
    .toBe(true);

  return settledCount;
}
