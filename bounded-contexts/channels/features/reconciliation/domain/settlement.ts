export function reconciliationIsClean(
  input: Readonly<{
    listingOnly: boolean;
    listingSettled: boolean;
    salesAuthorityComplete: boolean;
  }>,
): boolean {
  return !input.listingOnly && input.listingSettled && input.salesAuthorityComplete;
}
