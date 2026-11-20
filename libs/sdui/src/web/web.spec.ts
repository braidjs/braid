// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from 'vitest';
import { A2UI_BASIC_CATALOG_ID } from '../a2ui/basic.js';
import type { A2uiRendererMessage } from '../a2ui/messages.js';
import { upstreamExamples } from '../a2ui/upstream.spec-util.js';
import { type A2uiSurfaceElement, defineA2uiSurface } from './element.js';
import { renderA2uiHtml } from './html.js';

const examples = upstreamExamples();
const B = A2UI_BASIC_CATALOG_ID;

beforeAll(() => {
  defineA2uiSurface();
});

/** A fresh element in the document, and every message it sends. */
function mount(): { element: A2uiSurfaceElement; sent: A2uiRendererMessage[] } {
  const element = document.createElement('a2ui-surface') as A2uiSurfaceElement;
  const sent: A2uiRendererMessage[] = [];
  element.addEventListener('a2ui:message', (event) =>
    sent.push((event as CustomEvent).detail),
  );
  document.body.append(element);
  return { element, sent };
}
/** A task, then every element in the page settled: what was pushed is applied and drawn. */
const flush = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.all(
    [...document.querySelectorAll('*')].flatMap((element) =>
      typeof (element as Partial<A2uiSurfaceElement>).settled === 'function'
        ? [(element as A2uiSurfaceElement).settled()]
        : [],
    ),
  );
};

describe('rendering the upstream examples', () => {
  it.each(examples.map((example) => [example.file, example] as const))(
    '%s draws with no errors',
    async (_file, example) => {
      const { html, errors } = renderA2uiHtml(example.messages, {
        locale: 'en-US',
        timeZone: 'UTC',
      });
      expect(errors).toEqual([]);
      expect(html).toContain('data-a2ui-surface=');
      const { element, sent } = mount();
      element.push(example.messages);
      await flush();
      expect(sent).toEqual([]);
      expect(element.querySelector('[data-a2ui-id="root"]')).not.toBeNull();
      expect(element.querySelector('[data-a2ui-pending]')).toBeNull();
      element.remove();
    },
  );
});

describe('taking over prerendered HTML', () => {
  it('adopts the server’s elements instead of replacing them, with the same text', async () => {
    const example = examples.find((e) => e.file === 'product-card.json')!;
    const { html } = renderA2uiHtml(example.messages, {
      locale: 'en-US',
      timeZone: 'UTC',
    });
    const host = document.createElement('div');
    // the test plays the part of the HTML parser: a page served with this markup in it
    host.innerHTML = html
      .replace('<a2ui-surface', '<a2ui-surface-pending')
      .replace('</a2ui-surface>', '</a2ui-surface-pending>');
    const served = host.firstElementChild!;
    // what a reader sees: the text, not the messages carried in the script
    const before = [...served.childNodes]
      .filter((n) => n.nodeName !== 'SCRIPT')
      .map((n) => n.textContent)
      .join('');
    const root = served.querySelector('[data-a2ui-id="root"]');
    expect(before).toMatch(/\$/);

    const element = document.createElement(
      'a2ui-surface',
    ) as A2uiSurfaceElement;
    for (const attribute of served.getAttributeNames())
      element.setAttribute(attribute, served.getAttribute(attribute)!);
    element.append(...served.childNodes);
    const sent: A2uiRendererMessage[] = [];
    element.addEventListener('a2ui:message', (event) =>
      sent.push((event as CustomEvent).detail),
    );
    document.body.append(element);
    await flush();

    expect(sent).toEqual([]);
    expect(element.querySelector('[data-a2ui-id="root"]')).toBe(root);
    expect(element.textContent).toBe(before);
    expect(element.querySelector('script')).toBeNull();
    element.remove();
  });
});

