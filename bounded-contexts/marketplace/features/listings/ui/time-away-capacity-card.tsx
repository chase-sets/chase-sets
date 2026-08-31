import { formatDateTime, t } from "@chase-sets/localization";
import { useEffect, useState, type FormEvent } from "react";
import {
  Badge,
  Button,
  Card,
  Form,
  Grid,
  HiddenInput,
  Inline,
  MarketplaceNotice,
  NativeSelect,
  Stack,
  Text,
  TextInput,
} from "@chase-sets/design-system";
import type { MarketplaceSellerListingAvailability, MarketplaceSellerOrderCapacity } from "./contracts";

/**
 * Everything the "Time away & order capacity" card needs to render, in one
 * snapshot. `openOrderCount` is the authoritative Ordering-sourced "N" for the
 * "N of M" display (null when that cross-context read was unavailable);
 * `activeListingCount` drives the impact preview. The card is the single home
 * for these seller controls and is placement-agnostic -- it takes only this
 * data and posts intents to whatever route mounts it, so the m93 Seller Desk
 * can host it unchanged.
 */
export interface TimeAwayCapacitySnapshot {
  availability: MarketplaceSellerListingAvailability;
  orderCapacity: MarketplaceSellerOrderCapacity;
  openOrderCount: number | null;
  activeListingCount: number;
}

function availabilityTone(status: MarketplaceSellerListingAvailability["status"]) {
  return status === "available" ? "success" : "warning";
}

function availabilityReasonLabel(reason: string | null) {
  switch (reason) {
    case "travel":
      return t("marketplace.features.listings.ui.listingListPage.reason.travel");
    case "audit":
      return t("marketplace.features.listings.ui.listingListPage.reason.audit");
    case "operations":
      return t("marketplace.features.listings.ui.listingListPage.reason.operations");
    case "other":
      return t("marketplace.features.listings.ui.listingListPage.reason.other");
    default:
      return t("marketplace.features.listings.ui.listingListPage.reason.not.set");
  }
}

// The domain accepts only a fully-formed instant and never guesses a
// timezone server-side, so the date `<input>` is converted here, in the
// browser, using the seller's own local clock -- "back on July 20" means
// listings resume the morning of the 20th in the seller's own timezone. This
// only ever runs from a hydrated browser form submission, so it never executes
// during server rendering (where "local" would mean the server's timezone).
function localDateInputToInstant(value: string): string {
  if (!value) {
    return "";
  }

  const localMidnight = new Date(`${value}T00:00:00`);
  return Number.isNaN(localMidnight.valueOf()) ? "" : localMidnight.toISOString();
}

type LocalDateInstantField = Readonly<{
  dateFieldName: string;
  instantFieldName: string;
}>;

function populateLocalDateInstants(event: FormEvent<HTMLFormElement>, fields: readonly LocalDateInstantField[]): void {
  for (const { dateFieldName, instantFieldName } of fields) {
    const dateField = event.currentTarget.elements.namedItem(dateFieldName);
    const instantField = event.currentTarget.elements.namedItem(instantFieldName);

    if (dateField instanceof HTMLInputElement && instantField instanceof HTMLInputElement) {
      instantField.value = localDateInputToInstant(dateField.value);
    }
  }
}

function useFormHydrated(): boolean {
  const [isHydrated, setIsHydrated] = useState(false);

  useEffect(() => {
    setIsHydrated(true);
  }, []);

  return isHydrated;
}

function reasonItems() {
  return [
    { value: "", label: t("marketplace.features.listings.ui.listingListPage.reason.not.set") },
    { value: "travel", label: t("marketplace.features.listings.ui.listingListPage.reason.travel") },
    { value: "audit", label: t("marketplace.features.listings.ui.listingListPage.reason.audit") },
    { value: "operations", label: t("marketplace.features.listings.ui.listingListPage.reason.operations") },
    { value: "other", label: t("marketplace.features.listings.ui.listingListPage.reason.other") },
  ];
}

