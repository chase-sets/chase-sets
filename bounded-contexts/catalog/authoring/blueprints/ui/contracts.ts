import type { ComponentRef } from "../../components/ui/contracts";
import type { ChoiceRef } from "../../dimensions/ui/contracts";

export interface Blueprint {
  blueprint_id: string;
  key: string;
  name: string;
  description: string;
  status: string;
  component_ids: string[];
  field_rules: { fieldId: string; required: boolean }[];
  dimension_rules: Array<{
    dimensionId: string;
    required: boolean;
    allowedChoiceIds: string[];
    appliesWhen: Array<{ dimensionId: string; choiceIds: string[] }>;
  }>;
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
  dimension_rules: Array<{
    dimensionId: string;
    dimensionName: string;
    required: boolean;
    allowedChoices: ChoiceRef[];
    appliesWhen: Array<{
      dimensionId: string;
      dimensionName: string;
      choiceIds: string[];
      choices: ChoiceRef[];
    }>;
  }>;
  canonical_dimension_order: Array<{ dimensionId: string; dimensionName: string }>;
  updated_at: string;
}

export interface BlueprintRef {
  blueprintId: string;
  name: string;
}
