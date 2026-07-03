// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ApiKeyListPage, buildApiKeyUserPickerItems } from "../features/api-keys/ui/api-key-list-page";

const users = [
  {
    user_id: "usr_alex",
    display_name: "Alex Clerk",
    given_name: "Alex",
    family_name: "Clerk",
    primary_email: "alex@example.com",
    status: "active",
    contact_methods: [],
    auth_methods: ["password"],
    updated_at: "2026-05-13T12:00:00.000Z",
  },
];

describe("Access API key list page", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders API key creation with user-backed picker options", () => {
    expect(buildApiKeyUserPickerItems(users)).toEqual([
      {
        value: "usr_alex",
        label: "Alex Clerk (alex@example.com)",
        description: "usr_alex",
      },
    ]);

    render(
      <ApiKeyListPage
        initialData={{
          items: [],
          total: 0,
          count: 0,
          limit: 25,
          offset: 0,
        }}
        users={users}
        oneTimeSecret={{
          apiKeyId: "key_created",
          keyPrefix: "key_created_",
          secret: "key_created_full_secret_value",
          action: "created",
        }}
      />,
    );

    expect(document.querySelector('input[name="userId"]')).toBeTruthy();
    expect(screen.getAllByRole("combobox", { name: "User" }).length).toBeGreaterThan(0);
    expect(screen.getByText("API key secret created")).toBeTruthy();
    expect(screen.getByText("key_created_full_secret_value")).toBeTruthy();
    expect(screen.getByRole("button", { name: /copy/i })).toBeTruthy();
    expect(screen.getByText(/shown only once/i)).toBeTruthy();
  });
});
