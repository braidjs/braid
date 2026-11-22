/**
 * Hostile fragment markup for the rewriter's differential tests: the cases the 2026-11-03 review
 * found, and a generator that strings together the constructs browsers parse in surprising ways.
 *
 * Shared by the unit differential (`src/rewriter/differential.spec.ts`, parse5) and the browser one
 * (`e2e/rewriter-differential.e2e.ts`, Chromium). A payload's `ID` is replaced with the case's
 * number, and every payload that runs calls `pwn(ID)` — in the browser test, a function on the
 * page that records it.
 */

/** Markup that runs code, navigates, or loads something, if it reaches the DOM unneutralized. */
export const PAYLOADS = [
  '<img src=x onerror=pwn(ID)>',
  '<img/src=x/onerror=pwn(ID)>',
  '<svg onload=pwn(ID)>',
  '<script>pwn(ID)</script>',
  '<svg><script>pwn(ID)</script></svg>',
  '<details open ontoggle=pwn(ID)>',
  '<iframe srcdoc="<script>parent.pwn(ID)</script>"></iframe>',
  '<iframe src="javascript:parent.pwn(ID)"></iframe>',
  '<iframe src="&#106;avascript:parent.pwn(ID)"></iframe>',
  '<object data="javascript:parent.pwn(ID)"></object>',
  '<embed src="javascript:parent.pwn(ID)">',
  '<meta http-equiv="refresh" content="0;url=about:blank#ID">',
  '<meta http-equiv="&#114;efresh" content="0;url=about:blank#ID">',
  '<link rel=preload href=/p/ID as=script>',
  '<link rel="&#112;reload" href=/p/ID as=script>',
  '<input autofocus onfocus=pwn(ID)>',
];

/** Constructs that change how what follows is read, or that browsers recover from differently. */
const PIECES = [
  // foreign content
  '<svg>', '<math>', '</svg>', '</math>', '<svg/>', '<math/>', '<foreignObject>', '</foreignObject>', '<desc>',
  '</desc>', '<title>', '</title>', '<mi>', '<mtext>', '</mtext>', '<mglyph>', '<malignmark>', '<annotation-xml>',
  '<annotation-xml encoding="text/html">', '<annotation-xml encoding="APPLICATION/XHTML+XML">',
  '<annotation-xml encoding="text&sol;html">', '</annotation-xml>', '<font color=red>', '<font>', '</font>',
  '<![CDATA[', ']]>', '<g>', '</g>',
  // raw text and its lookalikes
  '<style>', '<style/>', '</style>', '<STYLE>', '</STYLE >', '<script>', '<script/>', '</script>', '</script\n>',
  '<sCrIpT>', '<textarea>', '</textarea>', '<xmp>', '</xmp>', '<iframe>', '</iframe>', '<noembed>', '</noembed>',
  '<noframes>', '</noframes>', '<noscript>', '</noscript>', '<plaintext>', '<!--<script>', '</script>-->',
  // modes browsers disagree on, and their containers
  '<select>', '</select>', '<option>', '<optgroup>', '<table>', '</table>', '<tr>', '</tr>', '<td>', '</td>', '<tbody>',
  '<caption>', '<colgroup>', '<col>', '<template>', '</template>', '<template shadowrootmode="open">', '<frameset>',
  '<frame>', '<input>', '<keygen>',
  // HTML structure and misnesting
  '<b>', '</b>', '<a href=#>', '</a>', '<p>', '</p>', '</br>', '<div>', '</div>', '<li>', '<ul>', '<button>', '<form>',
  '</form>', '<nobr>', '<ruby>', '<rt>', '<dd>', '<h1>', '</h1>', '<pre>', '<image src=x>', '<body>', '</body>',
  '<head>', '</head>', '<html>', '</html>', '<object>',
  // the elements a fragment is placed in
  '<braid-document>', '</braid-document>', '</fragment-slot>', '<fragment-slot>', '</slot>', '</braid-late>',
  // comments, declarations
  '<!--', '-->', '--!>', '<!-->', '<!--->', '<!-- x -->', '<?x>', '<?', '</1>', '</>', '<!x>', '<!', '<!DOCTYPE html>',
  '<!DOCTYPE x "', '<!DOCTYPE x PUBLIC "a>b">',
  // tag and attribute shapes
  '<div title="', '<div title=\'', '"', "'", '>', '<', '</', '=', '/', '<a\0b>', '<div "onclick=pwn(ID)>',
  '" onmouseover="pwn(ID)" x="', "' onfocus='pwn(ID)' autofocus x='", ' onerror=pwn(ID) ', '<img src=x onerror="pwn(ID)"//>',
  // references
  '&', '&#106;', '&lt;', '&amp;', '&colon;', '&NotAName;',
  // text
  'x', ' ', '\n',
];

