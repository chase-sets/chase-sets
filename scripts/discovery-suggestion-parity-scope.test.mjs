import { describe, expect, it } from "vitest";
import { classifyChanges } from "./change-scope.mjs";
import {
  shouldRunDiscoverySuggestionParity,
  touchesDiscoverySuggestionParity,
} from "./lib/discovery-suggestion-parity-scope.mjs";

const search = "bounded-contexts/discovery/features/search/";

describe("Discovery suggestion parity scope", () => {
  it.each([
    "suggestion-backend/Cargo.toml",
    "suggestion-backend/Cargo.lock",
    "suggestion-backend/rust-toolchain.toml",
    "suggestion-backend/.cargo/config.toml",
    "suggestion-backend/src/lib.rs",
    "suggestion-backend/tests/postgres_parity.rs",
    "api/route.ts",
    "api/runtime.ts",
    "domain/normalization.ts",
    "domain/protected-search-tokens.ts",
    "domain/query-vocabulary-policy.ts",
    "domain/search-synonyms.ts",
    "read-model/queries.ts",
    "read-model/queries.db.test.ts",
    "read-model/schema.ts",
    "read-model/suggestions.ts",
    "read-model/suggestion-parity.fixture.json",
  ])("enrolls %s in the required DB job and its Rust step", (file) => {
    const changedFiles = [search + file];
    expect(touchesDiscoverySuggestionParity(changedFiles)).toBe(true);
    expect(shouldRunDiscoverySuggestionParity(JSON.stringify(changedFiles))).toBe(true);
    const scope = classifyChanges({ changedFiles });
    expect(scope.dbTestsRequired).toBe(true);
    expect(scope.affectedWorkspaces).toContain("@chase-sets/discovery");
  });

  it.each([
    "rust-toolchain.toml",
    ".cargo/config.toml",
    "bounded-contexts/discovery/rust-toolchain",
    "bounded-contexts/discovery/support/runtime-support/services.ts",
    "bounded-contexts/discovery/support/item-support/route.ts",
    "bounded-contexts/discovery/support/client-support/contracts.ts",
    ".github/workflows/platform-pr.yml",
    "scripts/lib/discovery-suggestion-parity-scope.mjs",
  ])("also enrolls external inputs and runner wiring: %s", (file) => {
    expect(shouldRunDiscoverySuggestionParity(JSON.stringify([file]))).toBe(true);
    expect(classifyChanges({ changedFiles: [file] }).dbTestsRequired).toBe(true);
  });

  it.each([
    search + "suggestion-backend/README.md",
    search + "suggestion-backend-copy/src/lib.rs",
    search + "read-model/suggestions.ts.bak",
    "bounded-contexts/discovery/context.json",
    "deployables/corten-pilot/marketplace/src/search.rs",
    "docs/readme.md",
  ])("does not add the Rust step for %s", (file) => {
    expect(shouldRunDiscoverySuggestionParity(JSON.stringify([file]))).toBe(false);
  });

  it.each(["", undefined, "not JSON", "[]", "[null]"])("runs when the change set is unavailable: %s", (files) => {
    expect(shouldRunDiscoverySuggestionParity(files)).toBe(true);
  });
});
