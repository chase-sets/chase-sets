import { describe, expect, it } from "vitest";
import { assertIdentitySurvival } from "./identity-controls.mjs";

const owned = [
  { pid: 10, parent: 1, start: 100, image: "launcher", device: 1, inode: 20 },
  { pid: 11, parent: 10, start: 101, image: "launcher", device: 1, inode: 20 },
  { pid: 12, parent: 11, start: 102, image: "chrome", device: 1, inode: 21 },
];

describe("control-13 lifetime identity survival", () => {
  it("accepts only unchanged recorded identities, including an empty alone case", () => {
    expect(() => assertIdentitySurvival(owned, structuredClone(owned))).not.toThrow();
    expect(() => assertIdentitySurvival([], [])).not.toThrow();
  });

  it.each([0, 1, 2])("negative control: a remover killing recorded role %i still fails", (index) => {
    const killed = owned.filter((_, position) => position !== index);
    expect(() => assertIdentitySurvival(owned, killed)).toThrow();
  });

  it.each(["pid", "parent", "start", "image", "device", "inode"])(
    "rejects %s drift even when all roles remain present",
    (field) => {
      const replaced = structuredClone(owned);
      replaced[2][field] = field === "image" ? "launcher" : replaced[2][field] + 1;
      expect(() => assertIdentitySurvival(owned, replaced)).toThrow();
    },
  );
});
