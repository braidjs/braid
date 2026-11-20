import { isRecord } from '../lib/internal.js';
import type { ComponentRenderer, RenderContext } from './render.js';
import { type View, type ViewElement, h } from './view.js';

/**
 * The basic catalog's eighteen components, as plain, semantic HTML in the host's own page.
 *
 * They carry classes (`a2ui-Button`) and data attributes (`data-variant="primary"`) and no styles
 * of their own, so the host's stylesheet is what they look like: a host rule for `button` styles
 * an A2UI `Button`. `A2UI_DEFAULT_CSS` is a starting point at zero specificity, for a host that
 * has nothing yet. A host that wants its own component for a type registers it instead.
 */

const cls = (name: string) => `a2ui-${name}`;
const variant = (
  context: RenderContext,
  allowed: readonly string[],
  fallback?: string,
): string | undefined => {
  const value = context.raw('variant');
  return typeof value === 'string' && allowed.includes(value)
    ? value
    : fallback;
};
const oneOf = (
  context: RenderContext,
  name: string,
  allowed: readonly string[],
): string | undefined => {
  const value = context.raw(name);
  return typeof value === 'string' && allowed.includes(value)
    ? value
    : undefined;
};

/** Messages from failed checks, announced. */
const problems = (messages: readonly string[]): View | null =>
  messages.length === 0
    ? null
    : h(
        'span',
        { class: 'a2ui-problems', role: 'alert' },
        ...messages.map((m) => h('span', { class: 'a2ui-problem' }, m)),
      );

const ICONS: Readonly<Record<string, string>> = {
  accountCircle: '👤',
  add: '+',
  arrowBack: '←',
  arrowForward: '→',
  attachFile: '📎',
  calendarToday: '📅',
  call: '📞',
  camera: '📷',
  check: '✓',
  close: '✕',
  delete: '🗑',
  download: '⤓',
  edit: '✎',
  event: '📅',
  error: '⚠',
  fastForward: '⏩',
  favorite: '♥',
  favoriteOff: '♡',
  folder: '📁',
  help: '?',
  home: '⌂',
  info: 'ℹ',
  locationOn: '📍',
  lock: '🔒',
  lockOpen: '🔓',
  mail: '✉',
  menu: '☰',
  moreVert: '⋮',
  moreHoriz: '⋯',
  notificationsOff: '🔕',
  notifications: '🔔',
  pause: '⏸',
  payment: '💳',
  person: '👤',
  phone: '📱',
  photo: '🖼',
  play: '▶',
  print: '🖨',
  refresh: '↻',
  rewind: '⏪',
  search: '🔍',
  send: '➤',
  settings: '⚙',
  share: '⇪',
  shoppingCart: '🛒',
  skipNext: '⏭',
  skipPrevious: '⏮',
  star: '★',
  starHalf: '⯨',
  starOff: '☆',
  stop: '⏹',
  upload: '⤒',
  visibility: '👁',
  visibilityOff: '⊘',
  volumeDown: '🔉',
  volumeMute: '🔇',
  volumeOff: '🔇',
  volumeUp: '🔊',
  warning: '⚠',
};

const Text: ComponentRenderer = (c) => {
  const { inline, views } = c.markdown(c.text('text'));
  const v = variant(c, ['caption', 'body'], 'body');
  return inline
    ? h('span', { class: cls('Text'), 'data-variant': v }, ...views)
    : h('div', { class: cls('Text'), 'data-variant': v }, ...views);
};

const Image: ComponentRenderer = (c) => {
  const checked = c.url('url', 'image');
  const description = c.text('description');
  const attrs = {
    class: cls('Image'),
    'data-fit': oneOf(c, 'fit', [
      'contain',
      'cover',
      'fill',
      'none',
      'scaleDown',
    ]),
    'data-variant': variant(c, [
      'icon',
      'avatar',
      'smallFeature',
      'mediumFeature',
      'largeFeature',
      'header',
    ]),
  };
  if (!checked.ok)
    return h(
      'span',
      {
        ...attrs,
        role: 'img',
        'aria-label': description,
        'data-a2ui-state': 'blocked-url',
      },
      description,
    );
  return h('img', {
    ...attrs,
    src: checked.url,
    alt: description,
    loading: 'lazy',
    decoding: 'async',
  });
};

