import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { discloseForecastGrade } from "../api/grades";
import { ForecastGradePanel } from "../ui/forecast-grade-panel";

const stored = {
  closedOn: "2026-10-18",
  forecastKind: "curve",
  horizonDays: 21,
  model: "synthetic-model",
  grade: { count: 29, soldShare: 0.6, expectedShare: 0.7, brier: 0.2, baseRateBrier: 0.24, deciles: [] },
};

describe("Forecast Grade disclosure", () => {
  it("does not send counts, shares, scores or deciles for a cohort of 29", () => {
    const grade = discloseForecastGrade(stored, 30);
    expect(grade).toEqual({
      closedOn: stored.closedOn,
      forecastKind: "curve",
      horizonDays: 21,
      model: stored.model,
      status: "undisclosed",
    });
    const html = renderToStaticMarkup(
      <ForecastGradePanel grades={[{ ...grade, goalId: "fixed-percentile", goalVersion: 1 }]} />,
    );
    expect(html).toContain("No graded cohort yet");
    expect(html).not.toContain("0.6");
    expect(html).not.toContain("29");
  });

  it("keeps malformed missing grades undisclosed", () => {
    const grade = discloseForecastGrade({ ...stored, grade: null as never }, 30);
    expect(grade).toEqual({
      closedOn: stored.closedOn,
      forecastKind: "curve",
      horizonDays: 21,
      model: stored.model,
      status: "undisclosed",
    });
  });

  it("sends exactly the four disclosed values at 30 and labels the platform cohort", () => {
    const grade = discloseForecastGrade({ ...stored, grade: { ...stored.grade, count: 30 } }, 30);
    expect(grade).toEqual({
      closedOn: stored.closedOn,
      forecastKind: "curve",
      horizonDays: 21,
      model: stored.model,
      status: "disclosed",
      values: { soldShare: 0.6, expectedShare: 0.7, brier: 0.2, baseRateBrier: 0.24 },
    });
    const html = renderToStaticMarkup(
      <ForecastGradePanel grades={[{ ...grade, goalId: "fixed-percentile", goalVersion: 1 }]} />,
    );
    expect(html).toContain("across all sellers using this goal version");
    expect(html).toContain("Sold share");
    expect(html).toContain("Expected share");
    expect(html).toContain("Base-rate Brier");
    expect(html).not.toContain("deciles");
  });
});
