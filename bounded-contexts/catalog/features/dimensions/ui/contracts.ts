import type { LocalizedTextMap } from "@chase-sets/localization";

export interface Dimension {
  dimension_id: string;
  key: string;
  name_i18n: LocalizedTextMap;
  name: string;
  description_i18n: LocalizedTextMap;
  description: string;
  value_kind: "unordered" | "ordered" | "numeric";
  status: string;
  updated_at: string;
}

export interface DimensionOption {
  option_id: string;
  dimension_id: string;
  code: string;
  label_i18n: LocalizedTextMap;
  label: string;
  display_order: number;
  numeric_value: number | null;
  status: string;
}

export interface DimensionDetail extends Dimension {
  options: DimensionOption[];
}

export interface OptionRef {
  optionId: string;
  code: string;
  label?: string;
  displayOrder?: number;
  numericValue?: number | null;
}
