import { describe, expect, it } from "vitest";
import { decideAccount, evolveAccount, initialAccountState, type CreateAccountCommand } from "./domain";

const account: CreateAccountCommand = {
  type: "CreateAccount",
  accountId: "acc_01ARYZ6S41TSV4RRFFQ69G5FAV",
  name: "Legal Name",
  accountType: "personal",
};

describe("Account display-name safeguard", () => {
  it.each([
    ["Marker\u0000", "text_control_character"],
    ["Marker\u202e", "text_direction_override"],
    ["Marker ｊａｖａ\u200bｓｃｒｉｐｔ：x", "text_unsafe_link"],
    ["Marker http://example.test", "text_unsafe_link"],
    ["Marker https://example.test/ https://EXAMPLE.test.", "text_duplicate_link"],
  ])("rejects newly authored names on creation and update with only %s's closed code", (displayName, code) => {
    const current = decideAccount(initialAccountState, account).reduce(evolveAccount, initialAccountState);
    for (const decide of [
      () => decideAccount(initialAccountState, { ...account, displayName }),
      () => decideAccount(current, { type: "UpdateAccountProfile", name: account.name, displayName }),
    ]) {
      expect(decide).toThrow(code);
      try {
        decide();
      } catch (error) {
        expect((error as Error).message).toBe(code);
      }
    }
  });

  it.each(["François", "卡牌收藏", "\u200fمتجر", "Store 👩‍🔬", "Note: x", "Shop https://example.test"])(
    "keeps ordinary text unchanged: %s",
    (displayName) => {
      expect(decideAccount(initialAccountState, { ...account, displayName })[0]?.data).toMatchObject({ displayName });
    },
  );

  it("replays and carries forward an unchanged legacy name without judging it", () => {
    const displayName = "Legacy\u202e";
    const state = evolveAccount(initialAccountState, {
      type: "identity.account.created",
      data: { accountId: account.accountId, accountType: account.accountType, name: account.name, displayName },
    });
    const events = decideAccount(state, { type: "UpdateAccountProfile", name: "Different legal name", displayName });
    expect(events.reduce(evolveAccount, state).displayName).toBe(displayName);
    expect(() => decideAccount(state, { type: "UpdateAccountProfile", name: "javascript:x" })).toThrow(
      "text_unsafe_link",
    );
  });
});