describe('two-way binding', () => {
  const stream = [
    {
      version: '1.0',
      createSurface: {
        surfaceId: 'form',
        catalogId: B,
        dataModel: { name: 'Ada', email: '' },
      },
    },
    {
      version: '1.0',
      updateComponents: {
        surfaceId: 'form',
        components: [
          {
            id: 'root',
            component: 'Column',
            children: ['name', 'hello', 'email', 'send'],
          },
          {
            id: 'name',
            component: 'TextField',
            label: 'Name',
            value: { '@path': '/name' },
          },
          {
            id: 'hello',
            component: 'Text',
            text: {
              '@call': 'formatString',
              args: { value: 'Hello, ${/name}' },
            },
          },
          {
            id: 'email',
            component: 'TextField',
            label: 'Email',
            value: { '@path': '/email' },
            '@checks': [
              {
                condition: {
                  '@call': 'email',
                  args: { value: { '@path': '/email' } },
                },
                message: 'Enter an email.',
              },
            ],
          },
          {
            id: 'send',
            component: 'Button',
            child: 'sendLabel',
            action: {
              event: {
                name: 'submit',
                context: {
                  name: { '@path': '/name' },
                  email: { '@path': '/email' },
                },
              },
            },
            '@checks': [
              {
                condition: {
                  '@call': 'email',
                  args: { value: { '@path': '/email' } },
                },
                message: 'Enter an email first.',
              },
            ],
          },
          { id: 'sendLabel', component: 'Text', text: 'Send' },
        ],
      },
    },
  ];

  it('typing updates what is bound to the same path, and keeps the caret', async () => {
    const { element, sent } = mount();
    element.push(stream);
    await flush();
    const input = element.querySelector<HTMLInputElement>(
      '[data-a2ui-id="name"] input',
    )!;
    input.focus();
    input.value = 'Adalyn';
    input.setSelectionRange(3, 3);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await flush();
    expect(element.querySelector('[data-a2ui-id="hello"]')!.textContent).toBe(
      'Hello, Adalyn',
    );
    expect(element.querySelector('[data-a2ui-id="name"] input')).toBe(input);

    // the agent changes the value under the user's cursor
    element.push([
      {
        version: '1.0',
        updateDataModel: { surfaceId: 'form', path: '/name', value: 'Adalynn' },
      },
    ]);
    await flush();
    expect(element.querySelector('[data-a2ui-id="name"] input')).toBe(input);
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe('Adalynn');
    expect([input.selectionStart, input.selectionEnd]).toEqual([3, 3]);
    expect(sent).toEqual([]);
    element.remove();
  });

  it('a button whose checks fail is disabled and says why; once valid, one click sends one action', async () => {
    const { element, sent } = mount();
    element.push(stream);
    await flush();
    const button = () =>
      element.querySelector<HTMLButtonElement>(
        '[data-a2ui-id="send"] button, button[data-a2ui-id="send"]',
      )!;
    expect(button().disabled).toBe(true);
    expect(
      element.querySelector('[data-a2ui-id="send"]')!.textContent,
    ).toContain('Enter an email first.');
    button().click();
    await flush();
    expect(sent).toEqual([]);

    const email = element.querySelector<HTMLInputElement>(
      '[data-a2ui-id="email"] input',
    )!;
    email.value = 'ada@example.com';
    email.dispatchEvent(new Event('input', { bubbles: true }));
    await flush();
    expect(button().disabled).toBe(false);
    button().click();
    await flush();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      action: {
        name: 'submit',
        surfaceId: 'form',
        sourceComponentId: 'send',
        context: { name: 'Ada', email: 'ada@example.com' },
      },
    });
    element.remove();
  });
});

describe('hostile content', () => {
  const hostile = [
    {
      version: '1.0',
      createSurface: {
        surfaceId: 'x',
        catalogId: B,
        dataModel: { evil: '<img src=x onerror="window.__pwned=1">' },
      },
    },
    {
      version: '1.0',
      updateComponents: {
        surfaceId: 'x',
        components: [
          {
            id: 'root',
            component: 'Column',
            children: ['t1', 't2', 't3', 'i1', 'b1', 'v1', 'icon'],
          },
          {
            id: 't1',
            component: 'Text',
            text: '<script>window.__pwned=1</script><b onclick="x()">bold</b>',
          },
          { id: 't2', component: 'Text', text: { '@path': '/evil' } },
          {
            id: 't3',
            component: 'Text',
            text: '[click me](javascript:window.__pwned=1) and [ok](https://example.com)',
          },
          {
            id: 'i1',
            component: 'Image',
            url: 'javascript:window.__pwned=1',
            description: 'a picture',
          },
          {
            id: 'v1',
            component: 'Video',
            url: 'data:text/html,<script>1</script>',
          },
          {
            id: 'b1',
            component: 'Button',
            child: 'bl',
            action: {
              functionCall: {
                '@call': 'openUrl',
                args: { url: 'javascript:window.__pwned=1' },
              },
            },
          },
          { id: 'bl', component: 'Text', text: 'Open' },
          {
            id: 'icon',
            component: 'Icon',
            name: { svgPath: 'M0 0" onload="window.__pwned=1' },
          },
        ],
      },
    },
  ];

  for (const where of ['dom', 'html'] as const) {
    it(`stays inert — ${where}`, async () => {
      let root: Element;
      const sent: A2uiRendererMessage[] = [];
      if (where === 'html') {
        const container = document.createElement('div');
        container.innerHTML = renderA2uiHtml(hostile).html.replace(
          /<script type="application\/a2ui\+json">[\s\S]*?<\/script>/,
          '',
        );
        root = container;
      } else {
        const mounted = mount();
        mounted.element.push(hostile);
        await flush();
        root = mounted.element;
        root.querySelector<HTMLButtonElement>('button')!.click();
        await flush();
        sent.push(...mounted.sent);
      }
      expect(
        root.querySelectorAll('script, iframe, object, embed, style, link')
          .length,
      ).toBe(0);
      for (const element of root.querySelectorAll('*'))
        for (const name of element.getAttributeNames())
          expect(name.startsWith('on')).toBe(false);
      for (const element of root.querySelectorAll('[href], [src], [poster]'))
        for (const name of ['href', 'src', 'poster'])
          expect(element.getAttribute(name) ?? '').not.toMatch(
            /^\s*(javascript|data:text)/i,
          );
      expect(root.querySelector('img')).toBeNull();
      expect(root.querySelector('[data-a2ui-id="t1"]')!.textContent).toContain(
        '<script>',
      );
      // the image and the video; a Markdown link is its words, never an <a>
      expect(
        root.querySelectorAll('[data-a2ui-state="blocked-url"]').length,
      ).toBe(2);
      expect(root.querySelector('a')).toBeNull();
      expect(root.querySelector('[data-a2ui-id="t3"]')!.textContent).toBe(
        'click me and ok',
      );
      expect(
        (window as unknown as { __pwned?: number }).__pwned,
      ).toBeUndefined();
      if (where === 'dom') {
        expect(sent).toHaveLength(1);
        expect(sent[0]).toMatchObject({
          error: { code: 'EXPRESSION_ERROR', surfaceId: 'x' },
        });
        expect(JSON.stringify(sent[0])).toMatch(/blocked-url/);
      }
    });
  }
});
