// The operation log API is keyset-paginated: a cursor only ever steps one page
// forward from the page that produced it. The connection-detail route therefore
// carries the cursors it has already walked through in the query string so the
// UI can offer honest previous/next links without offset paging or invented
// cursors. An empty trail entry marks the first page, which needs no cursor.

const CURSOR_PATTERN = /^[A-Za-z0-9_-]{1,1024}$/;

// Retained prior-page cursors are bounded so the query string stays well under
// common request-line limits; beyond the limit the first page remains reachable.
export const OUTBOUND_OPERATION_LOG_TRAIL_LIMIT = 10;

export type OutboundOperationLogPosition = Readonly<{
  cursor: string | null;
  trail: readonly string[];
}>;

export type OutboundOperationLogNavigation = Readonly<{
  previous: Readonly<{ href: string; kind: "previous" | "first" }> | null;
  next: Readonly<{ href: string }> | null;
}>;

export function readOutboundOperationLogPosition(searchParams: URLSearchParams): OutboundOperationLogPosition {
  const cursorText = searchParams.get("cursor");
  const cursor = cursorText !== null && CURSOR_PATTERN.test(cursorText) ? cursorText : null;
  const trail = searchParams
    .getAll("trail")
    .filter((entry) => entry === "" || CURSOR_PATTERN.test(entry))
    .slice(-OUTBOUND_OPERATION_LOG_TRAIL_LIMIT);
  return { cursor, trail: cursor === null ? [] : trail };
}

export function resolveOutboundOperationLogNavigation(
  position: OutboundOperationLogPosition,
  nextCursor: string | null,
): OutboundOperationLogNavigation {
  return {
    previous: resolvePrevious(position),
    next:
      nextCursor === null
        ? null
        : {
            href: pageHref(
              nextCursor,
              [...position.trail, position.cursor ?? ""].slice(-OUTBOUND_OPERATION_LOG_TRAIL_LIMIT),
            ),
          },
  };
}

function resolvePrevious(position: OutboundOperationLogPosition): OutboundOperationLogNavigation["previous"] {
  if (position.cursor === null) return null;
  const priorCursor = position.trail.at(-1);
  if (priorCursor === undefined) return { href: pageHref(null, []), kind: "first" };
  return { href: pageHref(priorCursor === "" ? null : priorCursor, position.trail.slice(0, -1)), kind: "previous" };
}

function pageHref(cursor: string | null, trail: readonly string[]): string {
  const query = new URLSearchParams();
  if (cursor !== null) query.set("cursor", cursor);
  for (const entry of trail) query.append("trail", entry);
  return `?${query}`;
}