function AvailabilitySection({ availability, activeListingCount }: TimeAwayCapacitySnapshot) {
  const isFormHydrated = useFormHydrated();
  const isAvailable = availability.status === "available";

  return (
    <Stack gap={4}>
      <Stack gap={2}>
        <Inline align="center">
          <Badge tone={availabilityTone(availability.status)}>
            {isAvailable
              ? t("marketplace.features.listings.ui.listingListPage.listings.available")
              : t("marketplace.features.listings.ui.listingListPage.listings.unavailable")}
          </Badge>
          <Text weight="semibold">
            {t("marketplace.features.listings.ui.listingListPage.account.wide.listing.control")}
          </Text>
        </Inline>
        <Text tone="secondary">
          {isAvailable
            ? t("marketplace.features.listings.ui.listingListPage.availability.available.description")
            : t("marketplace.features.listings.ui.listingListPage.availability.unavailable.description", {
                reason: availabilityReasonLabel(availability.disabled_reason_category),
                date:
                  availability.available_again_on ??
                  t("marketplace.features.listings.ui.listingListPage.no.return.date"),
              })}
        </Text>
        {!isAvailable && availability.available_again_at ? (
          <MarketplaceNotice
            tone="info"
            title={t("marketplace.features.listings.ui.listingListPage.scheduled.restore.title")}
            description={t("marketplace.features.listings.ui.listingListPage.scheduled.restore.notice", {
              date: formatDateTime(availability.available_again_at),
            })}
          />
        ) : null}
      </Stack>

      <Grid columns={{ base: 1, lg: 2 }} gap={5}>
        <Stack gap={3}>
          {isAvailable ? (
            <MarketplaceNotice
              tone="info"
              title={t("marketplace.features.listings.ui.listingListPage.impact.preview.title")}
              description={t("marketplace.features.listings.ui.listingListPage.impact.preview.description", {
                count: activeListingCount,
              })}
            />
          ) : (
            <Form spacing="none" method="post">
              <Button type="submit" name="intent" value="enable-listing-availability">
                {t("marketplace.features.listings.ui.listingListPage.turn.on.listings")}
              </Button>
            </Form>
          )}
        </Stack>
        <Form
          spacing="none"
          method="post"
          onSubmit={(event) =>
            populateLocalDateInstants(event, [
              { dateFieldName: "availableAgainOn", instantFieldName: "availableAgainAt" },
            ])
          }
        >
          <Stack gap={3}>
            <Grid columns={{ base: 1, md: 2 }} gap={3}>
              <NativeSelect
                label={t("marketplace.features.listings.ui.listingListPage.reason")}
                name="reasonCategory"
                defaultValue={availability.disabled_reason_category ?? ""}
                items={reasonItems()}
              />
              <TextInput
                label={t("marketplace.features.listings.ui.listingListPage.available.again.on")}
                name="availableAgainOn"
                type="date"
                defaultValue={availability.available_again_on ?? undefined}
              />
            </Grid>
            <HiddenInput type="hidden" name="availableAgainAt" defaultValue="" />
            <Inline>
              <Button
                type="submit"
                name="intent"
                value="disable-listing-availability"
                tone="secondary"
                disabled={!isFormHydrated}
              >
                {isAvailable
                  ? t("marketplace.features.listings.ui.listingListPage.turn.off.listings")
                  : t("marketplace.features.listings.ui.listingListPage.update.away.settings")}
              </Button>
            </Inline>
          </Stack>
        </Form>
      </Grid>
    </Stack>
  );
}

function AwayWindowSection({ availability }: TimeAwayCapacitySnapshot) {
  const isFormHydrated = useFormHydrated();

  return (
    <Stack gap={3}>
      <Text weight="semibold">{t("marketplace.features.listings.ui.listingListPage.away.window")}</Text>
      {availability.away_window_starts_at ? (
        <Stack gap={3}>
          <Text tone="secondary">
            {t("marketplace.features.listings.ui.listingListPage.away.window.scheduled.description", {
              reason: availabilityReasonLabel(availability.away_window_reason_category),
              startDate: formatDateTime(availability.away_window_starts_at),
              endDate: availability.away_window_ends_at
                ? formatDateTime(availability.away_window_ends_at)
                : t("marketplace.features.listings.ui.listingListPage.no.return.date"),
            })}
          </Text>
          <MarketplaceNotice
            tone="info"
            title={t("marketplace.features.listings.ui.listingListPage.scheduled.restore.title")}
            description={
              availability.away_window_ends_at
                ? t("marketplace.features.listings.ui.listingListPage.scheduled.restore.notice.window", {
                    startDate: formatDateTime(availability.away_window_starts_at),
                    endDate: formatDateTime(availability.away_window_ends_at),
                  })
                : t("marketplace.features.listings.ui.listingListPage.scheduled.restore.notice.window.indefinite", {
                    startDate: formatDateTime(availability.away_window_starts_at),
                  })
            }
          />
          <Form spacing="none" method="post">
            <Button type="submit" name="intent" value="cancel-away-window" tone="secondary">
              {t("marketplace.features.listings.ui.listingListPage.cancel.away.window")}
            </Button>
          </Form>
        </Stack>
      ) : availability.status === "available" ? (
        <Form
          spacing="none"
          method="post"
          onSubmit={(event) =>
            populateLocalDateInstants(event, [
              { dateFieldName: "awayWindowStartsOn", instantFieldName: "awayWindowStartsAt" },
              { dateFieldName: "awayWindowEndsOn", instantFieldName: "awayWindowEndsAt" },
            ])
          }
        >
          <Stack gap={3}>
            <Text tone="secondary">
              {t("marketplace.features.listings.ui.listingListPage.away.window.description")}
            </Text>
            <Grid columns={{ base: 1, md: 3 }} gap={3}>
              <NativeSelect
                label={t("marketplace.features.listings.ui.listingListPage.reason")}
                name="awayWindowReasonCategory"
                defaultValue=""
                items={reasonItems()}
              />
              <TextInput
                label={t("marketplace.features.listings.ui.listingListPage.away.window.starts.on")}
                name="awayWindowStartsOn"
                type="date"
              />
              <TextInput
                label={t("marketplace.features.listings.ui.listingListPage.away.window.ends.on")}
                name="awayWindowEndsOn"
                type="date"
              />
            </Grid>
            <HiddenInput type="hidden" name="awayWindowStartsAt" defaultValue="" />
            <HiddenInput type="hidden" name="awayWindowEndsAt" defaultValue="" />
            <Inline>
              <Button
                type="submit"
                name="intent"
                value="schedule-away-window"
                tone="secondary"
                disabled={!isFormHydrated}
              >
                {t("marketplace.features.listings.ui.listingListPage.schedule.away.window")}
              </Button>
            </Inline>
          </Stack>
        </Form>
      ) : (
        <Text tone="secondary">
          {t("marketplace.features.listings.ui.listingListPage.away.window.unavailable.while.away")}
        </Text>
      )}
    </Stack>
  );
}

