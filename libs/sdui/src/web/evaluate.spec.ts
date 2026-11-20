import { describe, expect, it, vi } from 'vitest';
import {
  checkUrl,
  createEvaluator,
  toBoolean,
  type ReportedError,
} from './evaluate.js';

function evaluator(
  model: unknown,
  extra: Partial<Parameters<typeof createEvaluator>[0]> = {},
) {
  const errors: ReportedError[] = [];
  const opened: string[] = [];
  const e = createEvaluator({
    model: () => model,
    locale: 'en-US',
    timeZone: 'UTC',
    report: (error) => errors.push(error),
    openUrl: (url) => opened.push(url),
    ...extra,
  });
  return { e, errors, opened };
}

describe('evaluating dynamic values', () => {
  it('reads bindings, absolute and relative to a template item', () => {
    const { e } = evaluator({
      user: { name: 'Ada' },
      items: [{ title: 'one' }, { title: 'two' }],
    });
    expect(e.value({ '@path': '/user/name' })).toBe('Ada');
    expect(
      e.value({ '@path': 'title' }, { base: ['items', '1'], index: 1 }),
    ).toBe('two');
    expect(e.value({ '@path': '/missing/deep' })).toBeNull();
    expect(
      e.value(
        { '@call': '@index', args: { offset: 1 } },
        { base: ['items', '1'], index: 1 },
      ),
    ).toBe(2);
  });

  it('runs the product card from the upstream examples', () => {
    const { e, errors } = evaluator({
      reviewCount: 1280,
      price: 129.5,
      one: 1,
    });
    const reviews = {
      '@call': 'formatString',
      args: {
        value:
          "(${formatNumber(value: ${/reviewCount})} ${pluralize(value: ${/reviewCount}, one: 'review', other: 'reviews')})",
      },
    };
    expect(e.text(reviews)).toBe('(1,280 reviews)');
    expect(
      e.text({
        '@call': 'formatCurrency',
        args: { value: { '@path': '/price' }, currency: 'USD' },
      }),
    ).toBe('$129.50');
    expect(
      e.text({
        '@call': 'formatString',
        args: {
          value: "${pluralize(value: ${/one}, one: 'item', other: 'items')}",
        },
      }),
    ).toBe('item');
    expect(errors).toEqual([]);
  });

  it('formats dates by TR35 pattern, in the given time zone', () => {
    const { e } = evaluator({});
    const at = '2026-02-02T15:17:00Z';
    expect(
      e.text({
        '@call': 'formatDate',
        args: { value: at, format: 'E MMM d, YYYY h:mm a' },
      }),
    ).toBe('Mon Feb 2, 2026 3:17 PM');
    expect(
      e.text({
        '@call': 'formatDate',
        args: { value: at, format: 'EEEE, d MMMM' },
      }),
    ).toBe('Monday, 2 February');
    expect(
      e.text({
        '@call': 'formatDate',
        args: { value: at, format: "HH:mm 'UTC'" },
      }),
    ).toBe('15:17 UTC');
    expect(
      e.text({
        '@call': 'formatDate',
        args: { value: at, format: 'yy-MM-dd' },
      }),
    ).toBe('26-02-02');
  });

  it('interpolates templates, escapes \\${, and stringifies the way the spec says', () => {
    const { e } = evaluator({ n: 3, nothing: null, obj: { a: 1 } });
    expect(
      e.text({
        '@call': 'formatString',
        args: { value: 'n=${/n} x=${/nothing} o=${/obj} \\${literal}' },
      }),
    ).toBe('n=3 x= o={"a":1} ${literal}');
  });

  it('applies the boolean coercions and runs checks', () => {
    expect(
      [
        true,
        'TRUE',
        'false',
        'hello',
        0,
        2,
        null,
        { valid: true },
        { valid: false },
      ].map(toBoolean),
    ).toEqual([true, true, false, false, false, true, false, true, false]);
    const { e } = evaluator({ email: 'nope', phone: '5551234567' });
    const checks = [
      {
        condition: {
          '@call': 'required',
          args: { value: { '@path': '/email' } },
        },
        message: 'Email is required.',
      },
      {
        condition: { '@call': 'email', args: { value: { '@path': '/email' } } },
        message: 'Please enter a valid email address.',
      },
      {
        condition: {
          '@call': 'regex',
          args: { value: { '@path': '/phone' }, pattern: '^\\d{10}$' },
        },
        message: 'Ten digits.',
      },
      {
        condition: {
          '@call': 'and',
          args: {
            values: [{ '@call': 'required', args: { value: 'x' } }, true],
          },
        },
        message: 'never shown',
      },
    ];
    expect(e.checks(checks)).toEqual({
      valid: false,
      messages: ['Please enter a valid email address.'],
    });
  });

  it('reports, and does not throw, on what an agent got wrong', () => {
    const { e, errors } = evaluator({});
    expect(e.value({ '@call': 'eval', args: { code: 'alert(1)' } })).toBeNull();
    expect(
      e.value({ '@call': 'regex', args: { value: 'aaaa', pattern: '(a+)+$' } }),
    ).toBeNull();
    expect(e.value({ '@call': '@index' })).toBeNull();
    expect(
      e.text({ '@call': 'formatString', args: { value: '${unclosed' } }),
    ).toBe('');
    expect(errors.map((error) => error.code)).toEqual([
      'EXPRESSION_ERROR',
      'EXPRESSION_ERROR',
      'EXPRESSION_ERROR',
      'EXPRESSION_ERROR',
    ]);
    expect(errors[1]?.message).toMatch(/backtrack/);
  });

  it('stops a value that calls too much or nests too deep', () => {
    const { e, errors } = evaluator({});
    let deep: unknown = true;
    for (let i = 0; i < 40; i++)
      deep = { '@call': 'not', args: { value: deep } };
    expect(e.value(deep)).toBeNull();
    const wide = {
      '@call': 'and',
      args: {
        values: Array.from({ length: 300 }, () => ({
          '@call': 'not',
          args: { value: false },
        })),
      },
    };
    expect(e.value(wide)).toBeNull();
    expect(errors).toHaveLength(2);
  });

  it('unescapes @@ keys in literal objects', () => {
    const { e } = evaluator({});
    expect(e.value({ '@@type': 'literal', plain: { '@path': '/x' } })).toEqual({
      '@type': 'literal',
      plain: null,
    });
  });

  it('opens URLs only from a gesture, and only allowed ones', () => {
    const { e, errors, opened } = evaluator({});
    const open = (url: string) => ({ '@call': 'openUrl', args: { url } });
    e.value(open('https://example.com/'));
    expect(opened).toEqual([]);
    e.activate(open('https://example.com/'));
    e.activate(open('javascript:alert(1)'));
    e.activate(open('java\tscript:alert(1)'));
    expect(opened).toEqual(['https://example.com/']);
    expect(errors.map((error) => error.message)).toEqual([
      'openUrl can only run from a user gesture',
      expect.stringMatching(/blocked-url/),
      expect.stringMatching(/blocked-url/),
    ]);
  });
});

