import type { LocalizedTextMap } from "@chase-sets/localization";
import type { ComponentRef } from "../../components/ui/contracts";
import type { OptionRef } from "../../dimensions/ui/contracts";

export interface Blueprint {
  blueprint_id: string;
  key: string;
  name_i18n: LocalizedTextMap;
  name: string;
  description_i18n: LocalizedTextMap;
  description: string;
  status: string;
  component_ids: string[];
  field_rules: { fieldId: string; required: boolean }[];
  dimension_rules: Array<{
    dimensionId: string;
    required: boolean;
    allowedOptionIds: string[];
    appliesWhen: Array<{ dimensionId: string; optionIds: string[] }>;
  }>;
  canonical_dimension_order: string[];
  updated_at: string;
}

export interface BlueprintDetail {
  blueprint_id: string;
  key: string;
  name_i18n: LocalizedTextMap;
  name: string;
  description_i18n: LocalizedTextMap;
  description: string;
  status: string;
  components: ComponentRef[];
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
  canonical_dimension_order: Array<{ dimensionId: string; dimensionName: string }>;
  updated_at: string;
}

export interface BlueprintRef {
  blueprintId: string;
  name: string;
}
