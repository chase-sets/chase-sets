export interface LocalizedText {
  locale: string;
  value: string;
}

export interface NamedEntityRef {
  name: string;
}

export interface CategoryRef extends NamedEntityRef {
  categoryId: string;
}

export interface BlueprintRef extends NamedEntityRef {
  blueprintId: string;
}

export interface ComponentRef extends NamedEntityRef {
  componentId: string;
}

export interface DimensionRef extends NamedEntityRef {
  dimensionId: string;
}

export interface FieldRef extends NamedEntityRef {
  fieldId: string;
}

export interface ChoiceRef {
  choiceId: string;
  code: string;
}

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

export interface Field {
  field_id: string;
  key: string;
  name: string;
  description: string;
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
  description: string;
  status: string;
  field_rules: { fieldId: string; required: boolean }[];
  dimension_rules: { dimensionId: string; required: boolean; allowedChoiceIds: string[] }[];
  updated_at: string;
}

export interface ComponentDetail {
  component_id: string;
  key: string;
  name: string;
  description: string;
  status: string;
  field_rules: Array<{ fieldId: string; fieldName: string; required: boolean }>;
  dimension_rules: Array<{ dimensionId: string; dimensionName: string; required: boolean; allowedChoices: ChoiceRef[] }>;
  updated_at: string;
}

export interface Blueprint {
  blueprint_id: string;
  key: string;
  name: string;
  description: string;
  status: string;
  component_ids: string[];
  field_rules: { fieldId: string; required: boolean }[];
  dimension_rules: { dimensionId: string; required: boolean; allowedChoiceIds: string[] }[];
  canonical_dimension_order: string[];
  updated_at: string;
}

export interface BlueprintDetail {
  blueprint_id: string;
  key: string;
  name: string;
  description: string;
  status: string;
  components: ComponentRef[];
  field_rules: Array<{ fieldId: string; fieldName: string; required: boolean }>;
  dimension_rules: Array<{ dimensionId: string; dimensionName: string; required: boolean; allowedChoices: ChoiceRef[] }>;
  canonical_dimension_order: Array<{ dimensionId: string; dimensionName: string }>;
  updated_at: string;
}

export interface CategoryListItem {
  category_id: string;
  key: string;
  name: string;
  description: string;
  status: string;
  parent_category: CategoryRef | null;
  display_order: number;
  updated_at: string;
}

export interface CategoryDetail extends CategoryListItem {}

export interface CatalogItemListItem {
  item_id: string;
  title: string;
  subtitle: string | null;
  blueprint: BlueprintRef | null;
  status: string;
  tags: string[];
  updated_at: string;
}

export interface CatalogItemDetail {
  item_id: string;
  title: string;
  subtitle: string | null;
  description: string;
  blueprint: BlueprintRef | null;
  status: string;
  field_values: Array<{ fieldId: string; fieldName: string; value: unknown }>;
  categories: CategoryRef[];
  tags: string[];
  image_urls: string[];
  updated_at: string;
}

export interface ListResponse<T> {
  items: T[];
  total: number;
  count: number;
}

export interface CommandResponse {
  id: string;
  version: number;
  status: string;
}

