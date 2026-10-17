import { attachResponseMetadata } from "@chase-sets/http/responses";
import { closedObject } from "../domain/contract";
import { validateShippingAddressSnapshot } from "../domain/owner-event";

export async function parseAccountMutationResponse<T>(
  response: Response,
  keyed: boolean,
  legacy: (response: Response) => Promise<T>,
): Promise<T> {
  if (keyed && [400, 409, 503].includes(response.status)) {
    try {
      const result = closedObject(await response.clone().json(), ["outcome", "code", "suggestedAddress", "current"]);
      if (result.current !== undefined) {
        const current = closedObject(result.current, ["id", "version", "status"]);
        if (
          result.outcome !== "conflict" ||
          typeof current.id !== "string" ||
          current.id.length > 100 ||
          !Number.isSafeInteger(current.version) ||
          Number(current.version) < 0 ||
          typeof current.status !== "string" ||
          current.status.length > 30
        )
          throw new Error("INDETERMINATE");
      }
      if (
        result.suggestedAddress !== undefined &&
        (result.outcome !== "not-recorded" || result.code !== "address-standardization-suggested")
      )
        throw new Error("INDETERMINATE");
      if (result.suggestedAddress !== undefined) validateShippingAddressSnapshot(result.suggestedAddress);
      const status =
        result.outcome === "conflict"
          ? 409
          : result.outcome === "not-recorded"
            ? 400
            : result.outcome === "indeterminate"
              ? 503
              : null;
      if (status === response.status && typeof result.code === "string" && /^[a-zA-Z0-9-]{1,100}$/.test(result.code))
        return attachResponseMetadata(result, response) as T;
    } catch {
      /* The shipped error parser retains authority over all other responses. */
    }
  }
  return legacy(response);
}
