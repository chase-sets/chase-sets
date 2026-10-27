import type { ReactNode } from "react";
import { formatDateTime, formatMoney } from "@chase-sets/localization";
import {
  Banner,
  Card,
  DataTable,
  Fieldset,
  KeyValueList,
  LinkButton,
  ProgressiveDisclosure,
  Stack,
  Text,
  TextInput,
} from "@chase-sets/design-system";
import { useState } from "react";
import type { NavigateFunction } from "react-router";
import type { CandidateMetrics, GoalChoice, Recommendation } from "../api/goal-comparison";
import {
  goalExplanation,
  goalLabel,
  healthCopy as copy,
  healthNumber,
  healthPercent,
  healthReasonLabel,
  localizedEconomicsFact,
  localizedEconomicsReason,
  localizedEconomicsSource,
  localizedGoalStatus,
  recommendationCopy,
} from "./copy";

export function GoalPicker({
  goals,
  navigate,
}: Readonly<{ goals: readonly GoalChoice[]; navigate?: NavigateFunction }>) {
  const [parameters, setParameters] = useState(() =>
    Object.fromEntries(goals.map((goal) => [`${goal.goalId}@${goal.goalVersion}`, { ...goal.parameters }])),
  );
  const updateUrl = (next: typeof parameters) => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    url.searchParams.set(
      "goals",
      JSON.stringify(
        goals.map((goal) => ({
          goalId: goal.goalId,
          goalVersion: goal.goalVersion,
          parameters: next[`${goal.goalId}@${goal.goalVersion}`] ?? goal.parameters,
        })),
      ),
    );
    if (navigate) void navigate(`${url.pathname}${url.search}`, { replace: true });
    else window.history.replaceState({}, "", url);
  };
  return (
    <Card elevation="tinted" data-testid="pricing-health-goal-picker">
      <Card.Header>
        <Card.Title>{copy("goals.title")}</Card.Title>
        <Card.Description>{copy("goals.description")}</Card.Description>
      </Card.Header>
      <Card.Body>
        {goals.length === 0 ? (
          <Banner tone="info" title={copy("goals.empty")} />
        ) : (
          <Stack gap={3}>
            {goals.map((goal) => {
              const key = `${goal.goalId}@${goal.goalVersion}`;
              const current = parameters[key] ?? goal.parameters;
              return (
                <Fieldset key={key} legend={goalLabel({ ...goal, parameters: current })}>
                  <Text size="sm">{goalExplanation({ ...goal, parameters: current })}</Text>
                  <ProgressiveDisclosure
                    title={copy("goals.advanced")}
                    panelLabel={`${goalLabel({ ...goal, parameters: current })} (${goal.goalId}@${goal.goalVersion})`}
                  >
                    <Stack gap={2}>
                      {Object.entries(goal.parameterSchema).map(([parameter, bounds]) => {
                        const value = current[parameter] ?? bounds.default;
                        const invalid = !Number.isFinite(value) || value < bounds.minimum || value > bounds.maximum;
                        return (
                          <TextInput
                            key={parameter}
                            type="number"
                            label={healthCopyParameterLabel(goal, parameter)}
                            name={`goal.${goal.goalId}.${goal.goalVersion}.${parameter}`}
                            value={Number.isNaN(value) ? "" : String(value)}
                            min={bounds.minimum}
                            max={bounds.maximum}
                            step="any"
                            error={invalid ? copy("goals.validation") : undefined}
                            onChange={(event) => {
                              const next = {
                                ...parameters,
                                [key]: { ...current, [parameter]: Number(event.target.value) },
                              };
                              setParameters(next);
                              const nextValues = next[key] ?? current;
                              if (
                                Object.entries(goal.parameterSchema).every(([name, schema]) => {
                                  const candidate = nextValues[name];
                                  return (
                                    Number.isFinite(candidate) &&
                                    candidate >= schema.minimum &&
                                    candidate <= schema.maximum
                                  );
                                })
                              )
                                updateUrl(next);
                            }}
                          />
                        );
                      })}
                    </Stack>
                    {goal.requiresEconomics ? (
                      <>
                        <Text size="sm">
                          {goal.economics?.availability === "resolved"
                            ? copy("goals.economics.provenance")
                            : copy("goals.economics.unavailable")}
                        </Text>
                        {goal.economics?.facts ? (
                          <KeyValueList
                            items={Object.entries(goal.economics.facts).map(([name, fact]) => ({
                              key: localizedEconomicsFact(name),
                              value: `${formatFactValue(fact.effectiveValue)} · ${localizedEconomicsSource(
                                fact.source,
                              )}${fact.sourceReason ? ` · ${localizedEconomicsReason(fact.sourceReason)}` : ""}${
                                fact.override ? ` · ${copy("goals.economics.override")}` : ""
                              } · ${formatDateTime(fact.observedAt)}`,
                            }))}
                          />
                        ) : null}
                      </>
                    ) : (
                      <Text size="sm">{copy("goals.economics.default")}</Text>
                    )}
                  </ProgressiveDisclosure>
                </Fieldset>
              );
            })}
          </Stack>
        )}
      </Card.Body>
    </Card>
  );
}

function healthCopyParameterLabel(goal: GoalChoice, parameter: string): string {
  return copy(`goals.parameter.${goal.goalId}.${parameter}`) || parameter;
}

function formatFactValue(value: unknown): string {
  if (value && typeof value === "object" && "amount" in value && "currency" in value) {
    const money = value as { amount: string; currency: string };
    return formatMoney(money.amount, money.currency);
  }
  return String(value);
}

