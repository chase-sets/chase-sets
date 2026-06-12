import type { action } from "./item-detail.action";
import type { loader } from "./item-detail.loader";
import type { EMPTY_ITEM_DETAIL_RESULT } from "./item-detail.support";

export type DiscoveryItemDetailRouteData = typeof EMPTY_ITEM_DETAIL_RESULT | Awaited<ReturnType<typeof loader>>;
export type DiscoveryItemDetailActionData = Exclude<Awaited<ReturnType<typeof action>>, Response> | undefined;
