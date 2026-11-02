import { Badge, Card, KeyValueList, Stack } from "@chase-sets/design-system";
import type { PricingHealthGrade } from "../api/grades";
import { healthCopy as copy, healthNumber, healthPercent } from "./copy";

export function ForecastGradePanel({ grades }: Readonly<{ grades: readonly PricingHealthGrade[] }>) {
  return (
    <Stack gap={4} data-testid="forecast-grade-panel">
      {grades.length === 0 ? (
        <Badge>{copy("grades.empty")}</Badge>
      ) : (
        grades.map((row) => (
          <Card
            key={JSON.stringify([row.goalId, row.goalVersion, row.forecastKind, row.horizonDays, row.model])}
            elevation="tinted"
            data-elevation-role="furniture"
          >
            <Card.Header>
              <Card.Title>
                {copy("grades.identity", {
                  goal: row.goalId,
                  version: row.goalVersion,
                  kind: row.forecastKind,
                  horizon: row.horizonDays,
                  model: row.model,
                })}
              </Card.Title>
              <Card.Description>{copy("grades.platform")}</Card.Description>
            </Card.Header>
            <Card.Body>
              <Badge tone={row.status === "disclosed" ? "success" : "neutral"}>
                {copy(row.status === "disclosed" ? "grades.disclosed" : "grades.empty")}
              </Badge>
              <KeyValueList
                items={[
                  { key: copy("grades.closedOn"), value: row.closedOn },
                  ...(row.status === "disclosed"
                    ? [
                        { key: copy("grades.soldShare"), value: healthPercent(row.values.soldShare) },
                        { key: copy("grades.expectedShare"), value: healthPercent(row.values.expectedShare) },
                        { key: copy("grades.brier"), value: healthNumber(row.values.brier) },
                        { key: copy("grades.baseRateBrier"), value: healthNumber(row.values.baseRateBrier) },
                      ]
                    : []),
                ]}
              />
            </Card.Body>
          </Card>
        ))
      )}
    </Stack>
  );
}
