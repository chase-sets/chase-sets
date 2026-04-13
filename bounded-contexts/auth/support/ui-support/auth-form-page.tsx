import {
  Button,
  Card,
  PasswordInput,
  Stack,
  Text,
  TextInput,
} from "@chase-sets/design-system";
import type { FormEvent } from "react";

export function AuthFormPage({
  title,
  description,
  fields,
  ctaLabel,
  action,
  method = "post",
  hiddenFields,
  errorMessage,
  onSubmit,
}: {
  title: string;
  description: string;
  fields: readonly {
    key: string;
    label: string;
    name?: string;
    type?: "text" | "email" | "password";
    value?: string;
    defaultValue?: string;
    required?: boolean;
    onChange?: (value: string) => void;
  }[];
  ctaLabel: string;
  action?: string;
  method?: "get" | "post";
  hiddenFields?: readonly { name: string; value: string }[];
  errorMessage?: string | null;
  onSubmit?: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <Stack gap={4}>
      <Stack gap={2}>
        <Text size="lg" weight="semibold">
          {title}
        </Text>
        <Text tone="secondary">{description}</Text>
      </Stack>
      <Card>
        <form action={action} method={method} onSubmit={onSubmit}>
          <Stack gap={3}>
            {hiddenFields?.map((field) => (
              <input
                key={field.name}
                type="hidden"
                name={field.name}
                value={field.value}
                readOnly
              />
            ))}
            {fields.map((field) =>
              field.type === "password" ? (
                <PasswordInput
                  key={field.key}
                  label={field.label}
                  name={field.name ?? field.key}
                  value={field.value}
                  defaultValue={field.defaultValue}
                  required={field.required}
                  onChange={(event) => field.onChange?.(event.target.value)}
                />
              ) : (
                <TextInput
                  key={field.key}
                  label={field.label}
                  name={field.name ?? field.key}
                  type={field.type}
                  value={field.value}
                  defaultValue={field.defaultValue}
                  required={field.required}
                  onChange={(event) => field.onChange?.(event.target.value)}
                />
              ),
            )}
            {errorMessage ? (
              <div role="alert">
                <Text>{errorMessage}</Text>
              </div>
            ) : null}
            <Button type="submit">{ctaLabel}</Button>
          </Stack>
        </form>
      </Card>
    </Stack>
  );
}
