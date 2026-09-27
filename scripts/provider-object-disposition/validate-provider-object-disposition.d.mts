import type fixture from "./provider-object-disposition-option-b.fixture.json";

export const OPTION_B_CLASS_TABLE: readonly (typeof fixture.classTable)[number][];
export const SCENARIO_FIXTURES: typeof fixture.scenarios;
export function parseStrictRfc3339(value: unknown): { ms: number } | null;
export function validateProviderObjectDisposition(document: unknown): {
  ok: boolean;
  errors: readonly { code: string; path: string }[];
};
