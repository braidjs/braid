import { TAG_STYLES } from './tags.js';

/**
 * The console's styles, as a string injected once at mount.
 *
 * Two constraints drive every choice here, both from being a *library* that mounts inside someone
 * else's page:
 *
 * 1. **Every rule is scoped under `.braid-console`.** No resets, no bare element selectors, no
 *    `:root`. A library that styles `body` or `*` vandalizes its host, and the damage shows up in
 *    a part of the app nobody connects to this component.
 * 2. **Everything themable is a custom property on the scope class**, so a host restyles by
 *    setting variables rather than escalating specificity. Dark mode follows
 *    `prefers-color-scheme`, and a host that knows better can force it with `data-theme` — which
 *    must win in *both* directions, since an admin shell may be dark inside a light OS.
 *
 * Shipped as a string rather than a `.css` import so the library has no build-tool requirements:
 * a consumer bundling this needs no CSS loader, no `?inline` suffix, and no side-effect import
 * they can forget.
 *
 * **The palette is Fluent's neutral ramp and brand blue**, because the console's likeliest home is
 * an internal admin surface sitting beside Azure, Entra, or an in-house portal built to match one.
 * A tool that looks foreign next to the tools it is used with reads as untrusted regardless of
 * what it does. The ramp is expressed as tokens rather than literals precisely so a shop with a
 * different system overrides eight variables instead of forking the stylesheet.
 */
