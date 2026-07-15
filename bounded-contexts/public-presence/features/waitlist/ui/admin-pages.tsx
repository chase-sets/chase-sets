import { formatDateTime, t } from "@chase-sets/localization";
import {
  Form,
  Badge,
  Button,
  DataTable,
  Grid,
  Inline,
  LinkButton,
  NativeSelect,
  Page,
  PageHeader,
  PageSection,
  SearchInput,
  Stack,
  Stat,
  StatGrid,
  Text,
} from "@chase-sets/design-system";
import type { WaitlistMetrics, WaitlistSignupListItem } from "../api/contracts";

type ListResponse<T> = Readonly<{
  items: readonly T[];
  total: number;
  count: number;
}>;

const roleItems = [
  { value: "all", label: t("publicPresence.admin.allRoles") },
  { value: "buy", label: t("publicPresence.waitlist.role.buy") },
  { value: "sell", label: t("publicPresence.waitlist.role.sell") },
  { value: "both", label: t("publicPresence.waitlist.role.both") },
];

const interestItems = [
  { value: "all", label: t("publicPresence.admin.allInterests") },
  { value: "low-sales-fees", label: t("publicPresence.waitlist.interest.lowSellerFees") },
  { value: "bulk-listing", label: t("publicPresence.waitlist.interest.bulkListing") },
  { value: "set-completion", label: t("publicPresence.waitlist.interest.setCompletion") },
  { value: "pricing-tools", label: t("publicPresence.waitlist.interest.pricingTools") },
  { value: "efficient-shipping", label: t("publicPresence.waitlist.interest.efficientShipping") },
];

const sortItems = [
  { value: "updated", label: t("publicPresence.admin.sort.updated") },
  { value: "referrals", label: t("publicPresence.admin.sort.referrals") },
];

function roleLabel(value: string) {
  return roleItems.find((item) => item.value === value)?.label ?? value;
}

function interestLabel(value: string) {
  return interestItems.find((item) => item.value === value)?.label ?? value;
}

export function WaitlistAdminPage({
  signups,
  metrics,
  filters,
  exportHref,
}: {
  signups: ListResponse<WaitlistSignupListItem>;
  metrics: WaitlistMetrics;
  filters: Readonly<{ role: string; interest: string; search: string; sort: string }>;
  exportHref: string;
}) {
  return (
    <Page>
      <PageHeader
        eyebrow={t("publicPresence.admin.eyebrow")}
        title={t("publicPresence.admin.title")}
        description={t("publicPresence.admin.description")}
        actions={
          <LinkButton href={exportHref} tone="secondary" leadingIcon="externalLink">
            {t("publicPresence.admin.export")}
          </LinkButton>
        }
      />
      <StatGrid columns={{ base: 1, md: 4 }}>
        <Stat label={t("publicPresence.admin.total")} value={metrics.total_count} />
        <Stat label={t("publicPresence.waitlist.role.buy")} value={metrics.buy_count} />
        <Stat label={t("publicPresence.waitlist.role.sell")} value={metrics.sell_count} />
        <Stat label={t("publicPresence.waitlist.role.both")} value={metrics.both_count} />
      </StatGrid>
      <PageSection
        title={t("publicPresence.admin.waveFill.title")}
        description={t("publicPresence.admin.waveFill.description")}
      >
        <StatGrid columns={{ base: 1, md: 3 }}>
          {metrics.wave_fill.map((wave) => (
            <Stat
              key={wave.waveNumber}
              label={t("publicPresence.admin.waveFill.wave", { waveNumber: wave.waveNumber })}
              value={t("publicPresence.admin.waveFill.value", {
                admittedCount: wave.admittedCount,
                capacity: wave.capacity,
              })}
            />
          ))}
        </StatGrid>
      </PageSection>
      <PageSection title={t("publicPresence.admin.filters")}>
        <Form spacing="none" method="get">
          <Grid columns={{ base: 1, md: 4, lg: 5 }} gap={3}>
            <SearchInput label={t("publicPresence.admin.search")} name="search" defaultValue={filters.search} />
            <NativeSelect
              label={t("publicPresence.admin.role")}
              name="role"
              defaultValue={filters.role}
              items={roleItems}
            />
            <NativeSelect
              label={t("publicPresence.admin.interest")}
              name="interest"
              defaultValue={filters.interest}
              items={interestItems}
            />
            <NativeSelect
              label={t("publicPresence.admin.sort")}
              name="sort"
              defaultValue={filters.sort}
              items={sortItems}
            />
            <Stack gap={1}>
              <Button type="submit" leadingIcon="filter">
                {t("publicPresence.admin.applyFilters")}
              </Button>
            </Stack>
          </Grid>
        </Form>
      </PageSection>
      <PageSection title={t("publicPresence.admin.signups")}>
        <DataTable<WaitlistSignupListItem>
          columns={[
            {
              key: "updated_at",
              header: t("publicPresence.admin.updated"),
              cell: (item) => formatDateTime(item.updated_at),
            },
            {
              key: "email",
              header: t("publicPresence.admin.email"),
              cell: (item) => item.email,
            },
            {
              key: "role",
              header: t("publicPresence.admin.role"),
              cell: (item) => <Badge tone="accent">{roleLabel(item.role)}</Badge>,
            },
            {
              key: "interests",
              header: t("publicPresence.admin.interests"),
              cell: (item) => (
                <Inline gap={1}>
                  {item.interests.map((interest) => (
                    <Badge key={interest} tone="neutral">
                      {interestLabel(interest)}
                    </Badge>
                  ))}
                </Inline>
              ),
            },
            {
              key: "referral_count",
              header: t("publicPresence.admin.referrals"),
              cell: (item) => (item.referral_count > 0 ? <Badge tone="success">{item.referral_count}</Badge> : "0"),
            },
            {
              key: "referred_by_signup_id",
              header: t("publicPresence.admin.referred"),
              cell: (item) => (item.referred_by_signup_id ? t("publicPresence.admin.referred.yes") : ""),
            },
            {
              key: "source",
              header: t("publicPresence.admin.source"),
              cell: (item) => item.utm_source ?? item.referrer ?? item.page_path,
            },
          ]}
          rows={[...signups.items]}
          getRowId={(item) => item.signup_id}
          emptyTitle={t("publicPresence.admin.emptyTitle")}
          emptyDescription={t("publicPresence.admin.emptyDescription")}
        />
        <Text tone="secondary" size="sm">
          {t("publicPresence.admin.countSummary", {
            count: signups.count,
            total: signups.total,
          })}
        </Text>
      </PageSection>
    </Page>
  );
}
