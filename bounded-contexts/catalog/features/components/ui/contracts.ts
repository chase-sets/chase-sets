import type { LocalizedTextMap } from "@chase-sets/localization";
import type { OptionRef } from "../../dimensions/ui/contracts";

export interface Component {
  component_id: string;
  key: string;
  name_i18n: LocalizedTextMap;
  name: string;
  description_i18n: LocalizedTextMap;
  description: string;
  status: string;
  field_rules: { fieldId: string; required: boolean }[];
  dimension_rules: Array<{
    dimensionId: string;
    required: boolean;
    allowedOptionIds: string[];
    appliesWhen: Array<{ dimensionId: string; optionIds: string[] }>;
  }>;
  updated_at: string;
}

export interface ComponentDetail {
  component_id: string;
  key: string;
  name_i18n: LocalizedTextMap;
  name: string;
  description_i18n: LocalizedTextMap;
  description: string;
  status: string;
  field_rules: Array<{ fieldId: string; fieldName: string; required: boolean }>;
  dimension_rules: Array<{
    dimensionId: string;
    dimensionName: string;
    required: boolean;
    allowedOptions: OptionRef[];
    appliesWhen: Array<{
      dimensionId: string;
      dimensionName: string;
      optionIds: string[];
      options: OptionRef[];
    }>;
  }>;
  updated_at: string;
}

export interface ComponentRef {
  componentId: string;
  name: string;
}
