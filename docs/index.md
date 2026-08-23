---
layout: home

hero:
  name: Braid
  text: Tangle-free microfrontends.
  tagline: Independently deployed applications composed into one document, one layout, and one accessibility tree — with each app's JavaScript isolated in its own realm.
  actions:
    - theme: brand
      text: Get started
      link: /getting-started
    - theme: alt
      text: Braid, explained
      link: /braid-explained
    - theme: alt
      text: View on GitHub
      link: https://github.com/braidjs/braid

features:
  - title: Split where the code runs from where the DOM lives
    details: Each app's JavaScript executes in its own hidden realm with its own globals and module registry. Its rendered HTML sits in the main page, in normal layout flow.
  - title: Composed on the server, painted before JavaScript
    details: The gateway fetches the shell and every fragment in parallel and splices them as they stream. curl the page and the content is already there — for SSR and SPA fragments alike.
  - title: Zero code changes
    details: The compat adapter gives an unmodified Angular or React app a convincing document, window, location and history, all wired to its own shadow root and route.
  - title: The failure modes are published
    details: What goes wrong in practice, by symptom, with causes and fixes. Read it before debugging anything.
---
