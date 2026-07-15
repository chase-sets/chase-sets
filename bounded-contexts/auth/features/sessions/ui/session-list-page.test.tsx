// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { SessionListPage } from "./session-list-page";

afterEach(cleanup);

describe("session list page heading hierarchy", () => {
  it("renders exactly one top-level heading", () => {
    render(
      <MemoryRouter>
        <SessionListPage initialData={{ items: [], count: 0, total: 0 }} />
      </MemoryRouter>,
    );

    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1, name: "Sessions" })).toBeTruthy();
  });
});
