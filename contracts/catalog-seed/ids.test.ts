import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { representativePersonaIds } from "./ids";

describe("representative persona Identity parity", () => {
  it("keeps both typed staging aliases paired with the Identity seed's User and Account", () => {
    const seed = readFileSync(new URL("../../bounded-contexts/identity/support/runtime-support/seed.ts", import.meta.url), "utf8");
    expect(Object.keys(representativePersonaIds)).toEqual(["card-vault", "sealed-stockroom"]);
    for (const persona of Object.values(representativePersonaIds)) {
      expect(seed).toMatch(new RegExp(`accountId: "${persona.accountId}",\\s+userId: "${persona.userId}"`));
    }
  });
});
