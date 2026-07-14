import { t } from "@chase-sets/localization";
import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect, useActionData, useLoaderData, useRouteLoaderData } from "react-router";
import { requireActorFromAuthApi, resolveRequiredActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import { useRealtimePatchedSnapshot } from "@chase-sets/platform-runtime/realtime-react";
import { type FreshWriteReadErrorClassification, type ListResponse } from "@chase-sets/http/responses";
import { Card, LinkButton, Page, PageHeader, PageSection, Stack, Text } from "@chase-sets/design-system";
import {
  loadAfterWrite,
  navigateAfterWriteWithCompactToken,
  type PlatformPostWriteTelemetry,
} from "@chase-sets/platform-runtime/http";
import {
  createMarketplaceRequestApiClient,
  MarketplaceApiError,
  type MarketplaceListingFeeLockReportEntry,
  type MarketplaceListingListItem,
  type MarketplaceSellerListingAvailability,
  type MarketplaceSellerOrderCapacity,
  type MarketplaceSellerListingStatusCounts,
} from "../support/request-support/api-client";
import { createSellerMetricsRequestApiClient } from "../support/request-support/seller-metrics-api-client";
import { createOrderingOpenOrdersRequestApiClient } from "../support/request-support/ordering-open-orders-api-client";
import type { SellerBehavioralMetricsSummary } from "../support/request-support/seller-metrics-client";
import type { MarketplaceListingBulkActionOutcome } from "../features/listings/ui/contracts";
import {
  resolveMarketplacePostWriteRequest,
  resolveMarketplacePostWriteTokenStore,
} from "../support/route-support/post-write-tokens";
import { MarketplaceListingListPage } from "../features/listings/ui/listing-list-page";
import { applyMarketplaceListPatch } from "../support/realtime-support/patches";
import { marketplaceRealtimeRouteTopics } from "../support/realtime-support/topics";
import { sellerListingFilters, sellerListingPageQuery } from "../support/request-support/list-pagination";

const DEFAULT_FEE_LOCK_QUERY = "limit=100&offset=0";
const MARKETPLACE_DESCRIPTION = t("marketplace.routes.accountListings.manage.active.draft.paused.and.withdrawn");
const AVAILABILITY_ACTION_PARAM = "availabilityAction";
const SETTINGS_ACTION_PARAM = "settingsAction";
const SETTINGS_ACTIONS = {
  scheduleAwayWindow: "schedule-away-window",
  cancelAwayWindow: "cancel-away-window",
  setOrderCapacity: "set-order-capacity",
  clearOrderCapacity: "clear-order-capacity",
} as const;
const ACCOUNT_LISTINGS_POST_WRITE_TELEMETRY = {
  boundedContextName: "marketplace",
  surface: "account-listings",
  routeId: "account-listings",
  routeTemplate: "/account/listings",
} as const satisfies PlatformPostWriteTelemetry;

function currentAccountPath(request: Request) {
  const url = new URL(request.url);
  return `${url.pathname}${url.search}`;
}

function accountAccessRequired(returnTo: string) {
  return {
    accountAccessRequired: {
      returnTo,
      title: t("marketplace.routes.accountListings.account.access.required.title"),
      description: t("marketplace.routes.accountListings.account.access.required.description"),
    },
    listings: emptyListingsResponse(),
    feeLockReport: emptyListResponse<MarketplaceListingFeeLockReportEntry>(),
    listingAvailability: {
      account_id: "",
      status: "available" as const,
      disabled_reason_category: null,
      available_again_on: null,
      available_again_at: null,
      disabled_at: null,
      enabled_at: null,
      away_window_starts_at: null,
      away_window_ends_at: null,
      away_window_reason_category: null,
      updated_at: "1970-01-01T00:00:00.000Z",
    },
    orderCapacity: emptyOrderCapacity(""),
    openOrderCount: null,
    filters: { status: "all", search: "" },
    sellerBehavioralMetrics: null,
  };
}

function emptyOrderCapacity(accountId: string): MarketplaceSellerOrderCapacity {
  return {
    account_id: accountId,
    max_open_orders: null,
    updated_at: "1970-01-01T00:00:00.000Z",
  };
}

function marketplaceApiErrorStatus(error: unknown) {
  return error instanceof MarketplaceApiError ? error.status : null;
}

type MarketplaceListingListResponse = ListResponse<MarketplaceListingListItem> &
  Readonly<{
    limit: number;
    offset: number;
    statusCounts: MarketplaceSellerListingStatusCounts;
  }>;

type AccountListingsPageReads = Readonly<{
  listings: MarketplaceListingListResponse;
  feeLockReport: ListResponse<MarketplaceListingFeeLockReportEntry>;
  listingAvailability: MarketplaceSellerListingAvailability;
  orderCapacity: MarketplaceSellerOrderCapacity;
}>;

function emptyListResponse<T>(): ListResponse<T> {
  return { items: [], total: 0, count: 0 };
}

function emptyListingsResponse(): MarketplaceListingListResponse {
  return {
    ...emptyListResponse<MarketplaceListingListItem>(),
    limit: 100,
    offset: 0,
    statusCounts: { active: 0, draft: 0, paused: 0, withdrawn: 0 },
  };
}

function createFreshWriteRecoveryPageReads(
  accountId: string,
  availabilityStatus: MarketplaceSellerListingAvailability["status"] = "available",
): AccountListingsPageReads {
  return {
    listings: emptyListingsResponse(),
    feeLockReport: emptyListResponse(),
    listingAvailability: {
      account_id: accountId,
      status: availabilityStatus,
      disabled_reason_category: null,
      available_again_on: null,
      available_again_at: null,
      disabled_at: null,
      enabled_at: null,
      away_window_starts_at: null,
      away_window_ends_at: null,
      away_window_reason_category: null,
      updated_at: "1970-01-01T00:00:00.000Z",
    },
    orderCapacity: emptyOrderCapacity(accountId),
  };
}

function hasMarketplaceFreshWriteSource(classification: FreshWriteReadErrorClassification) {
  return classification.receipt?.sources.some((source) => source.sourceContextName === "marketplace") ?? false;
}

function availabilityStatusFromAction(value: string | null): MarketplaceSellerListingAvailability["status"] | null {
  if (value === "disabled") {
    return "unavailable";
  }
  if (value === "enabled") {
    return "available";
  }
  return null;
}

function requestWithoutFreshWrite(request: Request) {
  const url = new URL(request.url);
  url.searchParams.delete("afterWrite");
  url.searchParams.delete("postWriteHandoff");
  url.searchParams.delete("postWriteToken");
  return new Request(url.toString(), { headers: request.headers });
}

function settingsDestination(
  action: (typeof SETTINGS_ACTIONS)[keyof typeof SETTINGS_ACTIONS],
  values: Record<string, string> = {},
) {
  const searchParams = new URLSearchParams({ [SETTINGS_ACTION_PARAM]: action, ...values });
  return `/account/listings?${searchParams.toString()}`;
}

function applySettingsRecovery(
  reads: AccountListingsPageReads,
  searchParams: URLSearchParams,
): AccountListingsPageReads {
  const action = searchParams.get(SETTINGS_ACTION_PARAM);

  if (action === SETTINGS_ACTIONS.scheduleAwayWindow) {
    const startsAt = searchParams.get("awayWindowStartsAt");
    if (!startsAt) return reads;

    return {
      ...reads,
      listingAvailability: {
        ...reads.listingAvailability,
        away_window_starts_at: startsAt,
        away_window_ends_at: searchParams.get("awayWindowEndsAt"),
        away_window_reason_category: searchParams.get("awayWindowReasonCategory"),
      },
    };
  }

  if (action === SETTINGS_ACTIONS.cancelAwayWindow) {
    return {
      ...reads,
      listingAvailability: {
        ...reads.listingAvailability,
        away_window_starts_at: null,
        away_window_ends_at: null,
        away_window_reason_category: null,
      },
    };
  }

  if (action === SETTINGS_ACTIONS.setOrderCapacity) {
    const maxOpenOrders = Number(searchParams.get("maxOpenOrders"));
    if (!Number.isSafeInteger(maxOpenOrders) || maxOpenOrders < 1) return reads;

    return {
      ...reads,
      orderCapacity: { ...reads.orderCapacity, max_open_orders: maxOpenOrders },
    };
  }

  if (action === SETTINGS_ACTIONS.clearOrderCapacity) {
    return {
      ...reads,
      orderCapacity: { ...reads.orderCapacity, max_open_orders: null },
    };
  }

  return reads;
}

function bulkActionOutcomeLabel(listingId: string) {
  return t("marketplace.routes.accountListings.bulk.action.listing.label", { listingId });
}

function bulkActionOutcomeErrorMessage(error: unknown) {
  return error instanceof MarketplaceApiError || error instanceof Error
    ? error.message
    : t("marketplace.routes.accountListings.bulk.action.request.failed");
}

async function navigateToAccountListingsAfterWrite(commandResult: unknown, destinationRoute: string) {
  return navigateAfterWriteWithCompactToken(commandResult, destinationRoute, {
    postWriteTokenStore: await resolveMarketplacePostWriteTokenStore(),
    telemetry: ACCOUNT_LISTINGS_POST_WRITE_TELEMETRY,
  });
}

export async function loader({ request }: LoaderFunctionArgs) {
  const actorResult = await resolveRequiredActorFromAuthApi({ request, permission: "listings.view" });
  if (actorResult.kind === "signed-out") {
    throw actorResult.response;
  }
  if (actorResult.kind === "forbidden") {
    return accountAccessRequired(currentAccountPath(request));
  }
  const actor = actorResult.actor;
  const resolvedRequest = await resolveMarketplacePostWriteRequest(request);
  const marketplaceApi = createMarketplaceRequestApiClient(resolvedRequest);
  const listingsPageQuery = sellerListingPageQuery(resolvedRequest);
  const filters = sellerListingFilters(resolvedRequest);
  const searchParams = new URL(resolvedRequest.url).searchParams;
  const pendingAvailabilityStatus = availabilityStatusFromAction(searchParams.get(AVAILABILITY_ACTION_PARAM));
  const pendingSettingsAction = searchParams.get(SETTINGS_ACTION_PARAM);

  const loadPageReads = async (apiClient: typeof marketplaceApi): Promise<AccountListingsPageReads> => {
    const [listings, feeLockReport, listingAvailability, orderCapacity] = await Promise.all([
      apiClient.listSellerListings(listingsPageQuery),
      apiClient.listSellerListingFeeLockReport(DEFAULT_FEE_LOCK_QUERY),
      apiClient.getSellerListingAvailability(),
      apiClient.getSellerOrderCapacity(),
    ]);

    return { listings, feeLockReport, listingAvailability, orderCapacity };
  };

  const pageRead = await loadAfterWrite<AccountListingsPageReads>({
    request: resolvedRequest,
    isNotFound: (error) => marketplaceApiErrorStatus(error) === 404,
    load: () => loadPageReads(marketplaceApi),
    telemetry: ACCOUNT_LISTINGS_POST_WRITE_TELEMETRY,
  });

  let pageReads: AccountListingsPageReads;
  if (pageRead.kind === "data") {
    pageReads = pageRead.data;
  } else if (pageRead.kind === "pending" && "classification" in pageRead) {
    const { classification } = pageRead;
    if (classification.transient && hasMarketplaceFreshWriteSource(classification)) {
      if (pendingSettingsAction) {
        const recoveryApi = createMarketplaceRequestApiClient(requestWithoutFreshWrite(resolvedRequest));
        pageReads = applySettingsRecovery(await loadPageReads(recoveryApi), searchParams);
      } else if (pendingAvailabilityStatus) {
        pageReads = createFreshWriteRecoveryPageReads(actor.accountId, pendingAvailabilityStatus);
      } else {
        throw pageRead.error;
      }
    } else {
      throw pageRead.error;
    }
  } else if ("error" in pageRead) {
    throw pageRead.error;
  } else {
    throw new Response(t("marketplace.routes.accountListings.listings.marketplace"), { status: 500 });
  }

  const { listings, feeLockReport, listingAvailability, orderCapacity } = pageReads;

  // Best-effort, outside the write-freshness machinery above --
  // behavioral metrics have no write path on this page, so there is nothing
  // to stay fresh against; a transient failure degrades the KPI panel to
  // "not enough orders yet" rather than failing the whole listings page.
  const sellerBehavioralMetrics = await fetchSellerBehavioralMetrics(resolvedRequest);

  // Ordering-sourced live Open Order count (the "N" in the card's "N of M"),
  // read cross-context and best-effort: Ordering owns this count, the setting
  // itself is written to marketplace, so a transient Ordering read failure
  // degrades the count to "temporarily unavailable" rather than failing the
  // whole listings page. Never counted client-side.
  const openOrderCount = await fetchSellerOpenOrderCount(resolvedRequest);

  return {
    accountAccessRequired: null,
    listings,
    feeLockReport,
    listingAvailability,
    orderCapacity,
    openOrderCount,
    filters,
    sellerBehavioralMetrics,
  };
}

async function fetchSellerBehavioralMetrics(request: Request): Promise<SellerBehavioralMetricsSummary | null> {
  try {
    return await createSellerMetricsRequestApiClient(request).getOwnBehavioralMetrics();
  } catch {
    return null;
  }
}

async function fetchSellerOpenOrderCount(request: Request): Promise<number | null> {
  try {
    return await createOrderingOpenOrdersRequestApiClient(request).getSellerOpenOrderCount();
  } catch {
    return null;
  }
}

export async function action({ request }: ActionFunctionArgs) {
  await requireActorFromAuthApi({ request, permission: "listings.manage" });
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");
  const api = createMarketplaceRequestApiClient(request);

  try {
    if (intent === "disable-listing-availability") {
      return redirect(
        await navigateToAccountListingsAfterWrite(
          await api.disableSellerListingAvailability({
            reasonCategory: String(formData.get("reasonCategory") ?? ""),
            availableAgainOn: String(formData.get("availableAgainOn") ?? ""),
            // Captured client-side by the disable form (seller-local
            // start-of-day for the chosen date); empty when JavaScript
            // never ran, which the domain treats as informational-only,
            // same as before this instant existed.
            availableAgainAt: String(formData.get("availableAgainAt") ?? ""),
          }),
          `/account/listings?${AVAILABILITY_ACTION_PARAM}=disabled`,
        ),
      );
    }

    if (intent === "enable-listing-availability") {
      return redirect(
        await navigateToAccountListingsAfterWrite(
          await api.enableSellerListingAvailability(),
          `/account/listings?${AVAILABILITY_ACTION_PARAM}=enabled`,
        ),
      );
    }

    if (intent === "schedule-away-window") {
      const reasonCategory = String(formData.get("awayWindowReasonCategory") ?? "");
      const startsAt = String(formData.get("awayWindowStartsAt") ?? "");
      const endsAt = String(formData.get("awayWindowEndsAt") ?? "");
      return redirect(
        await navigateToAccountListingsAfterWrite(
          await api.scheduleSellerAwayWindow({
            reasonCategory,
            // Captured client-side (seller-local start-of-day for the
            // chosen date, converted to an instant), same convention as
            // the disable form's availableAgainAt.
            startsAt,
            endsAt,
          }),
          settingsDestination(SETTINGS_ACTIONS.scheduleAwayWindow, {
            awayWindowReasonCategory: reasonCategory,
            awayWindowStartsAt: startsAt,
            awayWindowEndsAt: endsAt,
          }),
        ),
      );
    }

    if (intent === "cancel-away-window") {
      return redirect(
        await navigateToAccountListingsAfterWrite(
          await api.cancelScheduledAwayWindow(),
          settingsDestination(SETTINGS_ACTIONS.cancelAwayWindow),
        ),
      );
    }

    if (intent === "set-order-capacity") {
      const maxOpenOrders = Number(formData.get("maxOpenOrders") ?? "");
      return redirect(
        await navigateToAccountListingsAfterWrite(
          await api.setSellerOrderCapacity(maxOpenOrders),
          settingsDestination(SETTINGS_ACTIONS.setOrderCapacity, { maxOpenOrders: String(maxOpenOrders) }),
        ),
      );
    }

    if (intent === "clear-order-capacity") {
      return redirect(
        await navigateToAccountListingsAfterWrite(
          await api.clearSellerOrderCapacity(),
          settingsDestination(SETTINGS_ACTIONS.clearOrderCapacity),
        ),
      );
    }

    if (intent === "bulk-pause-listings" || intent === "bulk-withdraw-listings") {
      const listingIds = [
        ...new Set(
          formData
            .getAll("listingIds")
            .map((value) => String(value))
            .filter(Boolean),
        ),
      ];
      const bulkActionOutcomes: MarketplaceListingBulkActionOutcome[] = await Promise.all(
        listingIds.map(async (listingId) => {
          try {
            await (intent === "bulk-pause-listings" ? api.pauseListing(listingId) : api.withdrawListing(listingId));
            return {
              listingId,
              label: bulkActionOutcomeLabel(listingId),
              outcome: "success" as const,
              message: null,
            };
          } catch (error) {
            return {
              listingId,
              label: bulkActionOutcomeLabel(listingId),
              outcome: "error" as const,
              message: bulkActionOutcomeErrorMessage(error),
            };
          }
        }),
      );

      return { bulkActionOutcomes };
    }

    return redirect("/account/listings");
  } catch (error) {
    if (error instanceof MarketplaceApiError || error instanceof Error) {
      return {
        error: error.message,
      };
    }

    throw error;
  }
}

export const meta: MetaFunction = () =>
  buildOpenGraphMeta({
    title: t("marketplace.routes.accountListings.listings.marketplace"),
    description: MARKETPLACE_DESCRIPTION,
  });

export default function MarketplaceAccountListingsRoute() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const rootData = useRouteLoaderData("root") as { actor?: { accountId?: string } | null } | undefined;
  const accountId = rootData?.actor?.accountId ?? null;

  if (data.accountAccessRequired) {
    return (
      <AccountAccessRequiredPage
        title={data.accountAccessRequired.title}
        description={data.accountAccessRequired.description}
        returnTo={data.accountAccessRequired.returnTo}
      />
    );
  }

  return (
    <MarketplaceAccountListingsRealtimeView
      key={[
        accountId ?? "anonymous",
        data.listings.total,
        data.listings.items.map((item) => item.listing_id).join("|"),
        data.feeLockReport.total,
        data.feeLockReport.items.map((item) => item.listing_id).join("|"),
        data.listingAvailability.status,
        data.listingAvailability.updated_at,
        data.orderCapacity.updated_at,
        String(data.orderCapacity.max_open_orders),
        String(data.openOrderCount),
        data.filters.status,
        data.filters.search,
      ].join("\n")}
      data={data}
      actionData={actionData}
      accountId={accountId}
    />
  );
}

