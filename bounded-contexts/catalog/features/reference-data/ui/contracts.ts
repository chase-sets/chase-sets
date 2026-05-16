export interface ReferenceType {
  reference_type_id: string;
  key: string;
  name_i18n: unknown;
  name: string;
  description_i18n: unknown;
  description: string;
  attribute_keys: string[];
  status: string;
  updated_at: string;
}

export interface ReferenceRecord {
  reference_record_id: string;
  type_key: string;
  key: string;
  name_i18n: unknown;
  name: string;
  description_i18n: unknown;
  description: string;
  attributes: Record<string, unknown>;
  relationships: ReferenceRelationship[];
  status: string;
  updated_at: string;
}

export interface ReferenceRelationship {
  relationshipType: string;
  referenceId: string;
  reference?: ReferenceRecord;
}
