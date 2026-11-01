import { createContext, useContext, useState, type ReactNode } from "react";
import type { OfferMatchListItem } from "./contracts";

type HeldDeclineAttempts = Readonly<{
  sessionId: string | null;
  accounts: Map<string, Map<string, string>>;
}>;

type DeclinableOfferMatch = Pick<OfferMatchListItem, "offer_id" | "status">;

const OfferMatchDeclineAttemptContext = createContext<Map<string, string> | null>(null);

function holdDeclineAttempts(sessionId: string | null): HeldDeclineAttempts {
  return { sessionId, accounts: new Map() };
}

function heldOffersFor(held: HeldDeclineAttempts, accountId: string) {
  let offers = held.accounts.get(accountId);
  if (!offers) {
    offers = new Map();
    held.accounts.set(accountId, offers);
  }
  return offers;
}

/**
 * Holds one Offer Match decline attempt id per account and Offer for the
 * signed-in Auth session. Mounted above the Offer Match routes, it keeps a
 * decline's id through detail navigation, back and the list's realtime-keyed
 * remount, so a retry recovers the first result. Each mounted tree (each server
 * render) holds its own ids; a new session or a signed-out actor drops them
 * before the next render.
 */
export function OfferMatchDeclineAttemptProvider({
  sessionId,
  accountId,
  children,
}: Readonly<{
  sessionId: string | null;
  accountId: string | null;
  children: ReactNode;
}>) {
  const [held, setHeld] = useState(() => holdDeclineAttempts(sessionId));
  let current = held;
  if (current.sessionId !== sessionId) {
    current = holdDeclineAttempts(sessionId);
    setHeld(current);
  }

  return (
    <OfferMatchDeclineAttemptContext.Provider value={accountId ? heldOffersFor(current, accountId) : null}>
      {children}
    </OfferMatchDeclineAttemptContext.Provider>
  );
}

function declineAttemptIdFor(offers: Map<string, string>, offer: DeclinableOfferMatch) {
  const offerId = offer.offer_id;
  // A rendered non-submitted Offer can no longer be declined, so its id is released.
  if (offer.status !== "submitted") {
    offers.delete(offerId);
    return crypto.randomUUID();
  }

  const heldAttemptId = offers.get(offerId);
  if (heldAttemptId) return heldAttemptId;

  const attemptId = crypto.randomUUID();
  offers.set(offerId, attemptId);
  return attemptId;
}

/**
 * Returns the decline attempt id for a rendered Offer Match: the provider's id
 * for the signed-in account, or, with no provider or actor above, an id held
 * for this page's lifetime.
 */
export function useOfferMatchDeclineAttemptIds() {
  const providedOffers = useContext(OfferMatchDeclineAttemptContext);
  const [pageOffers] = useState(() => new Map<string, string>());
  const offers = providedOffers ?? pageOffers;
  return (offer: DeclinableOfferMatch) => declineAttemptIdFor(offers, offer);
}
