export interface VersionDimension {
  dimensionId: string;
  dimensionName: string;
  required: boolean;
  allowedChoices: Array<{
    choiceId: string;
    code: string;
    labels?: Array<{ locale: string; value: string }>;
  }>;
}

export interface VersionSchema {
  canonicalDimensionOrder: Array<{ dimensionId: string; dimensionName: string }>;
  dimensions: VersionDimension[];
}

export interface FieldValue {
  fieldId: string;
  fieldName: string;
  value: unknown;
}

export interface CategoryRef {
  categoryId: string;
  name: string;
}

export interface DiscoveryItemDetail {
  item_id: string;
  title: string;
  subtitle: string | null;
  description: string;
  blueprint_id: string | null;
  blueprint: { blueprintId: string; name: string } | null;
  status: string;
  field_values: FieldValue[];
  categories: CategoryRef[];
  tags: string[];
  image_urls: string[];
  version_schema: VersionSchema | null;
  updated_at: string;
}
