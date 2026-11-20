/** admin-web serves Return Intake in its Commerce section (context.json's route section). */
export const returnIntakePath = "/commerce/return-intake";

/** The Return Intake station for a facility, with any extra query parameters. */
export function returnIntakeHref(facilityId: string, query: Readonly<Record<string, string>> = {}) {
  return `${returnIntakePath}?${new URLSearchParams({ facilityId, ...query }).toString()}`;
}
