export const sellerFundsHoldPolicy = {
  holdDays: 2,
} as const;

export function sellerFundsAvailableAt(postedAt: string) {
  const posted = new Date(postedAt);
  if (Number.isNaN(posted.getTime())) {
    return null;
  }

  const availableAt = new Date(posted);
  availableAt.setUTCDate(availableAt.getUTCDate() + sellerFundsHoldPolicy.holdDays);
  return availableAt.toISOString();
}

export function isSellerFundsHoldMatured(
  postedAt: string,
  now: string = new Date().toISOString(),
) {
  const availableAt = sellerFundsAvailableAt(postedAt);
  return availableAt ? Date.parse(availableAt) <= Date.parse(now) : false;
}
