import { AsyncLocalStorage } from "node:async_hooks";
import type { ScrydexCountQuery, ScrydexCountSource } from "../../../scope-sync-batches/domain/count-acquisition";

// One count-source selection: the query a reader was asked, the source it chose
// (null when none was current) and the reader's own clock at that choice.
export type CountSourceWinner = Readonly<{
  query: ScrydexCountQuery;
  source: ScrydexCountSource | null;
  readAt: string;
}>;

const observers = new AsyncLocalStorage<(winner: CountSourceWinner) => void>();

// Reports every winner a count reader selects inside `work` to `observer`. The
// reader never imports its observer, and outside `work` nothing is reported.
export function observeCountSourceWinners<T>(observer: (winner: CountSourceWinner) => void, work: () => T): T {
  return observers.run(observer, work);
}

// Called by a reader with the value it already selected; it never reads again.
export function reportCountSourceWinner(winner: CountSourceWinner): void {
  observers.getStore()?.(winner);
}