export function GoalComparison({
  branch,
  candidates,
  recommendation,
  goals = [],
  targetPolicyId,
  applyAction,
}: Readonly<{
  branch: "comparison" | "advanced-editor" | "create-editor";
  candidates: readonly CandidateMetrics[];
  recommendation: Recommendation;
  goals?: readonly GoalChoice[];
  targetPolicyId?: string;
  applyAction?: (candidate: CandidateMetrics) => ReactNode;
}>) {
  if (branch === "advanced-editor")
    return (
      <Banner
        tone="info"
        title={copy("goals.advancedEditor")}
        description={copy("goals.noComparison")}
        actions={
          <LinkButton href={`/account/desk/repricing/${encodeURIComponent(targetPolicyId ?? "")}?edit=1`}>
            {copy("goals.advancedEditor")}
          </LinkButton>
        }
      />
    );
  if (branch === "create-editor")
    return (
      <Banner
        tone="info"
        title={copy("goals.createEditor")}
        description={copy("goals.noComparison")}
        actions={<LinkButton href="/account/desk/repricing?create=1">{copy("create")}</LinkButton>}
      />
    );
  return (
    <Stack gap={4} data-testid="pricing-health-goal-comparison">
      <Banner
        tone={recommendation.kind === "switch" ? "success" : "info"}
        title={recommendationCopy(recommendation, goals)}
      />
      <Stack gap={0} minWidth="0">
        <DataTable
          rows={[...candidates]}
          getRowId={(row) => `${row.goalId}@${row.goalVersion}`}
          caption={copy("goals.comparison")}
          mobileMode="scroll"
          emptyTitle={copy("goals.compareEmpty")}
          columns={[
            {
              key: "goal",
              header: copy("goals.goal"),
              cell: (row) => {
                const goal = goals.find((goal) => goal.goalId === row.goalId && goal.goalVersion === row.goalVersion);
                return goal ? goalLabel(goal) : copy("goals.label.generic");
              },
            },
            { key: "scope", header: copy("goals.scope"), cell: () => copy("goals.entireScope") },
            { key: "listings", header: copy("goals.listings"), cell: (row) => row.listingCount ?? copy("unavailable") },
            {
              key: "target",
              header: copy("goals.targetRevision"),
              cell: (row) => (
                <Text as="span" size="sm" wrap="anywhere">
                  {copy("goals.targetRevision.value", { policy: row.targetPolicyId, revision: row.targetRevision })}
                </Text>
              ),
            },
            { key: "requestedAt", header: copy("goals.requestedAt"), cell: (row) => formatDateTime(row.requestedAt) },
            {
              key: "hash",
              header: copy("goals.bodyHash"),
              cell: (row) => (
                <Text as="span" size="sm" wrap="anywhere">
                  {row.bodyHash}
                </Text>
              ),
            },
            { key: "status", header: copy("goals.status"), cell: (row) => localizedGoalStatus(row.status) },
            {
              key: "value",
              header: copy("goals.value"),
              cell: (row) =>
                Object.entries(row.value ?? {})
                  .map(([currency, value]) => formatMoney(value, currency))
                  .join(", ") || copy("unavailable"),
            },
            {
              key: "wait",
              header: copy("goals.wait"),
              cell: (row) =>
                Object.entries(row.medianWaitDays ?? {})
                  .map(([currency, value]) => `${currency} ${healthNumber(value)}`)
                  .join(", ") || copy("unavailable"),
            },
            {
              key: "coverage",
              header: copy("goals.coverage"),
              cell: (row) =>
                Object.entries(row.coverage ?? {})
                  .map(([currency, value]) => `${currency} ${healthPercent(value)}`)
                  .join(", ") || copy("unavailable"),
            },
            {
              key: "p90",
              header: copy("goals.p90"),
              cell: (row) =>
                Object.entries(row.p90WaitDays ?? {})
                  .map(([currency, value]) => `${currency} ${healthNumber(value)}`)
                  .join(", ") || copy("unavailable"),
            },
            {
              key: "bounds",
              header: copy("goals.bounds"),
              cell: (row) =>
                Object.entries(row.boundStatusCount ?? {})
                  .map(([currency, value]) => `${currency} ${healthNumber(value)}`)
                  .join(", ") || copy("unavailable"),
            },
            {
              key: "profit",
              header: copy("goals.profit"),
              cell: (row) =>
                Object.entries(row.profitPerDay ?? {})
                  .map(([currency, value]) => `${currency} ${healthNumber(value)}`)
                  .join(", ") || copy("unavailable"),
            },
            {
              key: "movement",
              header: copy("goals.movement"),
              cell: (row) =>
                `${copy("goals.raised")}: ${row.raised ?? "—"}; ${copy("goals.lowered")}: ${row.lowered ?? "—"}; ${copy("goals.held")}: ${row.held ?? "—"}`,
            },
            {
              key: "reasons",
              header: copy("goals.heldReasons"),
              cell: (row) =>
                Object.entries(row.heldReasons)
                  .map(([reason, count]) => `${healthReasonLabel(reason)}: ${count}`)
                  .join(", "),
            },
            ...(applyAction
              ? [
                  {
                    key: "apply",
                    header: copy("goals.apply"),
                    cell: (row: CandidateMetrics) => (row.status === "completed" ? applyAction(row) : null),
                  },
                ]
              : []),
          ]}
        />
      </Stack>
    </Stack>
  );
}
