import type { action } from "./action";
import type { loader } from "./loader";
import type { EMPTY_ITEM_DETAIL_RESULT } from "./support";

export type DiscoveryItemDetailRouteData = typeof EMPTY_ITEM_DETAIL_RESULT | Awaited<ReturnType<typeof loader>>;
export type DiscoveryItemDetailActionData = Exclude<Awaited<ReturnType<typeof action>>, Response> | undefined;
