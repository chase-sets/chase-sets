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
  type MarketplaceSellerListingStatusCounts,
} from "../support/request-support/api-client";
import { createSellerMetricsRequestApiClient } from "../support/request-support/seller-metrics-api-client";
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
      disabled_at: null,
      enabled_at: null,
      updated_at: "1970-01-01T00:00:00.000Z",
    },
    filters: { status: "all", search: "" },
    sellerBehavioralMetrics: null,
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
      disabled_at: null,
      enabled_at: null,
      updated_at: "1970-01-01T00:00:00.000Z",
    },
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

  const pageRead = await loadAfterWrite<AccountListingsPageReads>({
    request: resolvedRequest,
    isNotFound: (error) => marketplaceApiErrorStatus(error) === 404,
    load: async () => {
      const [listings, feeLockReport, listingAvailability] = await Promise.all([
        marketplaceApi.listSellerListings(listingsPageQuery),
        marketplaceApi.listSellerListingFeeLockReport(DEFAULT_FEE_LOCK_QUERY),
        marketplaceApi.getSellerListingAvailability(),
      ]);

      return { listings, feeLockReport, listingAvailability };
    },
    telemetry: ACCOUNT_LISTINGS_POST_WRITE_TELEMETRY,
  });

  let pageReads: AccountListingsPageReads;
  if (pageRead.kind === "data") {
    pageReads = pageRead.data;
  } else if (pageRead.kind === "pending" && "classification" in pageRead) {
    const { classification } = pageRead;
    if (pendingAvailabilityStatus && classification.transient && hasMarketplaceFreshWriteSource(classification)) {
      pageReads = createFreshWriteRecoveryPageReads(actor.accountId, pendingAvailabilityStatus);
    } else {
      throw pageRead.error;
    }
  } else if ("error" in pageRead) {
    throw pageRead.error;
  } else {
    throw new Response(t("marketplace.routes.accountListings.listings.marketplace"), { status: 500 });
  }

  const { listings, feeLockReport, listingAvailability } = pageReads;

  // Best-effort, outside the write-freshness machinery above --
  // behavioral metrics have no write path on this page, so there is nothing
  // to stay fresh against; a transient failure degrades the KPI panel to
  // "not enough orders yet" rather than failing the whole listings page.
  const sellerBehavioralMetrics = await fetchSellerBehavioralMetrics(resolvedRequest);

  return {
    accountAccessRequired: null,
    listings,
    feeLockReport,
    listingAvailability,
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
