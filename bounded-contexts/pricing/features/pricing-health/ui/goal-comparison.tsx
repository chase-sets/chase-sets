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
import type { CandidateMetrics, GoalChoice, Recommendation } from "../api/goal-comparison";
import { goalExplanation, goalLabel, healthCopy as copy, healthReasonLabel, recommendationCopy } from "./copy";

export function GoalPicker({ goals }: Readonly<{ goals: readonly GoalChoice[] }>) {
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
    window.history.replaceState({}, "", url);
  };
  return (
    <Card data-testid="pricing-health-goal-picker">
      <Card.Header>
        <Card.Title>{copy("goals.title")}</Card.Title>
        <Card.Description>{copy("goals.description")}</Card.Description>
      </Card.Header>
      <Card.Body>
        {goals.length === 0 ? (
          <Banner tone="info" title={copy("goals.empty")} />
        ) : (
          <Stack gap={3}>
            {goals.map((goal) => (
              <Fieldset
                key={`${goal.goalId}@${goal.goalVersion}`}
                legend={goalLabel({
                  ...goal,
                  parameters: parameters[`${goal.goalId}@${goal.goalVersion}`] ?? goal.parameters,
                })}
              >
                <Text size="sm">{goalExplanation(goal)}</Text>
                <ProgressiveDisclosure title={copy("goals.advanced")}>
                  <Stack gap={2}>
                    {Object.entries(goal.parameterSchema).map(([parameter, bounds]) => {
                      const key = `${goal.goalId}@${goal.goalVersion}`;
                      const value = parameters[key]?.[parameter] ?? bounds.default;
                      return (
                        <TextInput
                          key={parameter}
                          type="number"
                          label={healthCopyParameterLabel(goal, parameter)}
                          name={`goal.${goal.goalId}.${goal.goalVersion}.${parameter}`}
                          value={String(value)}
                          min={bounds.minimum}
                          max={bounds.maximum}
                          step="any"
                          onChange={(event) => {
                            const next = {
                              ...parameters,
                              [key]: { ...parameters[key], [parameter]: Number(event.target.value) },
                            };
                            setParameters(next);
                            updateUrl(next);
                          }}
                        />
                      );
                    })}
                  </Stack>
                  <KeyValueList
                    items={
                      goal.economics
                        ? Object.entries(goal.economics.facts).map(([name, fact]) => ({
                            key: name,
                            value: `${String(fact.effectiveValue)} · ${fact.source} · ${fact.observedAt}`,
                          }))
                        : []
                    }
                  />
                  <Text size="sm">
                    {goal.requiresEconomics
                      ? goal.economics?.availability === "resolved"
                        ? copy("goals.economics.provenance")
                        : copy("goals.economics.unavailable")
                      : copy("goals.economics.default")}
                  </Text>
                </ProgressiveDisclosure>
              </Fieldset>
            ))}
          </Stack>
        )}
      </Card.Body>
    </Card>
  );
}

function healthCopyParameterLabel(goal: GoalChoice, parameter: string): string {
  return copy(`goals.parameter.${goal.goalId}.${parameter}`) || parameter;
}

export function GoalComparison({
  branch,
  candidates,
  recommendation,
  goals = [],
  targetPolicyId,
}: Readonly<{
  branch: "comparison" | "advanced-editor" | "create-editor";
  candidates: readonly CandidateMetrics[];
  recommendation: Recommendation;
  goals?: readonly GoalChoice[];
  targetPolicyId?: string;
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
      <DataTable
        rows={[...candidates]}
        getRowId={(row) => `${row.goalId}@${row.goalVersion}`}
        caption={copy("goals.comparison")}
        mobileMode="stack"
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
          { key: "requestedAt", header: copy("goals.requestedAt"), cell: (row) => row.requestedAt },
          {
            key: "hash",
            header: copy("goals.bodyHash"),
            cell: (row) => (
              <Text as="span" size="sm" wrap="anywhere">
                {row.bodyHash}
              </Text>
            ),
          },
          { key: "status", header: copy("goals.status"), cell: (row) => row.status },
          {
            key: "value",
            header: copy("goals.value"),
            cell: (row) =>
              Object.entries(row.value ?? {})
                .map(([k, v]) => `${k} ${v}`)
                .join(", ") || copy("unavailable"),
          },
          {
            key: "wait",
            header: copy("goals.wait"),
            cell: (row) =>
              Object.entries(row.medianWaitDays ?? {})
                .map(([k, v]) => `${k} ${v ?? copy("unavailable")}`)
                .join(", ") || copy("unavailable"),
          },
          {
            key: "coverage",
            header: copy("goals.coverage"),
            cell: (row) =>
              Object.entries(row.coverage ?? {})
                .map(([k, v]) => `${k} ${Math.round(v * 100)}%`)
                .join(", ") || copy("unavailable"),
          },
          {
            key: "p90",
            header: copy("goals.p90"),
            cell: (row) =>
              Object.entries(row.p90WaitDays ?? {})
                .map(([currency, value]) => `${currency} ${value ?? copy("unavailable")}`)
                .join(", ") || copy("unavailable"),
          },
          {
            key: "bounds",
            header: copy("goals.bounds"),
            cell: (row) =>
              Object.entries(row.boundStatusCount ?? {})
                .map(([currency, value]) => `${currency} ${value}`)
                .join(", ") || copy("unavailable"),
          },
          {
            key: "profit",
            header: copy("goals.profit"),
            cell: (row) =>
              Object.entries(row.profitPerDay ?? {})
                .map(([currency, value]) => `${currency} ${value ?? copy("unavailable")}`)
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
        ]}
      />
    </Stack>
  );
}
