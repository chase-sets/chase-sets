import { describe, expect, it } from "vitest";
import { IDENTITY_USER_STATUSES, identityListQuery, readIdentityListFilters } from "./list-filters";

function requestFor(path: string) {
  return new Request(`https://admin.chasesets.test${path}`);
}

describe("readIdentityListFilters", () => {
  it("normalizes an unrecognized status to all", () => {
    expect(readIdentityListFilters(requestFor("/access/users?status=bogus"), IDENTITY_USER_STATUSES)).toEqual({
      status: "all",
      search: "",
    });
  });

  it("passes through a recognized status and trims the search term", () => {
    expect(
      readIdentityListFilters(requestFor("/access/users?status=suspended&search=%20alex%20"), IDENTITY_USER_STATUSES),
    ).toEqual({ status: "suspended", search: "alex" });
  });

  it("defaults to all/empty when no filters are supplied", () => {
    expect(readIdentityListFilters(requestFor("/access/users"), IDENTITY_USER_STATUSES)).toEqual({
      status: "all",
      search: "",
    });
  });
});

describe("identityListQuery", () => {
  it("adds no filter params when filters are unset", () => {
    expect(identityListQuery("limit=50&offset=0", { status: "all", search: "" })).toBe("limit=50&offset=0");
  });

  it("appends status and search onto the base pagination query", () => {
    expect(identityListQuery("limit=25&offset=50", { status: "active", search: "alex" })).toBe(
      "limit=25&offset=50&status=active&search=alex",
    );
  });
});
