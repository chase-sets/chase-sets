// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SourceObservationNormalized } from "../domain/domain";
import { ToastProvider } from "../../../support/shell-support/ui/toasts";
import type { SourceObservationDetail } from "./contracts";
import { SourceObservationDetailPage } from "./source-observation-detail-page";
import { useSourceObservation } from "./use-source-observations";

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

function renderDetail(observation: SourceObservationDetail) {
  vi.mocked(useSourceObservation).mockReturnValue({
    data: observation,
    loading: false,
    error: null,
    refresh: vi.fn(),
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
