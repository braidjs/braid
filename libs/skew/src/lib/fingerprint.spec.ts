import { canonicalJson, fnv1a } from './fingerprint.js';

describe('canonicalJson', () => {
  it('sorts keys at every level and keeps array order', () => {
    expect(canonicalJson({ b: [2, { d: 1, c: 2 }], a: 1 })).toBe('{"a":1,"b":[2,{"c":2,"d":1}]}');
  });

  it('keeps an own __proto__ key, so documents that differ only there serialize differently', () => {
    const one = JSON.parse('{"content":"hi","__proto__":{"evil":1}}');
    const two = JSON.parse('{"content":"hi","__proto__":{"other":[1,2,3]}}');
    const none = JSON.parse('{"content":"hi"}');
    expect(canonicalJson(one)).toBe('{"__proto__":{"evil":1},"content":"hi"}');
    expect(new Set([canonicalJson(one), canonicalJson(two), canonicalJson(none)]).size).toBe(3);
    expect(fnv1a(canonicalJson(one))).not.toBe(fnv1a(canonicalJson(none)));
  });

  it('does not let a __proto__ key change the prototype of anything', () => {
    canonicalJson(JSON.parse('{"__proto__":{"polluted":true}}'));
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });
});
