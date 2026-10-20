import type { ReactNode } from "react";
import { Banner, LinkButton, Page, PageHeader, PageSection, Skeleton, Stack } from "@chase-sets/design-system";
import type { PricingHealthData } from "../api/services";
import { HealthSummary } from "./health-summary";
import { ForecastGradePanel } from "./forecast-grade-panel";
import { healthCopy as copy } from "./copy";
import { GoalComparison, GoalPicker } from "./goal-comparison";

export function PricingHealthPage({
  data,
  loading = false,
  error,
  policySelector,
  computeAction,
  compareAction,
}: Readonly<{
  data: PricingHealthData | null;
  loading?: boolean;
  error?: string;
  policySelector?: ReactNode;
  computeAction?: ReactNode;
  compareAction?: ReactNode;
}>) {
  return (
    <Page>
      <PageHeader
        title={copy("title")}
        description={copy("description")}
        actions={
          <LinkButton href="/account/desk/repricing" tone="secondary">
            {copy("back")}
          </LinkButton>
        }
      />
      <Stack gap={6} data-testid="pricing-health-page" aria-busy={loading}>
        {error ? (
          <Banner
            role="alert"
            tone="danger"
            title={copy("error")}
            description={error}
            actions={
              <LinkButton href="" tone="secondary">
                {copy("retry")}
              </LinkButton>
            }
          />
        ) : null}
        {loading ? (
          <>
            <Banner tone="info" title={copy("loading")} />
            <Skeleton height="lg" />
          </>
        ) : null}
        {data && !loading ? (
          <>
            {data.policies.length === 0 ? (
              <Banner
                tone="info"
                title={copy("noPolicy")}
                actions={<LinkButton href="/account/desk/repricing">{copy("create")}</LinkButton>}
              />
            ) : (
              <>
                {policySelector}
                {!data.target ? (
                  <Banner tone="info" title={copy("selectPolicy")} />
                ) : (
                  <>
                    <PageSection title={data.target.name} actions={computeAction}>
                      {data.computing ? <Banner tone="info" title={copy("computing")} /> : null}
                      {data.health ? (
                        <HealthSummary health={data.health} run={data.run} />
                      ) : (
                        <Banner tone="info" title={copy("noVerdict")} description={copy("noVerdict.description")} />
                      )}
                    </PageSection>
                    <GoalPicker goals={data.goals ?? []} />
                    <PageSection title={copy("goals.comparison")} actions={compareAction}>
                      <GoalComparison
                        branch={(data.branch ?? "comparison") as "comparison" | "advanced-editor" | "create-editor"}
                        candidates={data.comparison ?? []}
                        recommendation={data.recommendation ?? { kind: "compare-goals", text: copy("goals.compare") }}
                      />
                    </PageSection>
                    <PageSection title={copy("grades.title")} description={copy("grades.platform")}>
                      <ForecastGradePanel grades={data.grades} />
                    </PageSection>
                  </>
                )}
              </>
            )}
          </>
        ) : null}
      </Stack>
    </Page>
  );
}