const Icon: ComponentRenderer = (c) => {
  const name = c.value('name');
  if (isRecord(name) && name['svgPath'] !== undefined) {
    // `name` was evaluated as a literal object, so a bound svgPath is already its value.
    const d = typeof name['svgPath'] === 'string' ? name['svgPath'] : '';
    return h(
      'svg',
      {
        class: cls('Icon'),
        viewBox: '0 0 24 24',
        'aria-hidden': 'true',
        fill: 'currentColor',
      },
      h('path', { d: d.slice(0, 4_000) }),
    );
  }
  const key = typeof name === 'string' ? name : '';
  return h(
    'span',
    { class: cls('Icon'), 'data-icon': key, 'aria-hidden': 'true' },
    ICONS[key] ?? '•',
  );
};

const media =
  (tag: 'video' | 'audio'): ComponentRenderer =>
  (c) => {
    const checked = c.url('url', 'media');
    const description = c.text('description');
    if (!checked.ok)
      return h(
        'span',
        {
          class: cls(tag === 'video' ? 'Video' : 'AudioPlayer'),
          'data-a2ui-state': 'blocked-url',
        },
        description,
      );
    const poster = tag === 'video' ? c.url('posterUrl', 'image') : null;
    return h(
      'div',
      { class: cls(tag === 'video' ? 'Video' : 'AudioPlayer') },
      h(tag, {
        src: checked.url,
        controls: true,
        preload: 'metadata',
        ...(poster?.ok ? { poster: poster.url } : {}),
        'aria-label': description || undefined,
      }),
      tag === 'audio' && description
        ? h('span', { class: 'a2ui-caption' }, description)
        : null,
    );
  };

const flex =
  (name: 'Row' | 'Column'): ComponentRenderer =>
  (c) =>
    h(
      'div',
      {
        class: cls(name),
        'data-justify': oneOf(c, 'justify', [
          'center',
          'end',
          'spaceAround',
          'spaceBetween',
          'spaceEvenly',
          'start',
          'stretch',
        ]),
        'data-align': oneOf(c, 'align', ['start', 'center', 'end', 'stretch']),
      },
      ...c.children('children'),
    );

const List: ComponentRenderer = (c) =>
  h(
    'div',
    {
      class: cls('List'),
      role: 'list',
      'data-direction':
        oneOf(c, 'direction', ['vertical', 'horizontal']) ?? 'vertical',
      'data-align': oneOf(c, 'align', ['start', 'center', 'end', 'stretch']),
    },
    ...c
      .children('children')
      .map((child) =>
        typeof child === 'string'
          ? child
          : { ...child, attrs: { ...child.attrs, role: 'listitem' } },
      ),
  );

const Card: ComponentRenderer = (c) =>
  h('div', { class: cls('Card') }, c.child('child'));

const Tabs: ComponentRenderer = (c) => {
  const tabs = Array.isArray(c.raw('tabs'))
    ? (c.raw('tabs') as unknown[]).filter(isRecord)
    : [];
  const [selected, select] = c.local('tab', 0);
  const current = Math.min(selected, Math.max(0, tabs.length - 1));
  const tabId = (index: number) =>
    `${c.surfaceId}-${c.key}-tab-${index}`.replace(/[^A-Za-z0-9_-]/g, '_');
  return h(
    'div',
    { class: cls('Tabs') },
    h(
      'div',
      { role: 'tablist', class: 'a2ui-tablist' },
      ...tabs.map((tab, index) => ({
        ...h(
          'button',
          {
            type: 'button',
            role: 'tab',
            id: tabId(index),
            'aria-selected': index === current ? 'true' : 'false',
            tabindex: index === current ? 0 : -1,
            key: `tab-${index}`,
          },
          c.textOf(tab['title']),
        ),
        on: { click: () => select(index) },
      })),
    ),
    ...tabs.map((tab, index) =>
      h(
        'div',
        {
          role: 'tabpanel',
          'aria-labelledby': tabId(index),
          hidden: index !== current,
          class: 'a2ui-tabpanel',
          key: `panel-${index}`,
        },
        index === current ? c.childById(tab['child']) : null,
      ),
    ),
  );
};
const Modal: ComponentRenderer = (c) => {
  const [open, setOpen] = c.local('open', false);
  return h(
    'div',
    { class: cls('Modal') },
    {
      ...h('span', { class: 'a2ui-modal-trigger' }, c.child('trigger')),
      on: { click: () => setOpen(true) },
    },
    {
      ...h(
        'dialog',
        { class: 'a2ui-modal-dialog', open },
        {
          ...h(
            'button',
            {
              type: 'button',
              class: 'a2ui-modal-close',
              'aria-label': 'Close',
            },
            '✕',
          ),
          on: { click: () => setOpen(false) },
        },
        open ? c.child('content') : null,
      ),
      on: { close: () => setOpen(false) },
    },
  );
};

