import { t } from "@chase-sets/localization";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import { requireActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import { MyCollectionPage } from "../../support/ui-support";
import type {
  CollectionOverviewView,
  MyCollectionHrefs,
  MyCollectionSection,
  MyCollectionView,
  OwnedCardsView,
  SavedListDetailView,
  SavedListSummaryView,
  SavedListsView,
} from "../../support/ui-support";
import {
  CollectionsApiError,
  createCollectionsRequestApiClient,
  type CollectionsSavedListSummary,
  type SavedListId,
  type SavedListOwnerSnapshot,
} from "../../support/request-support/api-client";

const COLLECTION_READ_TIMEOUT_MS = 10_000;

const hrefs: MyCollectionHrefs = {
  section: (section) => `/account/collection?section=${section}`,
  list: (listId) => `/account/collection/lists/${encodeURIComponent(listId)}`,
  lists: "/account/collection",
};

function toSummaryView(summary: CollectionsSavedListSummary): SavedListSummaryView {
  return {
    listId: summary.listId,
    title: summary.title,
    description: summary.description,
    visibility: summary.visibility,
    lineCount: summary.lineCount,
    trackedUnitCount: summary.trackedUnitCount,
    changedAt: summary.changedAt,
    estimatedValue:
      summary.estimatedValueAmount && summary.estimatedValueCurrency
        ? { amount: summary.estimatedValueAmount, currency: summary.estimatedValueCurrency }
        : null,
  };
}

function toDetailView(snapshot: SavedListOwnerSnapshot): SavedListDetailView {
  return {
    snapshot,
    estimatedValue: null,
    lineDisplay: Object.fromEntries(
      snapshot.lines.map((line) => [
        line.lineId,
        {
          title: line.product.productId,
          subtitle: null,
          availability: "active" as const,
          estimatedValue: null,
        },
      ]),
    ),
  };
}

function resolveActiveSection(url: URL, listId: string | null): MyCollectionSection {
  if (listId) {
    return "lists";
  }
  const section = url.searchParams.get("section");
  if (section === "owned-cards" || section === "lists") {
    return section;
  }
  if (url.searchParams.get("q")) {
    return "lists";
  }
  return "overview";
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  await requireActorFromAuthApi({ request, permission: "collection.view" });
  const api = createCollectionsRequestApiClient(request, {
    requestTimeoutMs: COLLECTION_READ_TIMEOUT_MS,
    recoverTransportErrorsAsGatewayTimeout: true,
  });
  const url = new URL(request.url);
  const query = url.searchParams.get("q") ?? "";
  const listId = (params.listId ?? null) as SavedListId | null;

  let summaries: SavedListSummaryView[] = [];
  let selected: SavedListDetailView | null = null;
  let listsStatus: SavedListsView["status"] = "ready";
  // Saved List commands are owned by the Collections command mount and the My
  // Collection composition contract. Until those are wired at the composition
  // root, this surface stays read-only rather than posting to an absent service.
  const editUnavailable = true;

  try {
    const response = await api.listSavedLists(query);
    summaries = response.items.map(toSummaryView);
  } catch (error) {
    if (error instanceof CollectionsApiError) {
      listsStatus = "error";
    } else {
      throw error;
    }
  }

  if (listId) {
    try {
      selected = toDetailView(await api.getSavedList(listId));
    } catch (error) {
      if (!(error instanceof CollectionsApiError)) {
        throw error;
      }
    }
  }

  const savedListCount = summaries.length;
  const overview: CollectionOverviewView = {
    // Overview and Owned Cards valuation are Inventory-owned and composed by the
    // My Collection composition contract; until that read is wired the surface
    // degrades value while leaving lists usable.
    status: savedListCount === 0 ? "empty" : "ready",
    pricingDegraded: true,
    totalValue: null,
    ownedCardCount: 0,
    ownedUnitCount: 0,
    savedListCount,
    pricedCoveragePercent: null,
    recentActivity: [],
  };

  const ownedCards: OwnedCardsView = {
    status: "empty",
    pricingDegraded: true,
    showAcquisitionCost: false,
    cards: [],
  };

  const lists: SavedListsView = {
    status: listsStatus,
    lists: summaries,
    query,
    selected,
    editUnavailable,
  };

  const view: MyCollectionView = {
    activeSection: resolveActiveSection(url, listId),
    overview,
    ownedCards,
    lists,
  };

  return { view };
}

export const meta: MetaFunction = () =>
  buildOpenGraphMeta({
    title: t("collections.features.myCollection.ui.myCollectionPage.title"),
    description: t("collections.features.myCollection.ui.myCollectionPage.description"),
  });

export default function AccountCollectionRoute() {
  const data = useLoaderData<typeof loader>();
  return <MyCollectionPage view={data.view} hrefs={hrefs} />;
}
