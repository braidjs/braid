import { describe, expect, it } from 'vitest';
import { toMarkdown } from './markdown';

const page = 'https://site.test/guide/';

describe('toMarkdown', () => {
  it('stops on an element it has no rule for, instead of flattening it', () => {
    expect(() => toMarkdown('<p>Before</p><details><summary>Q</summary>A</details>', page)).toThrow(/no rule for <details>/);
  });

  it('keeps escaped markup as text, and code blocks as written', () => {
    const md = toMarkdown('<p>Write &lt;fragment-slot&gt; here.</p><pre class="code"><span class="tk">if</span> (a &amp;&amp; b)\n  go();</pre>', page);
    expect(md).toBe('Write <fragment-slot> here.\n\n```\nif (a && b)\n  go();\n```');
  });

  it('gives line breaks in headings a space, and resolves links against the page', () => {
    const md = toMarkdown('<h1>How this page<br>is built.</h1><p><a href="../cheatsheet/">The cheatsheet</a> and <a href="#how">how</a></p>', page);
    expect(md).toBe('# How this page is built.\n\n[The cheatsheet](https://site.test/cheatsheet/) and [how](https://site.test/guide/#how)');
  });

  it('writes a table with one header row and escapes pipes in cells', () => {
    const md = toMarkdown('<table><tr><th>Q</th><th>A</th></tr><tr><th>Or</th><td>a | b</td></tr></table>', page);
    expect(md).toBe('| Q | A |\n| --- | --- |\n| Or | a \\| b |');
  });
});
