import { describe, expect, it } from "vitest";
import { readSessionListFilters, sessionListQuery } from "./list-filters";

function requestFor(path: string) {
  return new Request(`https://admin.chasesets.test${path}`);
}

describe("readSessionListFilters", () => {
  it("normalizes an unrecognized status to all", () => {
    expect(readSessionListFilters(requestFor("/access/sessions?status=bogus"))).toEqual({
      status: "all",
      search: "",
    });
  });

  it("passes through a recognized status and trims the search term", () => {
    expect(readSessionListFilters(requestFor("/access/sessions?status=revoked&search=%20alex%20"))).toEqual({
      status: "revoked",
      search: "alex",
    });
  });
});

describe("sessionListQuery", () => {
  it("adds no filter params when filters are unset", () => {
    expect(sessionListQuery("limit=50&offset=0", { status: "all", search: "" })).toBe("limit=50&offset=0");
  });

  it("appends status and search onto the base pagination query", () => {
    expect(sessionListQuery("limit=25&offset=50", { status: "expired", search: "acc_1" })).toBe(
      "limit=25&offset=50&status=expired&search=acc_1",
    );
  });
});
