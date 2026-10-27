import type { ReactNode } from "react";
import type { NavigateFunction } from "react-router";
import { Banner, LinkButton, Page, PageHeader, PageSection, Skeleton, Stack } from "@chase-sets/design-system";
import type { ApplyGoalResult, PricingHealthData } from "../api/services";
import { HealthSummary } from "./health-summary";
import { ForecastGradePanel } from "./forecast-grade-panel";
import { healthCopy as copy } from "./copy";
import { GoalComparison, GoalPicker } from "./goal-comparison";
import { PricingHealthWhatIfPanels } from "./what-if-panels";

export function PricingHealthPage({
  data,
  loading = false,
  error,
  policySelector,
  computeAction,
  compareAction,
  applyAction,
  applyResult,
  goalNavigate,
}: Readonly<{
  data: PricingHealthData | null;
  loading?: boolean;
  error?: string;
  policySelector?: ReactNode;
  computeAction?: ReactNode;
  compareAction?: ReactNode;
  applyAction?: (candidate: NonNullable<PricingHealthData["comparison"]>[number]) => ReactNode;
  applyResult?: ApplyGoalResult | null;
  goalNavigate?: NavigateFunction;
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
        {applyResult ? (
          <Banner
            tone="success"
            title={copy("goals.applied")}
            description={copy("goals.applied.description", {
              revision: applyResult.revision,
              raised: applyResult.movement.raised,
              lowered: applyResult.movement.lowered,
              held: applyResult.movement.held,
              floorBinding: applyResult.alerts.floorBinding,
            })}
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
                actions={<LinkButton href="/account/desk/repricing?create=1">{copy("create")}</LinkButton>}
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
                    <GoalPicker goals={data.goals ?? []} navigate={goalNavigate} />
                    <PageSection title={copy("goals.comparison")} actions={compareAction}>
                      <GoalComparison
                        branch={(data.branch ?? "comparison") as "comparison" | "advanced-editor" | "create-editor"}
                        candidates={data.comparison ?? []}
                        goals={data.goals ?? []}
                        targetPolicyId={data.target.policyId}
                        recommendation={data.recommendation ?? { kind: "compare-goals" }}
                        applyAction={applyAction}
                      />
                    </PageSection>
                    <PageSection title={copy("whatIf.title")} description={copy("whatIf.description")}>
                      <PricingHealthWhatIfPanels data={data.whatIf} />
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