function AccountAccessRequiredPage({
  title,
  description,
  returnTo,
}: {
  title: string;
  description: string;
  returnTo: string;
}) {
  return (
    <Page>
      <PageHeader
        eyebrow={t("marketplace.routes.accountListings.account.access")}
        title={title}
        description={description}
      />
      <PageSection title={t("marketplace.routes.accountListings.next.step")}>
        <Card>
          <Stack gap={3}>
            <Text>{t("marketplace.routes.accountListings.use.an.account.with.listing.access")}</Text>
            <Stack direction="row" gap={2}>
              <LinkButton href={`/sign-in?returnTo=${encodeURIComponent(returnTo)}`}>
                {t("marketplace.routes.accountListings.use.a.different.account")}
              </LinkButton>
              <LinkButton href="/account" tone="secondary">
                {t("marketplace.routes.accountListings.view.account")}
              </LinkButton>
            </Stack>
          </Stack>
        </Card>
      </PageSection>
    </Page>
  );
}

function MarketplaceAccountListingsRealtimeView({
  data,
  actionData,
  accountId,
}: {
  data: Awaited<ReturnType<typeof loader>>;
  actionData: Exclude<Awaited<ReturnType<typeof action>>, Response> | undefined;
  accountId: string | null;
}) {
  const topics = accountId ? marketplaceRealtimeRouteTopics.accountListings(accountId).topics : [];
  const listings = useRealtimePatchedSnapshot<MarketplaceListingListResponse>({
    initialSnapshot: data.listings as MarketplaceListingListResponse,
    snapshotKey: JSON.stringify(data.listings),
    topics,
    applyPatch: (current, patch) =>
      applyMarketplaceListPatch(current, patch, {
        entity: "marketplace.sellerListing",
        idField: "listing_id",
      }) as MarketplaceListingListResponse,
    onSyncRequired: reloadForRealtimeSync,
  });
  const feeLockReport = useRealtimePatchedSnapshot<ListResponse<MarketplaceListingFeeLockReportEntry>>({
    initialSnapshot: data.feeLockReport as ListResponse<MarketplaceListingFeeLockReportEntry>,
    snapshotKey: JSON.stringify(data.feeLockReport),
    topics,
    applyPatch: (current, patch) =>
      applyMarketplaceListPatch(current, patch, {
        entity: "marketplace.sellerListing",
        idField: "listing_id",
      }),
    onSyncRequired: reloadForRealtimeSync,
  });

  return (
    <MarketplaceListingListPage
      data={listings}
      statusCounts={listings.statusCounts}
      pagination={{ limit: listings.limit, offset: listings.offset, total: listings.total }}
      feeLockReport={feeLockReport}
      listingAvailability={data.listingAvailability as MarketplaceSellerListingAvailability}
      orderCapacity={data.orderCapacity as MarketplaceSellerOrderCapacity}
      openOrderCount={data.openOrderCount}
      filters={data.filters}
      bulkActionOutcomes={actionData?.bulkActionOutcomes ?? null}
      errorMessage={actionData?.error ?? null}
      sellerBehavioralMetrics={data.sellerBehavioralMetrics}
    />
  );
}

function reloadForRealtimeSync() {
  if (typeof window !== "undefined") {
    window.location.reload();
  }
}
