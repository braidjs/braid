# What the gateway does to fragment markup

A trusted fragment's HTML ends up in the host page's document: pierced into the shell's first
response, or fetched from `/__braid/doc/` and inserted by the client. Before it gets there, the
gateway prepares it, so that **no markup a fragment sends runs code outside the fragment's realm or
navigates the host page.** Fragment code runs where Braid manages it — with the compat patches, the
lifecycle, and the teardown — or not at all.

That is a rule about *where* fragment code runs, not a security boundary. A trusted fragment already
holds the user's session; see [Trust tiers](./braid-boundary.md). The untrusted tier is a
cross-origin iframe, and the gateway never touches its markup.

## What is neutralized

| Markup | What happens | Why |
| --- | --- | --- |
| `<script>` | `type="inert"`, real type kept in `data-script-type` | the client runs it in the fragment's realm instead |
| `<link rel="preload\|prefetch\|modulepreload">` | `rel="inert-…"` | would load the fragment's code a second time in the host |
| `onclick`, `onerror`, any `on*` attribute | removed | compiled into a function in the host realm |
| `<meta http-equiv="refresh">` | `http-equiv` removed | navigates the whole host page |
| `<iframe srcdoc>` | removed | the frame's document runs on parse with the host's origin |
| `iframe[src]`, `embed[src]`, `object[data]` with any scheme but `http:`/`https:` (e.g. `javascript:`, `data:`, `blob:`) | removed; `about:blank` is kept | the same: the markup carries the document inline |
| relative subresource URLs (`img[src]`, `link[href]`, …) | re-rooted under `/__braid/frag/<id>/` | they would otherwise resolve against the host page |

Whenever a frame loses an attribute, the tag is marked with what was removed:

```html
<iframe title="Preview" data-braid-blocked="srcdoc"></iframe>
<object type="application/pdf" data-braid-blocked="data"></object>
```

If something a fragment renders standalone is missing when composed, look for `data-braid-blocked`
in the composed DOM first.

## Deliberate trade-offs

The frame rule is an allowlist and it is blunt on purpose. It looks at the markup, not at what the
browser would make of it. A narrower rule would have to decide which inline documents are safe, and
that decision would have to be right in every engine. So some harmless markup goes too:

| Removed | Harmless because | Instead |
| --- | --- | --- |
| `<iframe sandbox srcdoc="…">` without `allow-same-origin` | the frame gets an opaque origin | serve the document from a URL in the fragment's namespace (`<iframe sandbox src="preview.html">`) |
| `<object data="data:application/pdf;…">`, `<embed src="data:image/svg+xml;…">` | `data:` documents get an opaque origin in current browsers | serve the file from a URL; for an SVG, `<img src>` or inline `<svg>` |
| `blob:` URLs on frames | — | none needed: a `blob:` URL means nothing outside the page that created it, so served markup has no use for one. Frames that the fragment's code creates at runtime are not affected. |

Only markup the gateway serves is prepared. Frames that the fragment's own code creates in the
browser are never touched by this rule.

If a widget genuinely needs inline documents, and especially if it is third-party code, it belongs
in the [untrusted tier](./braid-boundary.md#choosing).

## What is not neutralized

**Links and form actions.** `<a href="javascript:…">` and `<form action="…">` are left alone. They
need a user to click, and a trusted fragment is allowed to navigate a page the user clicks through.

**Frame documents from the fragment's own namespace.** `<iframe src="widget.html">` becomes
`/__braid/frag/<id>/widget.html`. Whatever the fragment's origin serves there loads in a nested
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