const Divider: ComponentRenderer = (c) => {
  const axis = oneOf(c, 'axis', ['horizontal', 'vertical']) ?? 'horizontal';
  return axis === 'vertical'
    ? h('div', {
        class: cls('Divider'),
        role: 'separator',
        'aria-orientation': 'vertical',
        'data-axis': axis,
      })
    : h('hr', { class: cls('Divider'), 'data-axis': axis });
};

const Button: ComponentRenderer = (c) => {
  const checks = c.checks();
  const act = c.action('action');
  const button: ViewElement = {
    ...h(
      'button',
      {
        type: 'button',
        class: cls('Button'),
        'data-variant': variant(
          c,
          ['default', 'primary', 'borderless'],
          'default',
        ),
        disabled: !checks.valid || act === null,
      },
      c.child('child'),
    ),
    on: { click: () => act?.() },
  };
  // One shape whether or not its checks pass: the button keeps its place, size and focus as they
  // change, and its messages come and go beside it.
  return h(
    'span',
    { class: 'a2ui-control' },
    { ...button, key: 'control' },
    problems(checks.messages),
  );
};

const field = (
  c: RenderContext,
  label: string,
  control: ViewElement,
  messages: readonly string[],
): ViewElement =>
  h(
    'label',
    {
      class: cls(c.component.component),
      'data-invalid': messages.length > 0 ? 'true' : undefined,
    },
    label ? h('span', { class: 'a2ui-label' }, label) : null,
    {
      ...control,
      attrs: {
        ...control.attrs,
        'aria-invalid': messages.length > 0 ? 'true' : undefined,
      },
    },
    problems(messages),
  );

const TextField: ComponentRenderer = (c) => {
  const bound = c.bind('value');
  const kind = variant(
    c,
    ['longText', 'number', 'shortText', 'obscured'],
    'shortText',
  );
  const value =
    bound.value === null || bound.value === undefined
      ? ''
      : String(bound.value);
  const input = (event: Event) =>
    bound.write((event.target as HTMLInputElement).value);
  const attrs = {
    placeholder: c.text('placeholder') || undefined,
    'data-variant': kind,
    key: 'control',
  };
  const control: ViewElement =
    kind === 'longText'
      ? {
          ...h('textarea', { ...attrs, rows: 4 }),
          props: { value },
          on: { input },
        }
      : {
          ...h('input', {
            ...attrs,
            type:
              kind === 'number'
                ? 'number'
                : kind === 'obscured'
                  ? 'password'
                  : 'text',
          }),
          props: { value },
          on: { input },
        };
  return field(c, c.text('label'), control, c.checks().messages);
};

const CheckBox: ComponentRenderer = (c) => {
  const bound = c.bind('value');
  const checked = c.boolean('value') || bound.value === true;
  const control: ViewElement = {
    ...h('input', { type: 'checkbox', key: 'control' }),
    props: { checked },
    on: {
      change: (event: Event) =>
        bound.write((event.target as HTMLInputElement).checked),
    },
  };
  const messages = c.checks().messages;
  return h(
    'label',
    {
      class: cls('CheckBox'),
      'data-invalid': messages.length > 0 ? 'true' : undefined,
    },
    control,
    h('span', { class: 'a2ui-label' }, c.text('label')),
    problems(messages),
  );
};

