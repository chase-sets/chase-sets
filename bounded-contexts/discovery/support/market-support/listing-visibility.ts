export function buyerVisibleListingQuantitySql(listingAlias: string): string {
  return `LEAST(
           ${listingAlias}.quantity_cap,
           GREATEST(
             COALESCE(${listingAlias}.supply_total_quantity, ${listingAlias}.quantity_cap) - COALESCE(${listingAlias}.active_held_quantity, 0),
             0
           )
         )`;
}

export function buyerVisibleListingPredicateSql(listingAlias: string, accountAlias: string): string {
  return `${listingAlias}.status = 'active'
           AND ${accountAlias}.status = 'active'
           AND ${listingAlias}.price_currency_code IS NOT NULL
           AND ${listingAlias}.listing_stream_version > 0
           AND ${accountAlias}.seller_listing_availability_status = 'available'
           AND ${listingAlias}.product_measure_snapshot IS NOT NULL
           AND ${buyerVisibleListingQuantitySql(listingAlias)} > 0`;
}

/** The single buyer-facing Offer visibility rule used by Discovery reads. */
export function buyerVisibleOfferPredicateSql(offerAlias: string, accountAlias: string): string {
  return `${offerAlias}.status = 'submitted'
           AND ${offerAlias}.price_currency_code IS NOT NULL
           AND ${offerAlias}.offer_stream_version > 0
           AND ${accountAlias}.status = 'active'`;
}
