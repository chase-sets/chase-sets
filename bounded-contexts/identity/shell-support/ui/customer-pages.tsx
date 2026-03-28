import {
  Button,
  Card,
  Stack,
  Text,
  TextInput,
  PasswordInput,
} from "@chase-sets/design-system";
import type { FormEvent } from "react";

export function AuthFormPage({
  title,
  description,
  fields,
  ctaLabel,
  onSubmit,
}: {
  title: string;
  description: string;
  fields: readonly {
    key: string;
    label: string;
    type?: "text" | "email" | "password";
    value?: string;
    onChange?: (value: string) => void;
  }[];
  ctaLabel: string;
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
        <form onSubmit={onSubmit}>
          <Stack gap={3}>
            {fields.map((field) =>
              field.type === "password" ? (
                <PasswordInput
                  key={field.key}
                  label={field.label}
                  value={field.value}
                  onChange={(event) => field.onChange?.(event.target.value)}
                />
              ) : (
                <TextInput
                  key={field.key}
                  label={field.label}
                  type={field.type}
                  value={field.value}
                  onChange={(event) => field.onChange?.(event.target.value)}
                />
              ),
            )}
            <Button type="submit">{ctaLabel}</Button>
          </Stack>
        </form>
      </Card>
    </Stack>
  );
}

export function CustomerSummaryPage({
  title,
  description,
  sections,
}: {
  title: string;
  description: string;
  sections: readonly { title: string; body: string }[];
}) {
  return (
    <Stack gap={4}>
      <Stack gap={2}>
        <Text size="lg" weight="semibold">
          {title}
        </Text>
        <Text tone="secondary">{description}</Text>
      </Stack>
      {sections.map((section) => (
        <Card key={section.title} title={section.title}>
          <Text tone="secondary">{section.body}</Text>
        </Card>
      ))}
    </Stack>
  );
}
