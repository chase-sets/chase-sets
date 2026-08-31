import {
  HiddenInput,
  Form,
  Button,
  Card,
  Heading,
  LiveRegion,
  Stack,
  Text,
  TextInput,
  PasswordInput,
} from "@chase-sets/design-system";
import type { FormEvent, ReactNode } from "react";

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
        <Heading level={1} visualSize={5}>
          {title}
        </Heading>
        <Text tone="secondary">{description}</Text>
      </Stack>
      <Card elevation="tinted">
        <Form spacing="none" action={action} method={method} onSubmit={onSubmit}>
          <Stack gap={3}>
            {hiddenFields?.map((field) => (
              <HiddenInput key={field.name} type="hidden" name={field.name} value={field.value} readOnly />
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
              <LiveRegion>
                <Text>{errorMessage}</Text>
              </LiveRegion>
            ) : null}
            <Button type="submit">{ctaLabel}</Button>
          </Stack>
        </Form>
      </Card>
    </Stack>
  );
}

export function CustomerSummaryPage({
  title,
  description,
  controls,
  sections,
}: {
  title: string;
  description: string;
  controls?: ReactNode;
  sections: readonly { key?: string; title: string; body: string; action?: ReactNode }[];
}) {
  return (
    <Stack gap={4}>
      <Stack gap={2}>
        <Heading level={1} visualSize={5}>
          {title}
        </Heading>
        <Text tone="secondary">{description}</Text>
      </Stack>
      {controls}
      {sections.map((section) => (
        <Card key={section.key ?? section.title} elevation="tinted">
          <Stack gap={2}>
            <Heading level={2} visualSize={6}>
              {section.title}
            </Heading>
            <Text tone="secondary">{section.body}</Text>
            {section.action}
          </Stack>
        </Card>
      ))}
    </Stack>
  );
}
