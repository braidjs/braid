import { random } from './hostile-markup.js';

/**
 * Well-formed fragment markup — every element closed where it should be, nothing misnested — for
 * the rewriter's fidelity tests: on markup like this the rebuilt rewriter must produce the DOM the
 * old one did. Two things it changes on purpose are left out: `<noscript>`, which a fragment loses
 * whole, and table structure inside SVG/MathML HTML islands (`<foreignObject>`), which it drops.
 */

const TEXT = ['Invoices', 'a &amp; b', '3 &lt; 4', '&copy; 2026', 'caf&eacute;', 'x < y and y > z', '&nbsp;', ' ', '\n  '];
const PHRASING = ['span', 'b', 'i', 'em', 'strong', 'code', 'small', 'abbr'];
const FLOW = ['div', 'section', 'article', 'header', 'footer', 'nav', 'main', 'aside', 'figure', 'blockquote'];
const ATTRIBUTES = [
  'class="card"', 'id="x1"', 'data-test="a &amp; b"', 'title="Next &rarr;"', 'aria-label="Close"', 'hidden', "lang='en'",
  'data-json="{&quot;a&quot;:1}"', 'style="color: red"', 'tabindex=0',
];

export function wellFormedPages(count: number, seed = 1): string[] {
  const next = random(seed);
  const pick = <T>(list: readonly T[]): T => list[Math.floor(next() * list.length)];
  const attributes = () => (next() < 0.5 ? '' : ` ${pick(ATTRIBUTES)}`) + (next() < 0.2 ? ` ${pick(ATTRIBUTES)}` : '');

  const phrasing = (depth: number): string => {
    let markup = '';
    const length = 1 + Math.floor(next() * 3);
    for (let index = 0; index < length; index++) {
      const roll = next();
      if (depth > 3 || roll < 0.4) markup += pick(TEXT);
      else if (roll < 0.5) markup += '<img src="img/logo.png" alt="logo">';
      else if (roll < 0.55) markup += '<br>';
      else if (roll < 0.6) markup += '<!-- note -->';
      else if (roll < 0.65) markup += '<a href="/next" title="a &amp; b">next</a>';
      else {
        const tag = pick(PHRASING);
        markup += `<${tag}${attributes()}>${phrasing(depth + 1)}</${tag}>`;
      }
    }
    return markup;
  };

  const svg = (depth: number): string => {
    const shapes = [
      '<path d="M0 0L10 10"/>',
      '<rect x="1" y="1" width="8" height="8"></rect>',
      '<circle cx="5" cy="5" r="4"/>',
      '<title>Icon</title>',
      '<desc>An icon</desc>',
      '<use href="#a"/>',
      '<style>.a { fill: red; }</style>',
      '<style><![CDATA[ .b > .c { fill: blue; } ]]></style>',
      '<text x="1" y="9">A &amp; B</text>',
      '<defs><linearGradient id="g"><stop offset="0"/></linearGradient></defs>',
    ];
    let markup = `<svg viewBox="0 0 10 10"${attributes()}>`;
    const length = 1 + Math.floor(next() * 4);
    for (let index = 0; index < length; index++) {
      const roll = next();
      if (roll < 0.6 || depth > 2) markup += pick(shapes);
      else if (roll < 0.8) markup += `<g>${pick(shapes)}${pick(shapes)}</g>`;
      else markup += `<foreignObject width="10" height="10"><div>${phrasing(depth + 1)}</div><p>${phrasing(depth + 1)}</p></foreignObject>`;
    }
    return `${markup}</svg>`;
  };

  const math = () =>
    '<math><mrow><msup><mi>x</mi><mn>2</mn></msup><mo>+</mo><mi>y</mi></mrow>' +
    '<annotation-xml encoding="text/html"><b>x</b></annotation-xml></math>';

  const flow = (depth: number): string => {
    let markup = '';
    const length = 1 + Math.floor(next() * 4);
    for (let index = 0; index < length; index++) {
      const roll = next();
      if (depth > 4 || roll < 0.2) markup += `<p${attributes()}>${phrasing(depth + 1)}</p>`;
      else if (roll < 0.3) markup += `<ul><li>${phrasing(depth + 1)}</li><li>${flow(depth + 1)}</li></ul>`;
      else if (roll < 0.36) {
        markup += `<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>${phrasing(depth + 1)}</td><td>${flow(depth + 1)}</td></tr></tbody></table>`;
      } else if (roll < 0.42) {
        markup += `<form action="/save"><label>Name <input name="n" value="a &amp; b"></label><select name="s"><option>One</option><option selected>Two</option></select><textarea>a < b</textarea><button type="submit">Save</button></form>`;
      } else if (roll < 0.5) markup += svg(depth + 1);
      else if (roll < 0.53) markup += math();
      else if (roll < 0.58) markup += `<template id="row"><div class="row">${phrasing(depth + 1)}</div></template>`;
      else if (roll < 0.62) markup += `<script>if (a < b && c > d) { document.title = "</div>"; }</script>`;
      else if (roll < 0.65) markup += `<script type="module" src="./main.js"></script>`;
      else if (roll < 0.68) markup += `<style>.a > .b::after { content: "<b>"; }</style>`;
      else if (roll < 0.71) markup += `<details><summary>More</summary>${flow(depth + 1)}</details>`;
      else if (roll < 0.74) markup += `<picture><source srcset="a.webp 1x, a@2x.webp 2x" type="image/webp"><img src="a.png" alt=""></picture>`;
      else if (roll < 0.76) markup += `<iframe src="/embed" title="embed"></iframe>`;
      else if (roll < 0.78) markup += `<video src="v.mp4" poster="p.png" controls></video>`;
      else if (roll < 0.8) markup += `<pre><code>${phrasing(depth + 1)}</code></pre>`;
      else {
        const tag = pick(FLOW);
        markup += `<${tag}${attributes()}>${flow(depth + 1)}</${tag}>`;
      }
    }
    return markup;
  };

  const pages: string[] = [];
  for (let index = 0; index < count; index++) {
    const body = flow(0);
    pages.push(
      next() < 0.5
        ? body
        : `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Billing &amp; invoices</title>` +
            `<base href="/"><link rel="stylesheet" href="styles.css" media="print" onload="this.media='all'">` +
            `<link rel="modulepreload" href="chunk.js"><link rel="preload" href="font.woff2" as="font" crossorigin>` +
            `<style>body { margin: 0 }</style><script src="polyfills.js" nomodule></script></head>` +
            `<body class="app">${body}<script type="module" src="main.js"></script></body></html>`,
    );
  }
  return pages;
}
