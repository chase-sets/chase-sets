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
           AND ${accountAlias}.seller_listing_availability_status = 'available'
           AND ${listingAlias}.product_measure_snapshot IS NOT NULL
           AND ${buyerVisibleListingQuantitySql(listingAlias)} > 0`;
}
