import { formatBpsPercent, formatMoney } from "@chase-sets/localization";
import { PublicPresencePageShell, publicPresenceT as t } from "@chase-sets/public-presence/web";
import { Grid, Heading, Page, PageHeader, Stack, Surface, Text } from "@chase-sets/design-system";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import { createCommercialTermsPublicRequestApiClient } from "../../support/request-support/api-client";

export const meta: MetaFunction = () => [
  { title: t("publicPresence.routes.sellerFees.meta.title") },
  { name: "description", content: t("publicPresence.routes.sellerFees.meta.description") },
];

export async function loader({ request }: LoaderFunctionArgs) {
  return createCommercialTermsPublicRequestApiClient(request).getMarketplaceSalesFeeSchedule();
}

export default function SalesFeesRoute() {
  const schedule = useLoaderData<typeof loader>().value;
  const percentage = formatBpsPercent(schedule.marketplaceSalesFeePercentageBps);
  const fixedAmount = formatMoney(schedule.marketplaceSalesFeeFixedAmount, "USD");
  const capAmount = formatMoney(schedule.marketplaceSalesFeeCapAmount, "USD");
  const sections = [
    {
      title: t("publicPresence.info.sellerFees.predictable.title"),
      body: t("publicPresence.info.sellerFees.predictable.body", { percentage, fixedAmount, capAmount }),
    },
    {
      title: t("publicPresence.info.sellerFees.lowValue.title"),
      body: t("publicPresence.info.sellerFees.lowValue.body", { fixedAmount }),
    },
    {
      title: t("publicPresence.info.sellerFees.buyerVisibility.title"),
      body: t("publicPresence.info.sellerFees.buyerVisibility.body"),
    },
    {
      title: t("publicPresence.info.sellerFees.founders.title"),
      body: t("publicPresence.info.sellerFees.founders.body"),
    },
    {
      title: t("publicPresence.info.sellerFees.prelaunch.title"),
      body: t("publicPresence.info.sellerFees.prelaunch.body"),
    },
    {
      title: t("publicPresence.info.sellerFees.questions.title"),
      body: t("publicPresence.info.sellerFees.questions.body"),
    },
  ];

  return (
    <PublicPresencePageShell>
      <Page>
        <PageHeader
          eyebrow={t("publicPresence.info.sellerFees.eyebrow")}
          title={t("publicPresence.info.sellerFees.title")}
          description={t("publicPresence.info.sellerFees.description")}
        />
        <Grid columns={{ base: 1, md: 2 }} gap={4}>
          {sections.map((section) => (
            <Surface key={section.title} elevated>
              <Stack gap={3}>
                <Heading level={2}>{section.title}</Heading>
                <Text tone="secondary">{section.body}</Text>
              </Stack>
            </Surface>
          ))}
        </Grid>
      </Page>
    </PublicPresencePageShell>
  );
}