const ChoicePicker: ComponentRenderer = (c) => {
  const bound = c.bind('value');
  const selected = new Set(
    Array.isArray(bound.value) ? bound.value.map(String) : [],
  );
  const single =
    variant(
      c,
      ['multipleSelection', 'mutuallyExclusive'],
      'mutuallyExclusive',
    ) === 'mutuallyExclusive';
  const options = (
    Array.isArray(c.raw('options')) ? (c.raw('options') as unknown[]) : []
  )
    .filter(isRecord)
    .slice(0, 500);
  const [filter, setFilter] = c.local('filter', '');
  const label = (option: Record<string, unknown>) =>
    c.textOf(option['label']) || String(option['value'] ?? '');
  const shown =
    c.raw('filterable') === true && filter
      ? options.filter((o) =>
          label(o).toLowerCase().includes(filter.toLowerCase()),
        )
      : options;
  const messages = c.checks().messages;
  const group = `${c.surfaceId}-${c.key}`.replace(/[^A-Za-z0-9_-]/g, '_');
  return h(
    'fieldset',
    {
      class: cls('ChoicePicker'),
      'data-display':
        oneOf(c, 'displayStyle', ['checkbox', 'chips']) ?? 'checkbox',
      'data-invalid': messages.length > 0 ? 'true' : undefined,
    },
    h('legend', {}, c.text('label')),
    c.raw('filterable') === true
      ? {
          ...h('input', {
            type: 'search',
            class: 'a2ui-filter',
            'aria-label': 'Filter',
            key: 'filter',
          }),
          props: { value: filter },
          on: {
            input: (e: Event) =>
              setFilter((e.target as HTMLInputElement).value),
          },
        }
      : null,
    ...shown.map((option) => {
      const value = String(option['value'] ?? '');
      const control: ViewElement = {
        ...h('input', {
          type: single ? 'radio' : 'checkbox',
          name: group,
          value,
          key: `option-${value}`,
        }),
        props: { checked: selected.has(value) },
        on: {
          change: (event: Event) => {
            const on = (event.target as HTMLInputElement).checked;
            const next = single
              ? on
                ? [value]
                : []
              : on
                ? [...selected, value]
                : [...selected].filter((v) => v !== value);
            bound.write(next);
          },
        },
      };
      return h(
        'label',
        { class: 'a2ui-choice', key: `choice-${value}` },
        control,
        h('span', {}, label(option)),
      );
    }),
    problems(messages),
  );
};

const Slider: ComponentRenderer = (c) => {
  const bound = c.bind('value');
  const min = typeof c.raw('min') === 'number' ? (c.raw('min') as number) : 0;
  const max = typeof c.raw('max') === 'number' ? (c.raw('max') as number) : 100;
  const steps = c.raw('steps');
  const step =
    typeof steps === 'number' && steps > 0 ? (max - min) / steps : 'any';
  const value =
    typeof bound.value === 'number' ? bound.value : Number(bound.value ?? min);
  const control: ViewElement = {
    ...h('input', { type: 'range', min, max, step, key: 'control' }),
    props: { value: String(Number.isFinite(value) ? value : min) },
    on: {
      input: (event: Event) =>
        bound.write(Number((event.target as HTMLInputElement).value)),
    },
  };
  return field(c, c.text('label'), control, c.checks().messages);
};

const DateTimeInput: ComponentRenderer = (c) => {
  const bound = c.bind('value');
  const date = c.raw('enableDate') !== false;
  const time = c.raw('enableTime') === true;
  const type = date && time ? 'datetime-local' : time ? 'time' : 'date';
  const value = typeof bound.value === 'string' ? bound.value : '';
  const shown =
    type === 'date'
      ? value.slice(0, 10)
      : type === 'datetime-local'
        ? value.slice(0, 16)
        : value.slice(11, 16) || value;
  const control: ViewElement = {
    ...h('input', {
      type,
      min:
        typeof c.raw('min') === 'string' ? (c.raw('min') as string) : undefined,
      max:
        typeof c.raw('max') === 'string' ? (c.raw('max') as string) : undefined,
      key: 'control',
    }),
    props: { value: shown },
    on: {
      input: (event: Event) =>
        bound.write((event.target as HTMLInputElement).value),
    },
  };
  return field(c, c.text('label'), control, c.checks().messages);
};

