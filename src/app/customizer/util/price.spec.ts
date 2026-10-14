import { formatMinor, priceSnapshot } from './price';

describe('display price (F09 / A19)', () => {
  it('formats the fixture 49900 + 10000, exponent 2, INR as ₹599.00', () => {
    const snapshot = priceSnapshot({
      currency: 'INR',
      exponent: 2,
      baseMinor: 49900,
      customizationFeeMinor: 10000,
    });
    expect(snapshot.totalMinor).toBe(59900);
    expect(formatMinor(snapshot.totalMinor, 'INR', 2)).toBe('₹599.00');
    expect(formatMinor(49900, 'INR', 2)).toBe('₹499.00');
    expect(formatMinor(10000, 'INR', 2)).toBe('₹100.00');
  });

  it('marks the snapshot as non-authoritative', () => {
    expect(
      priceSnapshot({ currency: 'INR', exponent: 2, baseMinor: 1, customizationFeeMinor: 1 })
        .authoritative,
    ).toBe(false);
  });

  it('honours the currency exponent from the configuration', () => {
    expect(formatMinor(1500, 'JPY', 0)).toBe('¥1,500');
    expect(formatMinor(12345, 'KWD', 3)).toMatch(/^KWD\s12\.345$/); // Intl uses a no-break space
    expect(formatMinor(5, 'USD', 2)).toBe('$0.05');
  });

  it('uses integer arithmetic for the total', () => {
    const snapshot = priceSnapshot({
      currency: 'USD',
      exponent: 2,
      baseMinor: 10,
      customizationFeeMinor: 20,
    });
    expect(snapshot.totalMinor).toBe(30);
  });
});