describe('the URL policy', () => {
  it.each([
    ['https://example.com/a', 'link', true],
    ['/relative/path', 'link', true],
    ['mailto:a@example.com', 'link', true],
    ['javascript:alert(1)', 'link', false],
    [' JaVaScRiPt:alert(1)', 'link', false],
    ['vbscript:x', 'link', false],
    ['data:text/html,<script>alert(1)</script>', 'link', false],
    ['data:text/html,<script>alert(1)</script>', 'image', false],
    ['data:image/png;base64,iVBORw0KGgo=', 'image', true],
    // media loads by itself, so it is a way out: no host by default
    ['https://images.example/a.png', 'image', false],
    ['https://attacker.example/p?d=hunter2', 'media', false],
    ['/img/a.png', 'image', true],
    ['data:image/svg+xml;base64,PHN2Zz4=', 'image', false],
    ['mailto:a@example.com', 'media', false],
    ['//evil.example/x', 'link', true],
  ] as const)('%s for a %s → %s', (url, use, ok) => {
    expect(checkUrl(url, use).ok).toBe(ok);
  });

  it('limits hosts when asked', () => {
    const policy = {
      hosts: ['example.com'],
      mediaHosts: ['*.cdn.example.com'],
    };
    expect(checkUrl('https://example.com/', 'link', policy).ok).toBe(true);
    expect(
      checkUrl('https://img.cdn.example.com/a.png', 'image', policy).ok,
    ).toBe(true);
    expect(checkUrl('https://example.com/a.png', 'image', policy).ok).toBe(
      false,
    );
    expect(checkUrl('https://evil.example/', 'link', policy).ok).toBe(false);
    expect(checkUrl('//evil.example/x', 'link', policy).ok).toBe(false);
    expect(
      checkUrl('https://cdn.example.com.evil.example/', 'link', policy).ok,
    ).toBe(false);
  });

  it('does not touch the page while checking', () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    checkUrl('https://example.com', 'link');
    expect(spy).not.toHaveBeenCalled();
  });
});
