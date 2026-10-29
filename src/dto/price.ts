/** Fader shows every price in this currency (fader-ui#154). */
export const PRICE_CURRENCY = "EUR";

export interface ShownPrice {
  /** The cheapest current price on Discogs in `lowestPriceCurrency`; null when there is none to show. */
  lowestPrice: number | null;
  /** Always `PRICE_CURRENCY` when there is a price, otherwise null. */
  lowestPriceCurrency: string | null;
}

/**
 * The price a release shows. A price stored in another currency, or with none known, is not
 * shown: mixing currencies in one column or labelling a number with the wrong one is worse than
 * a gap.
 */
export function shownPrice(lowestPrice: number | null, currency: string | null): ShownPrice {
  return lowestPrice !== null && currency === PRICE_CURRENCY
    ? { lowestPrice, lowestPriceCurrency: PRICE_CURRENCY }
    : { lowestPrice: null, lowestPriceCurrency: null };
}