function OrderCapacitySection({ orderCapacity, openOrderCount }: TimeAwayCapacitySnapshot) {
  const cap = orderCapacity.max_open_orders;
  const hasCap = cap !== null;

  return (
    <Stack gap={3}>
      <Text weight="semibold">{t("marketplace.features.listings.ui.listingListPage.order.capacity")}</Text>
      <Text tone="secondary">{t("marketplace.features.listings.ui.listingListPage.order.capacity.description")}</Text>

      <Stack gap={1}>
        <Text>
          {hasCap
            ? t("marketplace.features.listings.ui.listingListPage.order.capacity.current", { cap: cap })
            : t("marketplace.features.listings.ui.listingListPage.order.capacity.unlimited")}
        </Text>
        {/* Read-only "N of M" -- N is counted by Ordering (open-claims
            ledger), never derived client-side; M is this account's own cap. */}
        {openOrderCount === null ? (
          <Text tone="secondary" size="sm">
            {t("marketplace.features.listings.ui.listingListPage.order.capacity.open.orders.unavailable")}
          </Text>
        ) : (
          <Text tone="secondary" size="sm">
            {hasCap
              ? t("marketplace.features.listings.ui.listingListPage.order.capacity.open.orders.now", {
                  count: openOrderCount,
                  cap: cap,
                })
              : t("marketplace.features.listings.ui.listingListPage.order.capacity.open.orders.now.unlimited", {
                  count: openOrderCount,
                })}
          </Text>
        )}
        <Text tone="secondary" size="sm">
          {t("marketplace.features.listings.ui.listingListPage.order.capacity.sourced.from.ordering")}
        </Text>
      </Stack>

      <Form spacing="none" method="post">
        <Stack gap={3}>
          <Grid columns={{ base: 1, md: 2 }} gap={3}>
            <TextInput
              label={t("marketplace.features.listings.ui.listingListPage.order.capacity.max.open.orders")}
              name="maxOpenOrders"
              type="number"
              min={1}
              defaultValue={hasCap ? String(cap) : undefined}
            />
          </Grid>
          <Inline>
            <Button type="submit" name="intent" value="set-order-capacity" tone="secondary">
              {t("marketplace.features.listings.ui.listingListPage.order.capacity.set")}
            </Button>
            {hasCap ? (
              <Button type="submit" name="intent" value="clear-order-capacity" tone="secondary">
                {t("marketplace.features.listings.ui.listingListPage.order.capacity.clear")}
              </Button>
            ) : null}
          </Inline>
        </Stack>
      </Form>
    </Stack>
  );
}

/**
 * The single "Time away & order capacity" surface: availability status and
 * controls, scheduled away windows, and Order Capacity -- one deep-module card
 * composing every state internally (available; away-with-date; away-indefinite;
 * window-scheduled; at-capacity; capacity-unset). Design-system components
 * only; all copy localized.
 */
export function TimeAwayCapacityCard(snapshot: TimeAwayCapacitySnapshot) {
  return (
    <Card elevation="tinted">
      <Stack gap={6}>
        <AvailabilitySection {...snapshot} />
        <AwayWindowSection {...snapshot} />
        <OrderCapacitySection {...snapshot} />
      </Stack>
    </Card>
  );
}