export const BASIC_COMPONENTS: Readonly<Record<string, ComponentRenderer>> =
  Object.freeze({
    Text,
    Image,
    Icon,
    Video: media('video'),
    AudioPlayer: media('audio'),
    Row: flex('Row'),
    Column: flex('Column'),
    List,
    Card,
    Tabs,
    Modal,
    Divider,
    Button,
    TextField,
    CheckBox,
    ChoicePicker,
    Slider,
    DateTimeInput,
  });

/**
 * A starting stylesheet for the basic components. Every rule is inside `:where()`, so it has no
 * specificity: any rule the host already has wins. Colours and spacing come from custom properties
 * a host can set — or from what the host's own text already uses.
 */
export const A2UI_DEFAULT_CSS = `
:where(.a2ui-surface){display:block;font:inherit;color:inherit}
:where(.a2ui-Row){display:flex;flex-direction:row;gap:var(--a2ui-gap,.5rem);align-items:center}
:where(.a2ui-Column){display:flex;flex-direction:column;gap:var(--a2ui-gap,.5rem)}
:where(.a2ui-List){display:flex;flex-direction:column;gap:var(--a2ui-gap,.5rem)}
:where(.a2ui-List[data-direction=horizontal]){flex-direction:row;overflow-x:auto}
:where([data-justify=start]){justify-content:flex-start}:where([data-justify=center]){justify-content:center}
:where([data-justify=end]){justify-content:flex-end}:where([data-justify=spaceBetween]){justify-content:space-between}
:where([data-justify=spaceAround]){justify-content:space-around}:where([data-justify=spaceEvenly]){justify-content:space-evenly}
:where([data-align=start]){align-items:flex-start}:where([data-align=center]){align-items:center}
:where([data-align=end]){align-items:flex-end}:where([data-align=stretch]){align-items:stretch}
:where(.a2ui-Card){display:block;padding:var(--a2ui-card-padding,1rem);border:1px solid var(--a2ui-border,currentColor);border-radius:var(--a2ui-radius,.5rem)}
:where(.a2ui-Text[data-variant=caption]){font-size:.85em;opacity:.8}
:where(.a2ui-Text) :where(p,h1,h2,h3,h4,h5,h6,ul,ol){margin:0 0 .25em}
:where(.a2ui-Image){max-width:100%;height:auto;display:block}
:where(.a2ui-Image[data-fit=cover]){object-fit:cover}:where(.a2ui-Image[data-fit=contain]){object-fit:contain}
:where(.a2ui-Image[data-variant=avatar]){width:3rem;height:3rem;border-radius:50%;object-fit:cover}
:where(.a2ui-Image[data-variant=icon]){width:1.5rem;height:1.5rem}
:where(.a2ui-Icon){display:inline-block;width:1.25em;height:1.25em;line-height:1.25em;text-align:center}
:where(.a2ui-Divider){border:0;border-top:1px solid var(--a2ui-border,currentColor);opacity:.3;margin:.25rem 0;width:100%}
:where(.a2ui-Divider[data-axis=vertical]){border-top:0;border-left:1px solid var(--a2ui-border,currentColor);width:auto;align-self:stretch}
:where(.a2ui-TextField,.a2ui-Slider,.a2ui-DateTimeInput){display:flex;flex-direction:column;gap:.25rem}
:where(.a2ui-control){display:inline-flex;flex-direction:column;align-items:flex-start;gap:.25rem}
:where(.a2ui-problem){display:block;color:var(--a2ui-danger,#b3261e);font-size:.85em}
:where(.a2ui-placeholder){min-height:1rem;border-radius:.25rem;background:var(--a2ui-placeholder,rgba(127,127,127,.15))}
:where(.a2ui-tablist){display:flex;gap:.25rem}
:where(.a2ui-ChoicePicker){border:0;padding:0;margin:0;display:flex;flex-direction:column;gap:.25rem}
:where(.a2ui-modal-dialog[open]){position:fixed;inset:0;margin:auto;max-width:min(90vw,40rem);z-index:1000}
`;
