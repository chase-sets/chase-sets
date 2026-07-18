export type DisplayTemplateTargetKind = "global" | "blueprint" | "category" | "reference-record" | "catalog-item";

export interface DisplayTemplateTarget {
  kind: DisplayTemplateTargetKind;
  id?: string;
}

export interface DisplayTemplate {
  display_template_id: string;
  key: string;
  name_i18n: unknown;
  name: string;
  description_i18n: unknown;
  description: string;
  target_kind: DisplayTemplateTargetKind;
  target_id: string | null;
  priority: number;
  title_template: string;
  subtitle_template: string | null;
  required_field_keys: unknown;
  status: string;
  updated_at: string;
}

export type DisplayTemplateDetail = DisplayTemplate;

export interface DisplayTemplateInput {
  displayTemplateId?: string;
  key: string;
  name: unknown;
  description: unknown;
  target: DisplayTemplateTarget;
  priority: number;
  titleTemplate: string;
  subtitleTemplate: string | null;
}
