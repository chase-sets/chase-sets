export interface Dimension {
  dimension_id: string;
  key: string;
  name: string;
  status: string;
  updated_at: string;
}

export interface DimensionChoice {
  choice_id: string;
  dimension_id: string;
  code: string;
  labels: Record<string, string> | null;
  display_order: number;
  numeric_value: number | null;
  status: string;
}

export interface DimensionDetail extends Dimension {
  choices: DimensionChoice[];
}

export interface Field {
  field_id: string;
  key: string;
  name: string;
  status: string;
  value_type: string;
  filterable: boolean;
  searchable: boolean;
  sortable: boolean;
  updated_at: string;
}

export interface Component {
  component_id: string;
  key: string;
  name: string;
  status: string;
  field_rules: { fieldId: string; required: boolean }[];
  dimension_rules: { dimensionId: string; required: boolean; allowedChoiceIds: string[] }[];
  updated_at: string;
}

export interface Blueprint {
  blueprint_id: string;
  key: string;
  name: string;
  status: string;
  component_ids: string[];
  field_rules: { fieldId: string; required: boolean }[];
  dimension_rules: { dimensionId: string; required: boolean; allowedChoiceIds: string[] }[];
  canonical_dimension_order: string[];
  updated_at: string;
}

export interface Category {
  category_id: string;
  key: string;
  name: string;
  status: string;
  parent_category_id: string | null;
  display_order: number;
  updated_at: string;
}

export interface CatalogItem {
  item_id: string;
  title: string;
  subtitle: string | null;
  blueprint_id: string | null;
  status: string;
  field_values: { fieldId: string; value: string }[];
  category_ids: string[];
  updated_at: string;
}

export interface ListResponse<T> {
  items: T[];
  count: number;
}

export interface CommandResponse {
  id: string;
  version: number;
  status: string;
}
