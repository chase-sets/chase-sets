import type { ChoiceRef } from "../../dimensions/ui/contracts";

export interface Component {
  component_id: string;
  key: string;
  name: string;
  description: string;
  status: string;
  field_rules: { fieldId: string; required: boolean }[];
  dimension_rules: Array<{
    dimensionId: string;
    required: boolean;
    allowedChoiceIds: string[];
    appliesWhen: Array<{ dimensionId: string; choiceIds: string[] }>;
  }>;
  updated_at: string;
}

export interface ComponentDetail {
  component_id: string;
  key: string;
  name: string;
  description: string;
  status: string;
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
  updated_at: string;
}

export interface ComponentRef {
  componentId: string;
  name: string;
}
