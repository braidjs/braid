import type { SkewContractDocument } from '@braidlabs/contract';
import type {
  CatalogFunction,
  ComponentDefinition,
  ContractEntry,
  SduiCatalog,
} from '../lib/catalog.js';
import { type ClientManifest, createClientManifest } from '../lib/manifest.js';

/**
 * A2UI's basic catalog, as an SDUI catalog.
 *
 * The eighteen components every A2UI renderer ships, each a contract at v1 with no steps: the
 * basic catalog is not versioned within itself, a new version of it is a new catalog id. Written
 * this way it is an ordinary catalog — projection, diffing and the publish gate all work on it —
 * and a team's own catalog can start from it and grow, which is where versions begin to matter.
 */

export const A2UI_BASIC_CATALOG_ID =
  'https://a2ui.org/specification/v1_0/catalogs/basic/catalog.json';

/**
 * The two actions every A2UI target has. An A2UI action is either an event the agent defined —
 * `{ event: { name, context } }` — or a call to a catalog function, `{ functionCall }`. In the
 * SDUI model they are actions of these types, with the event's or the call's fields as props.
 */
export const A2UI_EVENT_ACTION = 'a2ui.event';
export const A2UI_CALL_ACTION = 'a2ui.call';

const contract = (name: string): SkewContractDocument => ({
  skewContract: '1',
  name,
  current: 1,
  steps: [],
});

export const A2UI_ACTIONS: Readonly<Record<string, ContractEntry>> =
  Object.freeze({
    [A2UI_EVENT_ACTION]: {
      contract: contract(`sdui.action.${A2UI_EVENT_ACTION}`),
    },
    [A2UI_CALL_ACTION]: {
      contract: contract(`sdui.action.${A2UI_CALL_ACTION}`),
    },
  });

const component = (
  name: string,
  extra: Omit<ComponentDefinition, 'contract'> = {},
): ComponentDefinition => ({
  contract: contract(`sdui.component.${name}`),
  ...extra,
});

const one = { max: 1 } as const;

const fn = (
  returnType: CatalogFunction['returnType'],
  extra: Omit<CatalogFunction, 'returnType'> = {},
): CatalogFunction => ({ returnType, ...extra });

/** The basic catalog's functions — all renderer-side. */
export const A2UI_BASIC_FUNCTIONS: Readonly<Record<string, CatalogFunction>> =
  Object.freeze({
    required: fn('validationResult'),
    regex: fn('validationResult'),
    length: fn('validationResult'),
    numeric: fn('validationResult'),
    email: fn('validationResult'),
    formatString: fn('string'),
    formatNumber: fn('string'),
    formatCurrency: fn('string'),
    formatDate: fn('string'),
    pluralize: fn('string'),
    openUrl: fn('void', { requiresUserActivation: true }),
    and: fn('boolean'),
    or: fn('boolean'),
    not: fn('boolean'),
  });

export const a2uiBasicCatalog: SduiCatalog = Object.freeze({
  sduiCatalog: '1',
  a2ui: { catalogId: A2UI_BASIC_CATALOG_ID, title: 'A2UI Basic Catalog' },
  components: {
    Text: component('Text', { fallback: 'omit', localizable: ['text'] }),
    Image: component('Image'),
    Icon: component('Icon'),
    Video: component('Video'),
    AudioPlayer: component('AudioPlayer'),
    Row: component('Row', { slots: { children: {} } }),
    Column: component('Column', { slots: { children: {} } }),
    List: component('List', { slots: { children: {} } }),
    Card: component('Card', { slots: { child: one } }),
    Tabs: component('Tabs', {
      slots: { tabs: { a2ui: { list: 'tabs', key: 'child' } } },
    }),
    Modal: component('Modal', { slots: { trigger: one, content: one } }),
    Divider: component('Divider'),
    Button: component('Button', {
      slots: { child: one },
      a2ui: { actions: ['action'] },
    }),
    TextField: component('TextField'),
    CheckBox: component('CheckBox'),
    ChoicePicker: component('ChoicePicker'),
    Slider: component('Slider'),
    DateTimeInput: component('DateTimeInput'),
  },
  actions: A2UI_ACTIONS,
  functions: A2UI_BASIC_FUNCTIONS,
}) as SduiCatalog;

/** What any A2UI v1.0 renderer can render: the basic catalog, every function, both actions. */
export const a2uiBasicManifest: ClientManifest = createClientManifest(
  a2uiBasicCatalog,
  {
    app: 'a2ui',
    platform: 'any',
    version: '1.0.0',
  },
);
