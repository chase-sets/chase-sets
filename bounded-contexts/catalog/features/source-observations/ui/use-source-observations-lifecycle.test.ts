import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../../../support/shell-support/api/client";
import {
  rollbackSourceObservationProviderProfile,
  deprecateSourceObservationProviderProfile,
  retireSourceObservationProviderProfile,
} from "./use-source-observations";

afterEach(() => vi.restoreAllMocks());

describe("provider profile lifecycle UI wrappers", () => {
  it.each([
    ["rollbackSourceObservationProviderProfile", rollbackSourceObservationProviderProfile],
    ["deprecateSourceObservationProviderProfile", deprecateSourceObservationProviderProfile],
    ["retireSourceObservationProviderProfile", retireSourceObservationProviderProfile],
  ] as const)("forwards caller input through %s without generating consent", async (method, command) => {
    const result = { providerKey: "synthetic-provider", profileVersion: "synthetic-version" };
    const request = vi.spyOn(api, method).mockResolvedValue(result);
    for (const confirmation of [null, "", " mismatched caller input "]) {
      await expect(command(result.providerKey, result.profileVersion, confirmation)).resolves.toBe(result);
      expect(request).toHaveBeenLastCalledWith(result.providerKey, result.profileVersion, confirmation);
    }
  });
});
