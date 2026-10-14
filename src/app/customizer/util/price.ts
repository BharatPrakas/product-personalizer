import type { DisplayPriceSpec } from '../models/config.models';
import type { PriceSnapshot } from '../models/draft.models';

/** Integer minor units to a localised currency string; 59900 / exponent 2 / INR -> "₹599.00". */
export function formatMinor(minor: number, currency: string, exponent: number): string {
  const value = minor / 10 ** exponent;
  try {
    return new Intl.NumberFormat('en', {
      style: 'currency',
      currency,
      minimumFractionDigits: exponent,
      maximumFractionDigits: exponent,
    }).format(value);
  } catch {
    return `${currency} ${value.toFixed(exponent)}`;
  }
}

export function priceSnapshot(spec: DisplayPriceSpec): PriceSnapshot {
  return {
    currency: spec.currency,
    exponent: spec.exponent,
    baseMinor: spec.baseMinor,
    customizationFeeMinor: spec.customizationFeeMinor,
    totalMinor: spec.baseMinor + spec.customizationFeeMinor,
    authoritative: false,
  };
}
