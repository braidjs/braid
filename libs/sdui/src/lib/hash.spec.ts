import { createHash } from 'node:crypto';
import { contentAddress, hash32, sha256Hex } from './hash.js';

describe('sha256Hex', () => {
  it('matches the published test vectors', () => {
    expect(sha256Hex('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(
      sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'),
    ).toBe('248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
  });

  it('agrees with the platform implementation across block boundaries and non-ASCII text', () => {
    const samples = [55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 1000].map(
      (length) => 'x'.repeat(length),
    );
    samples.push('naïve café — 東京 🎒', '\u0000', 'a'.repeat(70_000));
    for (const sample of samples) {
      expect(sha256Hex(sample)).toBe(
        createHash('sha256').update(sample, 'utf8').digest('hex'),
      );
    }
  });

  it('exposes the first 32 bits for bucketing', () => {
    expect(hash32('abc')).toBe(0xba7816bf);
  });
});

describe('contentAddress', () => {
  it('ignores key order and respects array order', () => {
    expect(contentAddress('x_', { a: 1, b: [1, 2] })).toBe(
      contentAddress('x_', { b: [1, 2], a: 1 }),
    );
    expect(contentAddress('x_', { a: 1, b: [1, 2] })).not.toBe(
      contentAddress('x_', { a: 1, b: [2, 1] }),
    );
  });

  it('is the prefix and 32 hex characters', () => {
    expect(contentAddress('scr_', { any: 'thing' })).toMatch(
      /^scr_[0-9a-f]{32}$/,
    );
  });
});
