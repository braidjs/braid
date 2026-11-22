# What the gateway does to fragment markup

A trusted fragment's HTML ends up in the host page's document: pierced into the shell's first
response, or fetched from `/__braid/doc/` and inserted by the client. Before it gets there, the
gateway prepares it, so that **no code a fragment's markup carries inline runs outside the fragment's
realm or navigates the host page.** Inline code runs where Braid manages it — with the compat
patches, the lifecycle, and the teardown — or not at all.

That is a rule about _where_ fragment code runs, not a security boundary. A trusted fragment already
holds the user's session; see [Trust tiers](./braid-boundary.md). The untrusted tier is a
cross-origin iframe, and the gateway never touches its markup.

## What is neutralized

| Markup                                                                                                                  | What happens                                                                                                                               | Why                                                                                                                                                               |
| ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<script>`                                                                                                              | `type="inert"`, real type kept in `data-script-type`                                                                                       | the client runs it in the fragment's realm instead                                                                                                                |
| `<link rel="preload\|prefetch\|modulepreload">`                                                                         | `rel="inert-…"`                                                                                                                            | would load the fragment's code a second time in the host                                                                                                          |
| `onclick`, `onerror`, any `on*` attribute                                                                               | removed                                                                                                                                    | compiled into a function in the host realm                                                                                                                        |
| `<meta http-equiv="refresh">`                                                                                           | `http-equiv` removed                                                                                                                       | navigates the whole host page                                                                                                                                     |
| `<iframe srcdoc>`                                                                                                       | removed                                                                                                                                    | the frame's document runs on parse with the host's origin                                                                                                         |
| `iframe[src]`, `embed[src]`, `object[data]` with any scheme but `http:`/`https:` (e.g. `javascript:`, `data:`, `blob:`) | removed; `about:blank` is kept                                                                                                             | a `javascript:` frame runs on parse with the host's origin; `data:` and `blob:` are refused alongside it as the same shape — a document the markup carries inline |
| relative and root-relative subresource URLs (`img[src]`, `link[href]`, …)                                               | resolved against the fragment's `<base href>`, then re-rooted under `/__braid/frag/<id>/` (behind the gateway's `basePath`, if it has one) | they would otherwise resolve against the host page                                                                                                                |

The same rule applies to subresource URLs that the fragment's _code_ sets, through the property
(`frame.src = 'silent-renew.html'`) or `setAttribute`/`setAttributeNS`. The client applies it when
the URL is set, against the same base the gateway uses (the fragment's own `<base href>`, default
`/`). A hidden auth iframe or a lazily set image then loads from the fragment rather than the host,
on every route. Navigation targets (`a[href]`, `form[action]`) are left alone in both cases.

- **Reading an attribute back** returns the re-rooted path, as it does for prepared markup.
  Setting it again is safe, because a URL already inside the fragment's namespace is left alone.
- **Not covered:** HTML that fragment script inserts as a string (`innerHTML`,
  `insertAdjacentHTML`, a template's content) and attributes set through `Attr` objects
  (`setAttributeNode`, `attr.value`). Those keep their URLs as written, so they resolve against
  the host page. Prefer absolute or root-relative URLs there.
- **`srcset` candidates are split on commas,** in markup and script alike, so a candidate URL that
  itself contains a comma isn't handled.

Whenever a frame loses an attribute, and when a meta refresh is defanged, the tag is marked with
what was removed:

```html
<iframe title="Preview" data-braid-blocked="srcdoc"></iframe>
<object type="application/pdf" data-braid-blocked="data"></object>
<meta content="0;url=/elsewhere" data-braid-blocked="meta-refresh" />
```

If something a fragment renders standalone is missing when composed, look for `data-braid-blocked`
in the composed DOM first.

## How the gateway reads it

Every rule above is only as good as the gateway's reading of the markup. If it takes something for
text, a comment or an attribute value that the browser takes for a tag, that tag reaches the page
with nothing neutralized. So the gateway tokenizes as the HTML spec does. That covers every way a
comment can end, bogus comments and doctypes that end at the first `>`, raw text in `<xmp>`,
`<iframe>`, `<noembed>`, `<noframes>` and `<noscript>`, and the escapes inside `<script>`. It also
follows the part of tree construction that decides how the rest is tokenized: which elements are SVG
or MathML (where `<style>` is not raw text), where HTML starts again inside them, and which templates
are open.

Some markup is read differently by different browsers, or depends on recovery a browser makes from a
mistake. A fragment's markup is written out so that it can only be read one way:

| Markup                                                                                                              | What happens                                                                                                                           |
| ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| SVG/MathML that HTML breaks out of (`<svg><p>`), or that an end tag below it closes                                 | closed explicitly, element by element                                                                                                  |
| implied end tags and misnesting inside HTML in SVG/MathML (`<foreignObject>`, `<desc>`…)                            | closed explicitly                                                                                                                      |
| table structure (`<table>`, `<tr>`, `<td>`…) inside HTML in SVG/MathML                                              | removed: a table can clear the stack through the SVG                                                                                   |
| `<![CDATA[…]]>`                                                                                                     | written as the text it is                                                                                                              |
| `<?…>`, `</1…>`, `<!…>`                                                                                             | written as the comment the browser makes of them                                                                                       |
| a literal `<` in text                                                                                               | written as `&lt;`                                                                                                                      |
| `<style>`, `<xmp>`, `<iframe>`, `<noembed>`, `<noframes>`, `<title>`, SVG/MathML, `<object>` inside `<select>`      | removed: customizable select keeps them, older parsers ignore them                                                                     |
| a tag that closes a `<select>` (`<input>`, another `<select>`…)                                                     | `</select>` written first                                                                                                              |
| a `<template>` whose first child is `<col>`                                                                         | everything but `<col>` and `<template>` removed: such a template ignores the rest                                                      |
| `<noscript>`                                                                                                        | removed with its content: raw text with scripting on, markup with it off                                                               |
| `<frameset>`, `<frame>`                                                                                             | removed                                                                                                                                |
| `<plaintext>`                                                                                                       | becomes a `<pre data-braid-blocked="plaintext">` with the rest of the fragment as escaped text                                         |
| `<image>`                                                                                                           | written as the `<img>` the browser makes of it                                                                                         |
| an attribute the gateway reads (`rel`, `src`, `http-equiv`…) with a named reference it does not know (`&NotAName;`) | removed and named in `data-braid-blocked`: the gateway decodes numeric references and the common names, and does not guess at the rest |

A removed element leaves a comment where it was, such as `<!--braid-blocked noscript-->`.

The fragment is also kept inside the element it is placed in. Suppose it writes an end tag for an
element it did not open, such as `</template>`, `</braid-document>` or `</fragment-slot>`. That end
tag is removed. Whatever the fragment leaves open is closed at its end: templates, selects, SVG and
MathML, raw text, a comment, and the elements that would let its formatting outlive it (`<object>`,
table cells, captions). A tag cut off by the end of the fragment is dropped, as the browser drops it.

A fetched fragment is parsed where a pierced one is: inside a `<braid-document>` in a template of
the host page, with scripting on. So both paths read the markup the same way, and a bare snippet's
leading `<style>` stays with it.

On well-formed markup none of this changes the DOM, with three exceptions. `<noscript>` goes, and
so does table structure inside `<foreignObject>`. Markup that customizable select allows inside a
`<select>`, such as an SVG icon in an `<option>`, is removed too. The rewriter's tests check this against the previous rewriter
in parse5 and in Chromium. They also run the holes the November review found, and thousands of
generated hostile fragments, through both parsers in both contexts.

## Deliberate trade-offs

The frame rule is an allowlist and it is blunt on purpose. It looks at the markup, not at what the
browser would make of it. A narrower rule would have to decide which inline documents are safe, and
that decision would have to be right in every engine. So some harmless markup goes too:

| Removed                                                                        | Harmless because                                           | Instead                                                                                                        |
| ------------------------------------------------------------------------------ | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `<iframe sandbox srcdoc="…">` without `allow-same-origin`                      | the frame gets an opaque origin                            | serve the document from a URL in the fragment's namespace (`<iframe sandbox src="preview.html">`)              |
| `<object data="data:application/pdf;…">`, `<embed src="data:image/svg+xml;…">` | `data:` documents get an opaque origin in current browsers | serve the file from a URL; for an SVG, `<img src>` or inline `<svg>`                                           |
| `blob:` URLs on frames                                                         | —                                                          | none needed: a `blob:` URL means nothing outside the page that created it, so served markup has no use for one |

Only markup the gateway serves is prepared. Frames that the fragment's own code creates in the
browser are never touched by this rule.

If a widget genuinely needs inline documents, and especially if it is third-party code, it belongs
in the [untrusted tier](./braid-boundary.md#choosing).

## What is not neutralized

**Links and form actions.** `<a href="javascript:…">` and `<form action="…">` are left alone. They
need a user to click, and a trusted fragment is allowed to navigate a page the user clicks through.

**Frame documents from the fragment's own namespace.** `<iframe src="widget.html">` becomes
`/__braid/frag/<id>/widget.html` (resolved against the fragment's `<base href>`). Whatever the fragment's origin serves there loads in a nested
frame with the host's origin, unprepared, and its scripts can reach `top`. That is deliberate.
The fragment's realm is already a same-origin iframe running its code, and the namespace serves that
same HTML to any link or `window.open` anyway. So the frame gives the fragment nothing new. The
gateway also cannot tell a frame from markup from one the fragment's code created (an OIDC
silent-refresh frame, say), so sandboxing these would break legitimate fragments without isolating
anything. One consequence: such a document carries the fragment origin's response headers,
including its CSP, not the shell's.

Both cases follow from the same fact: registering a trusted fragment grants it the user's session.
When that is not acceptable for a fragment, the answer is `trust="untrusted"`, not more
sanitization.

## Markup a compat fragment writes at runtime

The gateway's rules cover the markup a fragment _sends_. Markup its code _writes_ afterwards, with
`innerHTML`, `outerHTML`, a template, a `Range` or any other parser, goes into the host document as
written. On every compat fragment, with no option to set, the following is enforced:

- **A script runs only if the fragment's own document or the gateway made it.** That means:
  - a script the fragment created with `document.createElement('script')`;
  - one in the gateway's prepared markup, including inside its templates;
  - a clone, made through the boundary, of either, if it has not run yet.

  A script that markup produced through a parser never runs, however it reaches the DOM: moved,
  cloned, copied through a `Range`, or instantiated from a template the fragment wrote. That
  matches the browser, which never runs a `<script>` that `innerHTML` parsed. The one stricter
  case is `Range.createContextualFragment`: its scripts would run natively, and here they do not.
  Create a script element instead. Every JavaScript type a browser runs counts as a script, not
  only the common spellings (`application/javascript`, `text/ecmascript` and the rest).

- **A script runs once, in the realm, and never in the host.** Braid runs a fresh copy of each
  fragment script in the realm. Before the original reaches the fragment's DOM, the browser marks
  it "already started": Braid connects it once to a document with no browsing context, where it is
  prepared without running. So a host that later moves the slot (reordering a list, a portal, drag
  and drop), or code that changes the script's type, text or `src`, cannot make the browser run it
  in the host window. Scripts keep their real `type`, so selectors by type still match.
- **Braid's markers are Braid's.** The gateway and the boundary neutralize scripts as
  `type="inert"`, and preload links as `rel="inert-*"`. A script or link that _arrives_ carrying
  those markers, such as one a fragment wrote from user data, stays exactly as inert as it would be
  natively. The gateway renames any `rel="inert-*"` it finds in a fragment's own markup.
- **Data blocks keep their type.** A written `<script type="application/json">` is left in the DOM
  with its type, so code that looks it up still finds it. It runs nowhere either way.
- **A nested slot cannot bring its own code.** A `<fragment-slot>` inside another fragment's DOM
  may compose registered fragments by name, but it may not declare an `entry` or be
  `trust="untrusted"`. Such a slot fails with a `slot-config` error. Both name code (or an
  origin) to run, and an untrusted slot would also receive whatever capabilities the host granted
  its name. Slots inside the host's own components' shadow roots are the host's and are unaffected.

To also strip handlers and `javascript:` URLs from those writes, opt in to `capabilities.html`
(see `@braidlabs/core`, "Sanitizing a fragment's own HTML writes").
