import { moneyToCents, normalizeMoneyAmount, type MoneyAmount } from "@chase-sets/primitives/money";
import type { PortfolioConstraint, PortfolioListing } from "../../domain/portfolio/portfolio";
import { portfolioScenario, type PortfolioFixtureListing, type PortfolioScenarioName } from "./portfolio-parity";

/** The fixture's synthetic constraint, as the app's `applyConstraint`: never below the floor. */
export function floorConstraint(floorAmount: string): PortfolioConstraint {
  const floor = normalizeMoneyAmount(floorAmount);
  return {
    identity: `floor:${floorAmount}`,
    apply: (priceAmount: MoneyAmount) => (moneyToCents(priceAmount) < moneyToCents(floor) ? floor : priceAmount),
  };
}

export function toPortfolioListing(listing: PortfolioFixtureListing): PortfolioListing {
  return {
    listingId: listing.listingId,
    currentPriceAmount: listing.currentPriceAmount === null ? null : normalizeMoneyAmount(listing.currentPriceAmount),
    curve: listing.curve,
    ...(listing.floorAmount === null ? {} : { constraint: floorConstraint(listing.floorAmount) }),
  };
}

export const scenarioListings = (name: PortfolioScenarioName): readonly PortfolioListing[] =>
  portfolioScenario(name).map(toPortfolioListing);