export const CONSOLE_STYLES = `
.braid-console {
  --bc-bg: #ffffff;
  --bc-surface: #faf9f8;
  --bc-surface-alt: #f3f2f1;
  --bc-border: #e1dfdd;
  --bc-border-strong: #c8c6c4;
  --bc-text: #201f1e;
  --bc-muted: #605e5c;
  --bc-subtle: #8a8886;
  --bc-accent: #0f6cbd;
  --bc-accent-hover: #115ea3;
  --bc-accent-soft: #eff6fc;
  --bc-warn-bg: #fff4ce;
  --bc-warn-text: #6a4b16;
  --bc-warn-border: #f2d98c;
  --bc-ok: #0e700e;
  --bc-ok-soft: #dff6dd;
  --bc-err: #a4262c;
  --bc-err-soft: #fde7e9;
  --bc-radius: 4px;
  --bc-gap: 12px;
  --bc-shadow: 0 1.6px 3.6px rgba(0,0,0,0.10), 0 0.3px 0.9px rgba(0,0,0,0.07);
  --bc-font: "Segoe UI", "Segoe UI Web (West European)", ui-sans-serif, system-ui, -apple-system, Roboto, sans-serif;
  --bc-mono: ui-monospace, "Cascadia Mono", SFMono-Regular, Consolas, Menlo, monospace;

  color: var(--bc-text);
  background: var(--bc-bg);
  font-family: var(--bc-font);
  font-size: 14px;
  line-height: 1.4;
  container-type: inline-size;
}

@media (prefers-color-scheme: dark) {
  .braid-console {
    --bc-bg: #1b1a19;
    --bc-surface: #252423;
    --bc-surface-alt: #292827;
    --bc-border: #3b3a39;
    --bc-border-strong: #484644;
    --bc-text: #f3f2f1;
    --bc-muted: #c8c6c4;
    --bc-subtle: #a19f9d;
    --bc-accent: #479ef5;
    --bc-accent-hover: #62abf5;
    --bc-accent-soft: #082338;
    --bc-warn-bg: #3a2f0b;
    --bc-warn-text: #fce100;
    --bc-warn-border: #6b5a12;
    --bc-ok: #54b054;
    --bc-ok-soft: #052505;
    --bc-err: #f1707b;
    --bc-err-soft: #3b1216;
    --bc-shadow: 0 1.6px 3.6px rgba(0,0,0,0.4), 0 0.3px 0.9px rgba(0,0,0,0.3);
  }
}

/* An explicit host choice wins over the OS in both directions. */
.braid-console[data-theme='light'] {
  --bc-bg: #ffffff; --bc-surface: #faf9f8; --bc-surface-alt: #f3f2f1;
  --bc-border: #e1dfdd; --bc-border-strong: #c8c6c4;
  --bc-text: #201f1e; --bc-muted: #605e5c; --bc-subtle: #8a8886;
  --bc-accent: #0f6cbd; --bc-accent-hover: #115ea3; --bc-accent-soft: #eff6fc;
  --bc-warn-bg: #fff4ce; --bc-warn-text: #6a4b16; --bc-warn-border: #f2d98c;
  --bc-ok: #0e700e; --bc-ok-soft: #dff6dd; --bc-err: #a4262c; --bc-err-soft: #fde7e9;
  --bc-shadow: 0 1.6px 3.6px rgba(0,0,0,0.10), 0 0.3px 0.9px rgba(0,0,0,0.07);
}
.braid-console[data-theme='dark'] {
  --bc-bg: #1b1a19; --bc-surface: #252423; --bc-surface-alt: #292827;
  --bc-border: #3b3a39; --bc-border-strong: #484644;
  --bc-text: #f3f2f1; --bc-muted: #c8c6c4; --bc-subtle: #a19f9d;
  --bc-accent: #479ef5; --bc-accent-hover: #62abf5; --bc-accent-soft: #082338;
  --bc-warn-bg: #3a2f0b; --bc-warn-text: #fce100; --bc-warn-border: #6b5a12;
  --bc-ok: #54b054; --bc-ok-soft: #052505; --bc-err: #f1707b; --bc-err-soft: #3b1216;
  --bc-shadow: 0 1.6px 3.6px rgba(0,0,0,0.4), 0 0.3px 0.9px rgba(0,0,0,0.3);
}

.braid-console *, .braid-console *::before, .braid-console *::after { box-sizing: border-box; }

/* --- shell -------------------------------------------------------------- */

/* The chrome an operator reads before anything else: what this is, which gateway, how fresh. */
.braid-console__shell { display: flex; flex-direction: column; gap: 0; }

.braid-console__titlebar {
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  padding: 0 0 10px;
}
.braid-console__producttitle { font-size: 20px; font-weight: 600; margin: 0; letter-spacing: -0.01em; }
.braid-console__breadcrumb { color: var(--bc-subtle); font-size: 13px; display: flex; align-items: center; gap: 6px; }
.braid-console__breadcrumb code { font-family: var(--bc-mono); font-size: 12px; color: var(--bc-muted); }

/* Fluent's command bar: actions live on one line above the content, left-aligned, icon-led. */
.braid-console__commandbar {
  display: flex; align-items: center; gap: 4px; flex-wrap: wrap;
  border-top: 1px solid var(--bc-border); border-bottom: 1px solid var(--bc-border);
  padding: 6px 0; margin-bottom: var(--bc-gap);
}
.braid-console__command {
  font: inherit; font-size: 13px; color: inherit; background: transparent; border: 1px solid transparent;
  border-radius: var(--bc-radius); padding: 5px 10px; cursor: pointer;
  display: inline-flex; align-items: center; gap: 6px;
}
.braid-console__command:hover { background: var(--bc-surface-alt); }
.braid-console__command:disabled { opacity: 0.4; cursor: not-allowed; background: transparent; }
.braid-console__command:focus-visible { outline: 2px solid var(--bc-accent); outline-offset: 1px; }
.braid-console__commandicon { font-size: 13px; line-height: 1; color: var(--bc-accent); }
.braid-console__commandsep { width: 1px; align-self: stretch; background: var(--bc-border); margin: 2px 4px; }

/* Tabs (Fluent "pivot"): an underline on the selected one, never a filled pill. */
.braid-console__tabs { display: flex; align-items: center; gap: 2px; }
.braid-console__tab {
  font: inherit; font-size: 14px; color: var(--bc-muted); background: transparent;
  border: 0; border-bottom: 2px solid transparent; cursor: pointer;
  padding: 7px 10px; display: inline-flex; align-items: center; gap: 6px;
}
.braid-console__tab:hover { color: var(--bc-text); }
.braid-console__tab[aria-selected='true'] { color: var(--bc-text); font-weight: 600; border-bottom-color: var(--bc-accent); }
.braid-console__tab:focus-visible { outline: 2px solid var(--bc-accent); outline-offset: -2px; }
.braid-console__tabcount {
  font-size: 11px; font-weight: 600; background: var(--bc-surface-alt); color: var(--bc-muted);
  border-radius: 9px; padding: 0 6px; font-variant-numeric: tabular-nums;
}

/* --- summary strip ------------------------------------------------------ */

/* Four numbers an operator wants before scrolling: scale, composition, and what is gated. */
.braid-console__stats { display: flex; gap: 1px; background: var(--bc-border); border: 1px solid var(--bc-border);
  border-radius: var(--bc-radius); overflow: hidden; margin-bottom: var(--bc-gap); flex-wrap: wrap; }
.braid-console__stat { background: var(--bc-bg); padding: 10px 14px; flex: 1 1 auto; min-width: 8rem; }
.braid-console__statvalue { font-size: 20px; font-weight: 600; font-variant-numeric: tabular-nums; display: block; line-height: 1.2; }
.braid-console__statlabel { font-size: 12px; color: var(--bc-muted); }
.braid-console__stat--warn .braid-console__statvalue { color: var(--bc-warn-text); }

.braid-console__header {
  display: flex; flex-wrap: wrap; align-items: center; gap: var(--bc-gap);
  padding-bottom: var(--bc-gap);
}
.braid-console__title { font-size: 15px; font-weight: 600; margin: 0; }
.braid-console__count { color: var(--bc-muted); font-variant-numeric: tabular-nums; font-size: 13px; }
.braid-console__spacer { margin-left: auto; }

.braid-console__search {
  font: inherit; color: inherit; background: var(--bc-bg);
  border: 1px solid var(--bc-border-strong); border-radius: var(--bc-radius);
  padding: 6px 10px; min-width: 15rem;
}
.braid-console__search::placeholder { color: var(--bc-subtle); }
.braid-console__search:hover { border-color: var(--bc-muted); }
/* Fluent's field focus: the border thickens on the accent edge rather than a ring floating outside. */
.braid-console__search:focus-visible { outline: none; border-color: var(--bc-accent); box-shadow: inset 0 -2px 0 0 var(--bc-accent); }

.braid-console__notice {
  display: flex; gap: 8px; align-items: flex-start;
  background: var(--bc-warn-bg); color: var(--bc-warn-text);
  border: 1px solid var(--bc-warn-border); border-left: 3px solid var(--bc-warn-text);
  border-radius: var(--bc-radius); padding: 9px 12px; margin-bottom: var(--bc-gap); font-size: 13px;
}

/* --- table -------------------------------------------------------------- */

.braid-console__table { width: 100%; border-collapse: collapse; }
.braid-console__table th {
  text-align: left; font-size: 12px; font-weight: 600; color: var(--bc-muted);
  padding: 8px 12px; border-bottom: 1px solid var(--bc-border-strong);
  position: sticky; top: 0; background: var(--bc-bg); z-index: 1;
}
.braid-console__table td { padding: 10px 12px; border-bottom: 1px solid var(--bc-border); vertical-align: top; }
.braid-console__table tbody tr:hover { background: var(--bc-surface); }
/* A 2px accent bar on the hovered row, the way a Fluent DetailsList marks the active one. */
.braid-console__table tbody tr { box-shadow: inset 2px 0 0 0 transparent; }
.braid-console__table tbody tr:hover { box-shadow: inset 2px 0 0 0 var(--bc-accent); }

.braid-console__id { font-weight: 600; }
.braid-console__desc { color: var(--bc-muted); margin-top: 2px; font-size: 13px; }
.braid-console__mono { font-family: var(--bc-mono); font-size: 12.5px; color: var(--bc-muted); }
.braid-console__patterns { display: flex; flex-direction: column; gap: 2px; }

.braid-console__tag {
  display: inline-block; font-size: 11px; padding: 1px 7px; margin: 4px 4px 0 0;
  background: var(--bc-surface-alt); border: 1px solid var(--bc-border); border-radius: 3px; color: var(--bc-muted);
}
.braid-console__badge {
  display: inline-block; font-size: 11.5px; padding: 1px 7px; font-weight: 600;
  border-radius: 3px; border: 1px solid var(--bc-border);
}
.braid-console__badge--loadable { color: var(--bc-ok); border-color: transparent; background: var(--bc-ok-soft); }
.braid-console__badge--gated { color: var(--bc-muted); background: var(--bc-surface-alt); border-color: transparent; }

.braid-console__empty { padding: 40px 10px; text-align: center; color: var(--bc-muted); }
.braid-console__error {
  border: 1px solid var(--bc-err); border-left: 3px solid var(--bc-err);
  background: var(--bc-err-soft); color: var(--bc-text);
  border-radius: var(--bc-radius); padding: 14px 16px;
}
.braid-console__error h3 { margin: 0 0 4px; font-size: 14px; color: var(--bc-err); }
.braid-console__retry {
  font: inherit; color: inherit; background: var(--bc-bg); cursor: pointer; margin-top: 10px;
  border: 1px solid var(--bc-border-strong); border-radius: var(--bc-radius); padding: 5px 12px;
}
.braid-console__retry:hover { background: var(--bc-surface-alt); }

/* --- topology graph ----------------------------------------------------- */

.braid-console__graphwrap { display: flex; gap: var(--bc-gap); align-items: flex-start; }
.braid-console__graphmain { flex: 1 1 auto; min-width: 0; overflow-x: auto; }

.braid-console__collabels {
  display: grid; grid-auto-flow: column; grid-auto-columns: 1fr;
  font-size: 11px; font-weight: 600; color: var(--bc-subtle);
  text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 6px;
}
.braid-console__collabels span:nth-child(2) { text-align: center; }
.braid-console__collabels span:nth-child(3) { text-align: right; }

.braid-console__graph { width: 100%; min-width: 480px; display: block; overflow: visible; }

.braid-console__edge { fill: none; stroke: var(--bc-border-strong); stroke-width: 1.25; transition: stroke 0.12s, opacity 0.12s; }
.braid-console__edge--served-by { stroke-dasharray: 3 3; }
.braid-console__edge--slots { stroke-dasharray: 1 3; stroke-linecap: round; }
.braid-console__edge.is-lit { stroke: var(--bc-accent); stroke-width: 2; }
.braid-console__edge.is-dim { opacity: 0.2; }

.braid-console__node { cursor: pointer; transition: opacity 0.12s; }
.braid-console__node.is-dim { opacity: 0.3; }
.braid-console__nodebox { fill: var(--bc-bg); stroke: var(--bc-border-strong); stroke-width: 1; }
.braid-console__node:hover .braid-console__nodebox { stroke: var(--bc-accent); }
.braid-console__node:focus-visible { outline: none; }
.braid-console__node:focus-visible .braid-console__nodebox { stroke: var(--bc-accent); stroke-width: 2; }
.braid-console__node.is-selected .braid-console__nodebox { stroke: var(--bc-accent); stroke-width: 2; fill: var(--bc-accent-soft); }

.braid-console__node--fragment .braid-console__nodebox { fill: var(--bc-surface-alt); }
.braid-console__node--shell .braid-console__nodebox { fill: var(--bc-accent-soft); stroke: var(--bc-accent); }
/* A shared route is the one state worth colouring: more than one fragment lands on this page. */
.braid-console__node--route.is-shared .braid-console__nodebox { stroke: var(--bc-warn-border); border-left: 2px solid var(--bc-warn-text); }
.braid-console__node--route.is-shared .braid-console__nodecount { fill: var(--bc-warn-text); font-weight: 700; }

.braid-console__nodelabel { font-family: var(--bc-mono); font-size: 11.5px; fill: var(--bc-text); pointer-events: none; }
.braid-console__nodecount { font-size: 11px; fill: var(--bc-subtle); pointer-events: none; font-variant-numeric: tabular-nums; }
.braid-console__nodegate { fill: var(--bc-subtle); pointer-events: none; }

.braid-console__graphnote {
  font-size: 12.5px; color: var(--bc-muted); margin: var(--bc-gap) 0 0;
  padding: 8px 10px; background: var(--bc-surface); border-radius: var(--bc-radius);
  border-left: 2px solid var(--bc-border-strong);
}

/* --- detail panel ------------------------------------------------------- */

.braid-console__detail {
  flex: 0 0 260px; border: 1px solid var(--bc-border); border-radius: var(--bc-radius);
  background: var(--bc-surface); padding: 12px; font-size: 13px;
}
.braid-console__detail--empty { color: var(--bc-muted); }
.braid-console__detailhint { font-size: 12px; color: var(--bc-subtle); margin: 8px 0 0; line-height: 1.45; }
.braid-console__detailhead { display: flex; align-items: center; gap: 8px; }
.braid-console__detailclose {
  margin-left: auto; font: inherit; background: transparent; border: 0; color: var(--bc-muted);
  cursor: pointer; border-radius: 3px; padding: 2px 6px; line-height: 1;
}
.braid-console__detailclose:hover { background: var(--bc-surface-alt); color: var(--bc-text); }
.braid-console__detailtitle { font-size: 15px; margin: 6px 0 4px; font-family: var(--bc-mono); word-break: break-all; }
.braid-console__detaildesc { color: var(--bc-muted); margin: 0 0 6px; line-height: 1.45; }
.braid-console__detailwarn { color: var(--bc-warn-text); margin: 8px 0 0; font-size: 12.5px; line-height: 1.45; }

.braid-console__kind {
  font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.06em; font-weight: 600;
  border-radius: 3px; padding: 2px 6px; background: var(--bc-surface-alt); color: var(--bc-muted);
}
.braid-console__kind--route { color: var(--bc-accent); background: var(--bc-accent-soft); }
.braid-console__kind--shell { color: var(--bc-accent); background: var(--bc-accent-soft); }

.braid-console__props { display: grid; grid-template-columns: auto 1fr; gap: 4px 10px; margin: 10px 0 0; }
.braid-console__props dt { color: var(--bc-subtle); font-size: 12px; }
.braid-console__props dd { margin: 0; }

.braid-console__detailsection { margin-top: 12px; border-top: 1px solid var(--bc-border); padding-top: 10px; }
.braid-console__detailsection h4 { margin: 0 0 6px; font-size: 12px; color: var(--bc-subtle); text-transform: uppercase; letter-spacing: 0.05em; }
.braid-console__peerlist { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 3px; }

/* --- integration dialog -------------------------------------------------- */

.braid-console__scrim {
  position: fixed; inset: 0; z-index: 40; display: flex; align-items: center; justify-content: center;
  background: rgba(0,0,0,0.4); padding: 24px;
}
.braid-console__dialog {
  background: var(--bc-bg); border: 1px solid var(--bc-border); border-radius: 6px;
  box-shadow: 0 6.4px 14.4px rgba(0,0,0,0.13), 0 1.2px 3.6px rgba(0,0,0,0.11);
  width: min(720px, 100%); max-height: 100%; overflow-y: auto; padding: 16px;
}
.braid-console__dialoghead { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
.braid-console__dialogtitle { margin: 0; font-size: 16px; font-weight: 600; }
.braid-console__dialogtitle code { font-family: var(--bc-mono); font-size: 15px; }
.braid-console__dialoghead .braid-console__detailclose { margin-left: auto; }

.braid-console__code {
  margin: 10px 0 0; padding: 12px; overflow-x: auto;
  background: var(--bc-surface-alt); border: 1px solid var(--bc-border); border-radius: var(--bc-radius);
  font-family: var(--bc-mono); font-size: 12.5px; line-height: 1.55; white-space: pre;
}
.braid-console__code:focus-visible { outline: 2px solid var(--bc-accent); outline-offset: 1px; }

.braid-console__dialogfoot { display: flex; align-items: center; gap: 12px; margin-top: 12px; flex-wrap: wrap; }
.braid-console__dialogfoot .braid-console__hint { font-size: 12px; color: var(--bc-subtle); }
.braid-console__dialogfoot code { font-family: var(--bc-mono); }
.braid-console__dialogfoot kbd {
  font-family: var(--bc-mono); font-size: 11px; border: 1px solid var(--bc-border-strong);
  border-bottom-width: 2px; border-radius: 3px; padding: 0 4px; background: var(--bc-bg);
}

/* --- editor ------------------------------------------------------------- */

.braid-console__list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.braid-console__card { border: 1px solid var(--bc-border); border-radius: var(--bc-radius); background: var(--bc-bg); }
.braid-console__card:hover { border-color: var(--bc-border-strong); }
.braid-console__cardhead { display: flex; align-items: center; gap: var(--bc-gap); padding: 10px 12px; flex-wrap: wrap; }

.braid-console__card.is-open { border-color: var(--bc-accent); box-shadow: var(--bc-shadow); }

.braid-console__disclose {
  font: inherit; color: inherit; background: transparent; cursor: pointer;
  display: inline-flex; align-items: center; gap: 8px;
  border: 1px solid transparent; border-radius: var(--bc-radius); padding: 3px 8px 3px 4px; margin-left: -4px;
}
/* The row is a control, so it says so on hover rather than only when the pointer finds the glyph. */
.braid-console__disclose:hover { background: var(--bc-surface-alt); border-color: var(--bc-border); }
.braid-console__disclose:focus-visible { outline: 2px solid var(--bc-accent); outline-offset: 2px; }

.braid-console__caret {
  display: inline-block; color: var(--bc-muted); font-size: 11px;
  transition: transform 0.12s ease; transform-origin: 50% 50%;
}
.braid-console__card.is-open .braid-console__caret { transform: rotate(90deg); }

.braid-console__cardmeta { font-size: 12px; color: var(--bc-subtle); }

.braid-console__ghost, .braid-console__primary {
  font: inherit; font-size: 13px; cursor: pointer; border-radius: var(--bc-radius); padding: 5px 12px;
  border: 1px solid var(--bc-border-strong); background: var(--bc-bg); color: inherit;
}
.braid-console__ghost:hover { background: var(--bc-surface-alt); }
.braid-console__primary { background: var(--bc-accent); border-color: var(--bc-accent); color: #fff; font-weight: 600; }
.braid-console__primary:hover { background: var(--bc-accent-hover); border-color: var(--bc-accent-hover); }
.braid-console__ghost:disabled, .braid-console__primary:disabled { opacity: 0.45; cursor: not-allowed; }
.braid-console__ghost:focus-visible, .braid-console__primary:focus-visible { outline: 2px solid var(--bc-accent); outline-offset: 2px; }

.braid-console__badge--error { color: var(--bc-err); background: var(--bc-err-soft); border-color: transparent; }

.braid-console__findings { list-style: none; margin: 0; padding: 0 12px 10px; display: flex; flex-direction: column; gap: 5px; }
.braid-console__finding { font-size: 12.5px; padding: 4px 0 4px 10px; border-left: 2px solid var(--bc-border); line-height: 1.45; }
.braid-console__finding--error { border-left-color: var(--bc-err); color: var(--bc-err); }
.braid-console__finding--warning { border-left-color: var(--bc-warn-border); color: var(--bc-warn-text); }

.braid-console__fields {
  display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: var(--bc-gap); padding: 12px; border-top: 1px solid var(--bc-border); background: var(--bc-surface);
}
.braid-console__field { display: flex; flex-direction: column; gap: 4px; }
.braid-console__fieldlabel { font-size: 12px; font-weight: 600; color: var(--bc-muted); display: flex; align-items: center; gap: 6px; }
.braid-console__field input, .braid-console__field select {
  font: inherit; font-size: 13px; color: inherit; background: var(--bc-bg);
  border: 1px solid var(--bc-border-strong); border-radius: var(--bc-radius); padding: 6px 9px; width: 100%;
}
.braid-console__field input:focus-visible, .braid-console__field select:focus-visible {
  outline: none; border-color: var(--bc-accent); box-shadow: inset 0 -2px 0 0 var(--bc-accent);
}
.braid-console__field input:disabled { opacity: 0.6; }

.braid-console__owner {
  font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.04em;
  border: 1px solid var(--bc-border); border-radius: 3px; padding: 1px 5px; color: var(--bc-muted);
}
.braid-console__owner--gateway { color: var(--bc-warn-text); border-color: var(--bc-warn-border); background: var(--bc-warn-bg); }

.braid-console__bar {
  position: sticky; bottom: 0; display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  margin-top: var(--bc-gap); padding: 12px; background: var(--bc-surface);
  border: 1px solid var(--bc-border); border-radius: var(--bc-radius); box-shadow: var(--bc-shadow);
}
.braid-console__barstate { color: var(--bc-muted); font-size: 13px; }
.braid-console__barstate--error { color: var(--bc-err); font-weight: 600; }

.braid-console__notice--ok { background: var(--bc-ok-soft); color: var(--bc-ok); border-color: var(--bc-ok); border-left-color: var(--bc-ok); }

.braid-console__diff {
  font-family: var(--bc-mono); font-size: 12.5px; padding: 12px; margin-top: var(--bc-gap);
  border: 1px solid var(--bc-border); border-radius: var(--bc-radius); background: var(--bc-surface);
  overflow-x: auto;
}
.braid-console__diffline { padding: 2px 0; }
.braid-console__diffline--add { color: var(--bc-ok); }
.braid-console__diffline--remove { color: var(--bc-err); }
.braid-console__diffield { padding: 2px 0 2px 16px; color: var(--bc-muted); }

/* --- access matrix ------------------------------------------------------ */

.braid-console__access {
  margin-top: var(--bc-gap); padding: 12px;
  border: 1px solid var(--bc-border); border-radius: var(--bc-radius); background: var(--bc-surface);
}
.braid-console__accesshead { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 8px; }
.braid-console__matrix { margin-top: 8px; background: var(--bc-bg); }
.braid-console__matrix th, .braid-console__matrix td { padding: 6px 10px; }
.braid-console__matrix th { white-space: nowrap; position: static; }
.braid-console__remove { border: 0; padding: 0 4px; margin-left: 4px; font-size: 13px; line-height: 1; }

.braid-console__mark { font-family: var(--bc-mono); }
.braid-console__mark--allowed { color: var(--bc-ok); }
.braid-console__mark--denied { color: var(--bc-muted); }
.braid-console__mark--absent { color: var(--bc-muted); opacity: 0.6; }

/* Visually hidden, still read aloud — the symbols carry meaning that colour alone would not. */
.braid-console__sronly {
  position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
  overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0;
}

/* Container query, not a media query: the library's width is its host's business, not the
   viewport's. A console in a 400px sidebar should stack even on a wide screen. */
@container (max-width: 860px) {
  .braid-console__graphwrap { flex-direction: column; }
  .braid-console__detail { flex: 1 1 auto; width: 100%; }
}

@container (max-width: 640px) {
  .braid-console__table thead { display: none; }
  .braid-console__table tr { display: block; padding: 8px 0; border-bottom: 1px solid var(--bc-border); }
  .braid-console__table td { display: block; border: 0; padding: 2px 12px; }
  .braid-console__stats { flex-direction: column; }
}

/* Motion is decoration here; the information is in position and colour, which do not move. */
@media (prefers-reduced-motion: reduce) {
  .braid-console__edge, .braid-console__node, .braid-console__caret { transition: none; }
}
` + TAG_STYLES;

const STYLE_ELEMENT_ID = 'braid-console-styles';

/** Injects the stylesheet once per document. Safe to call from every mounted instance. */
export function ensureStyles(doc: Document = document): void {
  if (doc.getElementById(STYLE_ELEMENT_ID)) return;

  const style = doc.createElement('style');
  style.id = STYLE_ELEMENT_ID;
  style.textContent = CONSOLE_STYLES;
  doc.head.append(style);
}
