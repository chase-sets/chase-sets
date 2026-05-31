import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { buildReleaseControlsSnapshot, readReleaseControlsQuery } from "../read-model/contracts";
import { ReleaseControlsPage } from "./release-controls-page";

describe("ReleaseControlsPage", () => {
  it("renders lock status, command builder, and rollout evaluation", () => {
    const data = buildReleaseControlsSnapshot(
      readReleaseControlsQuery(
        new Request(
          "https://admin.example.com/operations/release-controls?releaseAction=unlock&rolloutFeatureKey=pricing.experiment&rolloutPercentage=100&rolloutSubjectId=acc_1",
        ),
      ),
      {
        PRODUCTION_RELEASE_LOCKED: "true",
        PRODUCTION_RELEASE_LOCK_REASON: "production payment incident",
        PRODUCTION_RELEASE_LOCK_REFERENCE: "https://github.com/todd-skelton/chase-sets/issues/466",
      },
    );

    render(<ReleaseControlsPage data={data} />);

    expect(screen.getByRole("heading", { name: "Release Controls" })).toBeTruthy();
    expect(screen.getByText("Locked")).toBeTruthy();
    expect(screen.getByDisplayValue(/gh variable set PRODUCTION_RELEASE_LOCKED/)).toBeTruthy();
    expect(screen.getByText("percentage-rollout")).toBeTruthy();
  });

  it("surfaces validation errors for unsafe lock commands", () => {
    const data = buildReleaseControlsSnapshot(
      readReleaseControlsQuery(new Request("https://admin.example.com/operations/release-controls?releaseAction=lock")),
      {},
    );

    render(<ReleaseControlsPage data={data} />);

    expect(screen.getByText("Needs input")).toBeTruthy();
    expect(screen.getByText("Lock reason is required.")).toBeTruthy();
  });
});
