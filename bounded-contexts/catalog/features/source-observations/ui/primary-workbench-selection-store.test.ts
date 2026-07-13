// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
  observationSelectionScopeKey,
  readPersistedObservationSelection,
  writePersistedObservationSelection,
} from "./primary-workbench-selection-store";

afterEach(() => {
  window.sessionStorage.clear();
});

describe("primary workbench durable observation selection store", () => {
  it("round-trips a selection through sessionStorage for a scope key", () => {
    const scopeKey = observationSelectionScopeKey({
      providerKey: "tcgdex",
      unitKey: "tcgdex:pokemon:card:import",
      importScope: "en:3:base:base1",
      profileVersion: "2026.06.04",
    });

    writePersistedObservationSelection(scopeKey, ["obs_1", "obs_2"]);

    expect(readPersistedObservationSelection(scopeKey)).toEqual(["obs_1", "obs_2"]);
  });

  it("survives being re-read as though the page reloaded (storage, not in-memory state)", () => {
    const scopeKey = observationSelectionScopeKey({
      providerKey: "tcgdex",
      unitKey: "tcgdex:pokemon:card:import",
      importScope: "en:3:base:base1",
      profileVersion: "2026.06.04",
    });
    writePersistedObservationSelection(scopeKey, ["obs_1"]);

    // A second, independent read call simulates a fresh mount after reload: the
    // module holds no in-memory cache, so this only passes if sessionStorage
    // itself carried the value.
    expect(readPersistedObservationSelection(scopeKey)).toEqual(["obs_1"]);
  });

  it("holds a 500-row selection without truncation or error", () => {
    const scopeKey = observationSelectionScopeKey({
      providerKey: "tcgdex",
      unitKey: "tcgdex:pokemon:card:import",
      importScope: "en:3:base:base1",
      profileVersion: "2026.06.04",
    });
    const ids = Array.from({ length: 500 }, (_, index) => `obs_${index.toString().padStart(4, "0")}`);

    writePersistedObservationSelection(scopeKey, ids);

    expect(readPersistedObservationSelection(scopeKey)).toHaveLength(500);
    expect(readPersistedObservationSelection(scopeKey)).toEqual(ids);
  });

  it("scopes selections independently per provider/unit/import-scope/profile", () => {
    const scopeA = observationSelectionScopeKey({
      providerKey: "tcgdex",
      unitKey: "tcgdex:pokemon:card:import",
      importScope: "en:3:base:base1",
      profileVersion: "2026.06.04",
    });
    const scopeB = observationSelectionScopeKey({
      providerKey: "scryfall",
      unitKey: "scryfall:mtg:card:import",
      importScope: "en:1:mtg:mtg1",
      profileVersion: "2026.06.05",
    });

    writePersistedObservationSelection(scopeA, ["obs_a"]);
    writePersistedObservationSelection(scopeB, ["obs_b"]);

    expect(readPersistedObservationSelection(scopeA)).toEqual(["obs_a"]);
    expect(readPersistedObservationSelection(scopeB)).toEqual(["obs_b"]);
  });

  it("clears the persisted entry when the selection empties", () => {
    const scopeKey = observationSelectionScopeKey({
      providerKey: "tcgdex",
      unitKey: null,
      importScope: null,
      profileVersion: null,
    });
    writePersistedObservationSelection(scopeKey, ["obs_1"]);
    expect(readPersistedObservationSelection(scopeKey)).toEqual(["obs_1"]);

    writePersistedObservationSelection(scopeKey, []);

    expect(readPersistedObservationSelection(scopeKey)).toEqual([]);
    expect(window.sessionStorage.getItem(`catalog.primaryWorkbench.observationSelection.${scopeKey}`)).toBeNull();
  });

  it("returns an empty selection for malformed stored JSON instead of throwing", () => {
    const scopeKey = "malformed-scope";
    window.sessionStorage.setItem(`catalog.primaryWorkbench.observationSelection.${scopeKey}`, "{not-json");

    expect(readPersistedObservationSelection(scopeKey)).toEqual([]);
  });
});
