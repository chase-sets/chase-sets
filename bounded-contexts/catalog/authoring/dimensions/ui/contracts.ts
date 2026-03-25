import type { LocalizedText } from "../../shared/ui/api/contracts";

export interface Dimension {
  dimension_id: string;
  key: string;
  name: string;
  description: string;
  status: string;
  updated_at: string;
}

export interface DimensionChoice {
  choice_id: string;
  dimension_id: string;
  code: string;
  labels: LocalizedText[] | null;
  display_order: number;
  numeric_value: number | null;
  status: string;
}

export interface DimensionDetail extends Dimension {
  choices: DimensionChoice[];
}
