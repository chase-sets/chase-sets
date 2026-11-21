// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { t } from "@chase-sets/localization";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SourceObservationNormalized } from "../domain/domain";
import { ToastProvider } from "../../../support/shell-support/ui/toasts";
import type { SourceObservationDetail } from "./contracts";
import { ApiError } from "../../../support/shell-support/api/client";
import { SourceObservationDetailPage } from "./source-observation-detail-page";
import { promoteSourceObservation, rejectSourceObservation, useSourceObservation } from "./use-source-observations";

vi.mock("./use-source-observations", () => ({
  useSourceObservation: vi.fn(),
  promoteSourceObservation: vi.fn(),
  rejectSourceObservation: vi.fn(),
}));

// A stored YGOJSON set reference carries no imageUrls, unlike the typed contract.
const storedSetReference = {
  kind: "yugioh-set-reference",
  tcg: "yugioh",
  languageCode: "en",
  name: "Beginner's Edition 2",
  setId: "000f0093-1847-4db7-a315-5bd07f055c7a",
  setCode: "BE02",
  setName: "Beginner's Edition 2",
  expansionName: null,
  cardNumber: null,
  releaseDate: null,
  cardCount: null,
  productLineName: "Yu-Gi-Oh!",
} as unknown as SourceObservationNormalized;

function observationWith(normalized: SourceObservationNormalized): SourceObservationDetail {
  return {
    observation_id: "obs_ygojson_set_be02",
    provider_key: "ygojson",
    external_key: "set:000f0093-1847-4db7-a315-5bd07f055c7a",
    source_url: "https://ygojson.example/sets/000f0093-1847-4db7-a315-5bd07f055c7a",
    language_code: "en",
    source_record_hash: "hash_be02",
    source_updated_at: null,
    observed_at: "2026-11-12T00:00:00.000Z",
    source_profile_key: "yugioh-set-reference-data",
    source_profile_version: "1",
    source_mapping_fingerprint: "fingerprint_be02",
    normalized,
    status: "observed",
    status_reason: null,
    promoted_catalog_item_id: null,
    promoted_reference_record_id: null,
    promoted_at: null,
    promotion_profile_key: null,
    promotion_profile_version: null,
    promotion_plan_fingerprint: null,
    updated_at: "2026-11-12T00:00:00.000Z",
    source_payload: {},
  };
}

function renderDetail(observation: SourceObservationDetail, refresh = vi.fn()) {
  vi.mocked(useSourceObservation).mockReturnValue({
    data: observation,
    loading: false,
    error: null,
    refresh,
  });
  render(
    <ToastProvider>
      <SourceObservationDetailPage id={observation.observation_id} initialData={observation} />
    </ToastProvider>,
  );
}

describe("SourceObservationDetailPage image", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("renders an observation whose normalized payload has no imageUrls", () => {
    renderDetail(observationWith(storedSetReference));

    expect(screen.getByText("set:000f0093-1847-4db7-a315-5bd07f055c7a")).toBeTruthy();
    expect(screen.queryByRole("img", { name: "Card image" })).toBeNull();
  });

  it("renders the first image URL when the payload has one", () => {
    renderDetail(
      observationWith({
        ...storedSetReference,
        imageUrls: ["https://images.example/sets/be02.png", "https://images.example/sets/be02-alt.png"],
      } as SourceObservationNormalized),
    );

    expect(screen.getByRole("img", { name: "Card image" }).getAttribute("src")).toBe(
      "https://images.example/sets/be02.png",
    );
  });
});

describe("SourceObservationDetailPage review", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("shows the API's message when Promote is refused and keeps the observation as it was", async () => {
    vi.mocked(promoteSourceObservation).mockRejectedValue(
      new ApiError(403, { error: { code: "rollout_paused", message: "Promotion is paused for this provider." } }),
    );
    const refresh = vi.fn();
    renderDetail(observationWith(storedSetReference), refresh);

    fireEvent.click(screen.getByRole("button", { name: t("catalog.features.sourceObservations.ui.detail.promote") }));

    expect(await screen.findByText(t("catalog.features.sourceObservations.ui.detail.reviewRefused"))).toBeTruthy();
    expect(screen.getByText("Promotion is paused for this provider.")).toBeTruthy();
    expect(screen.queryByText(t("catalog.features.sourceObservations.ui.detail.promoted"))).toBeNull();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("shows the API's message when Reject is refused", async () => {
    vi.mocked(rejectSourceObservation).mockRejectedValue(
      new ApiError(409, { error: { code: "not_reviewable", message: "This observation is no longer reviewable." } }),
    );
    renderDetail(observationWith(storedSetReference));

    fireEvent.click(screen.getByRole("button", { name: t("catalog.features.sourceObservations.ui.detail.reject") }));

    expect(await screen.findByText("This observation is no longer reviewable.")).toBeTruthy();
    expect(screen.queryByText(t("catalog.features.sourceObservations.ui.detail.rejected"))).toBeNull();
  });

  it("confirms an accepted review and reloads the observation", async () => {
    vi.mocked(promoteSourceObservation).mockResolvedValue({} as never);
    const refresh = vi.fn();
    renderDetail(observationWith(storedSetReference), refresh);

    fireEvent.click(screen.getByRole("button", { name: t("catalog.features.sourceObservations.ui.detail.promote") }));

    expect(await screen.findByText(t("catalog.features.sourceObservations.ui.detail.promoted"))).toBeTruthy();
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
  });
});
