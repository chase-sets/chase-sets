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
