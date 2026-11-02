import { PORTFOLIO_SOLVER_POLICY } from "./policy";

/** Reads one keyset page of an explicit portfolio: listings after `after` in listing-id order, at most `limit`. */
export type PortfolioPageReader<Listing extends Readonly<{ listingId: string }>> = (
  page: Readonly<{ after: string | null; limit: number }>,
) => Promise<readonly Listing[]>;

/**
 * Loads a caller's explicit portfolio through every keyset page before
 * anything is solved, so the page size bounds I/O and never the portfolio: a
 * short page ends the set. Listing ids compare by code unit. A page that does
 * not advance strictly by listing id fails, so a reader that ignores the
 * keyset can neither repeat nor reorder listings.
 */
export async function assemblePortfolio<Listing extends Readonly<{ listingId: string }>>(
  readPage: PortfolioPageReader<Listing>,
  pageSize: number = PORTFOLIO_SOLVER_POLICY.pageSize,
): Promise<readonly Listing[]> {
  if (!Number.isSafeInteger(pageSize) || pageSize < 1) throw new Error("Portfolio pages need a positive size.");
  const listings: Listing[] = [];
  let after: string | null = null;
  while (true) {
    const page = await readPage({ after, limit: pageSize });
    if (page.length > pageSize)
      throw new Error(`Portfolio page returned ${page.length} listings; the limit is ${pageSize}.`);
    for (const [index, listing] of page.entries()) {
      const previous = index === 0 ? after : page[index - 1]!.listingId;
      if (previous === null || listing.listingId > previous) continue;
      throw new Error(
        index === 0
          ? `Portfolio page after ${after} starts at ${listing.listingId}; keyset pages must advance strictly by listing id.`
          : `Portfolio page after ${after ?? "the start"} starts at ${page[0]!.listingId} but then lists ${listing.listingId}; keyset pages must advance strictly by listing id.`,
      );
    }
    listings.push(...page);
    if (page.length < pageSize) return listings;
    after = page.at(-1)!.listingId;
  }
}
