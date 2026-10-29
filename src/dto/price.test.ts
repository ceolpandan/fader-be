import { describe, it, expect } from "vitest";
import { PRICE_CURRENCY, shownPrice } from "./price";

describe("shownPrice", () => {
  it("shows a price stored in euro", () => {
    expect(shownPrice(12.5, "EUR")).toEqual({ lowestPrice: 12.5, lowestPriceCurrency: PRICE_CURRENCY });
  });

  it("keeps a price of 0", () => {
    expect(shownPrice(0, "EUR")).toEqual({ lowestPrice: 0, lowestPriceCurrency: "EUR" });
  });

  it("shows no price stored in another currency, or with none known", () => {
    expect(shownPrice(12.5, "USD")).toEqual({ lowestPrice: null, lowestPriceCurrency: null });
    expect(shownPrice(12.5, null)).toEqual({ lowestPrice: null, lowestPriceCurrency: null });
  });

  it("shows nothing for a release with no price", () => {
    expect(shownPrice(null, "EUR")).toEqual({ lowestPrice: null, lowestPriceCurrency: null });
    expect(shownPrice(null, null)).toEqual({ lowestPrice: null, lowestPriceCurrency: null });
  });
});
