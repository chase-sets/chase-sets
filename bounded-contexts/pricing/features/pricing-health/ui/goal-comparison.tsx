import {
  Banner,
  Card,
  DataTable,
  Fieldset,
  KeyValueList,
  ProgressiveDisclosure,
  Stack,
  Text,
} from "@chase-sets/design-system";
import type { CandidateMetrics, GoalChoice, Recommendation } from "../api/goal-comparison";
import { healthCopy as copy } from "./copy";

export function GoalPicker({ goals }: Readonly<{ goals: readonly GoalChoice[] }>) {
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
              <Fieldset key={`${goal.goalId}@${goal.goalVersion}`} legend={goal.label}>
                <Text size="sm">{goal.explanation}</Text>
                <ProgressiveDisclosure title={copy("goals.advanced")}>
                  <KeyValueList
                    items={Object.entries(goal.parameterSchema).map(([parameter, bounds]) => ({
                      key: parameter,
                      value: `${goal.parameters[parameter]} (${bounds.minimum}–${bounds.maximum})`,
                    }))}
                  />
                  <Text size="sm">
                    {goal.economics.required ? copy("goals.economics.required") : copy("goals.economics.default")}
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

export function GoalComparison({
  branch,
  candidates,
  recommendation,
}: Readonly<{
  branch: "comparison" | "advanced-editor" | "create-editor";
  candidates: readonly CandidateMetrics[];
  recommendation: Recommendation;
}>) {
  if (branch === "advanced-editor")
    return <Banner tone="info" title={copy("goals.advancedEditor")} description={copy("goals.noComparison")} />;
  if (branch === "create-editor")
    return <Banner tone="info" title={copy("goals.createEditor")} description={copy("goals.noComparison")} />;
  return (
    <Stack gap={4} data-testid="pricing-health-goal-comparison">
      <Banner tone={recommendation.kind === "switch" ? "success" : "info"} title={recommendation.text} />
      <DataTable
        rows={[...candidates]}
        getRowId={(row) => `${row.goalId}@${row.goalVersion}`}
        caption={copy("goals.comparison")}
        mobileMode="stack"
        emptyTitle={copy("goals.compareEmpty")}
        columns={[
          { key: "goal", header: copy("goals.goal"), cell: (row) => `${row.goalId} v${row.goalVersion}` },
          { key: "scope", header: copy("goals.scope"), cell: (row) => row.scopeLabel },
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
            key: "movement",
            header: copy("goals.movement"),
            cell: (row) =>
              `${copy("goals.raised")}: ${row.raised ?? "—"}; ${copy("goals.lowered")}: ${row.lowered ?? "—"}; ${copy("goals.held")}: ${row.held ?? "—"}`,
          },
        ]}
      />
    </Stack>
  );
}
