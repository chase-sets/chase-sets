import type { JsonValue } from "@chase-sets/primitives/json";
import type { SourceObservationNormalized } from "../domain/domain";

export interface SourceObservationListItem {
  observation_id: string;
  provider_key: string;
  external_key: string;
  source_url: string;
  language_code: string;
  source_record_hash: string;
  source_updated_at: string | null;
  observed_at: string;
  normalized: SourceObservationNormalized;
  status: string;
  status_reason: string | null;
  promoted_catalog_item_id: string | null;
  promoted_at: string | null;
  updated_at: string;
}

export interface SourceObservationDetail extends SourceObservationListItem {
  source_payload: JsonValue;
}

export interface SourceObservationIntegrationScope {
  provider_key: string;
  language_code: string;
  expansion_id: string;
  expansion_name: string;
  series_id: string;
  series_name: string;
  total_observations: number;
  observed_observations: number;
  promoted_observations: number;
  rejected_observations: number;
  first_observed_at: string;
  latest_observed_at: string;
  latest_source_updated_at: string | null;
}

export interface TcgdexSetImportResult {
  setId: string;
  expansionId: string;
  languageCode: string;
  observed: number;
  observationIds: string[];
}

export interface SourceObservationPromotionScope {
  search?: string;
  status?: string;
  provider?: string;
  language?: string;
  setId?: string;
}

export interface SourceObservationPromotionPreview {
  matched: number;
  eligible: number;
  terminal: number;
  scope: Required<SourceObservationPromotionScope>;
}

export interface SourceObservationExpansionReference {
  reference_record_id: string;
  key: string;
  name: string;
  attributes: Record<string, unknown>;
}

export type BulkSourceObservationPromotionStatus =
  | "promoted"
  | "rejected"
  | "skipped"
  | "failed";

export interface BulkSourceObservationPromotionOutcome {
  observationId: string;
  status: BulkSourceObservationPromotionStatus;
  catalogItemId: string | null;
  reason: string | null;
}

export interface BulkSourceObservationPromotionResult {
  requested: number;
  promoted: number;
  rejected?: number;
  skipped: number;
  failed: number;
  outcomes: BulkSourceObservationPromotionOutcome[];
}
