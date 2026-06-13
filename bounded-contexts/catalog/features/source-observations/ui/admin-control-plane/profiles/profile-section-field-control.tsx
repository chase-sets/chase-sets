import { Checkbox, NativeSelect, Textarea, TextInput } from "@chase-sets/design-system";
import type { ProfileSectionWorkspace } from "./profile-formatting";

export function ProfileSectionFieldControl({ field }: { field: ProfileSectionWorkspace["fields"][number] }) {
  if (field.control === "textarea") {
    return (
      <Textarea
        label={field.label}
        description={field.helpText}
        name={field.key}
        defaultValue={field.value}
        disabled={field.disabled}
        required={field.required}
      />
    );
  }

  if (field.control === "select") {
    return (
      <NativeSelect
        label={field.label}
        description={field.helpText}
        name={field.key}
        defaultValue={field.value}
        disabled={field.disabled}
        required={field.required}
        items={
          field.options.length === 0
            ? [{ value: field.value, label: field.value || "Not selected" }]
            : field.options.map((optionEntry) => ({ value: optionEntry.value, label: optionEntry.label }))
        }
      />
    );
  }

  if (field.control === "checkbox") {
    return (
      <Checkbox
        label={field.label}
        description={field.helpText}
        name={field.key}
        value="true"
        defaultChecked={field.value === "true"}
        disabled={field.disabled}
      />
    );
  }

  return (
    <TextInput
      label={field.label}
      description={field.helpText}
      name={field.key}
      defaultValue={field.value}
      disabled={field.disabled}
      required={field.required}
    />
  );
}