/** A seeded generator, so a failing case can be found again by its seed. */
export function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Generated hostile fragments: constructs and payloads strung together at random. */
export function hostileCases(count: number, seed = 1): string[] {
  const next = random(seed);
  const pick = <T>(list: readonly T[]): T => list[Math.floor(next() * list.length)];
  const cases: string[] = [];
  for (let index = 0; index < count; index++) {
    const length = 3 + Math.floor(next() * 18);
    let markup = '';
    for (let piece = 0; piece < length; piece++) markup += next() < 0.25 ? pick(PAYLOADS) : pick(PIECES);
    // always something to neutralize, last, after whatever the pieces opened
    markup += pick(PAYLOADS);
    cases.push(markup.replaceAll('ID', String(index)));
  }
  return cases;
}

/**
 * The holes the 2026-11-03 review found, and the containment ones found while rebuilding: each one
 * is markup the old rewriter let through with something live in it.
 */
export const REVIEW_CASES: Record<string, string> = {
  'a comment ended by --!>': '<!-- --!><img src=x onerror=pwn(1)> -->',
  'a comment ended by <!-->': '<!--><img src=x onerror=pwn(2)>-->',
  'a comment ended by <!--->': '<!---><img src=x onerror=pwn(3)>-->',
  'a bogus comment from </ and a digit': '</1 a="><img src=x onerror=pwn(5)>">',
  'a bogus comment from <! and a letter': '<!a b="><img src=x onerror=pwn(6)>">',
  'a tag name with characters the old scanner stopped at': '<style\u000b><img src=x onerror=pwn(8)></style\u000b>',
  'a self-closing style, still raw text': '<style/><!--</style><img src=x onerror=pwn(9)>-->',
  'xmp, raw text': '<xmp><!--</xmp><img src=x onerror=pwn(10)>--></xmp>',
  'iframe, raw text': '<iframe><!--</iframe><img src=x onerror=pwn(11)>--></iframe>',
  'noembed, raw text': '<noembed><!--</noembed><img src=x onerror=pwn(12)>--></noembed>',
  'noframes, raw text': '<noframes><!--</noframes><img src=x onerror=pwn(13)>--></noframes>',
  'noscript, raw text with scripting on': '<noscript><!--</noscript><img src=x onerror=pwn(14)>--></noscript>',
  'a script escape': '<script><!--<script></script><!--</script><img src=x onerror=pwn(15)>-->',
  'style in SVG is markup': '<svg><style><img src=x onerror=pwn(16)></style></svg>',
  'title in SVG is HTML': '<svg><title><iframe srcdoc="<script>parent.pwn(17)</script>"></iframe></title></svg>',
  'nested SVG keeps style as markup': '<svg><svg></svg><style><img src=x onerror=pwn(18)></style></svg>',
  'MathML in SVG is SVG': '<svg><math></math><style><img src=x onerror=pwn(19)></style></svg>',
  'mglyph in a MathML text integration point is MathML': '<math><mi><mglyph><style><img src=x onerror=pwn(20)></style>',
  'style in annotation-xml without an HTML encoding is MathML': '<math><annotation-xml><style><img src=x onerror=pwn(21)></style>',
  'CDATA in foreign content runs past the first >': '<svg><![CDATA[ > <!-- ]]><img src=x onerror=pwn(22)>--></svg>',
  'an entity-spelled meta refresh': '<meta http-equiv="&#114;efresh" content="0;url=about:blank#23">',
  'an end tag that closes the shadow root': '</template><img src=x onerror=pwn(25)>',
  'an end tag that closes braid-document': '</braid-document><img src=x onerror=pwn(26)>',
  'an unclosed textarea swallows the host': '<textarea>',
  'an unclosed comment swallows the host': '<!--',
  'an unclosed template swallows the host': '<template>',
  'an unclosed tag swallows the host': '<div title="',
  'plaintext swallows the host': '<plaintext>',
  'select with raw text old parsers ignore': '<select><style></select><img src=x onerror=pwn(33)></style>',
  'a link left open around an object wraps the host': '<a href=#x><object>',
  'a link left open around a table cell wraps the host': '<a href=#x><table><td>',
  'a template in column-group mode ignores raw text': '<template><col><style></template><img src=x onerror=pwn(34)></style>',
};
