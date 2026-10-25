import { layout, subnav, type Page } from './layout';
import contactBody from './partials/contact.html';
import thanksBody from './partials/contact-thanks.html';

/** The hosted-Braid contact form and its thanks page: plain host pages, no fragments. */

export function contact(): Page {
  return {
    path: 'contact/index.html',
    html: layout({
      title: 'Hosted Braid — get in touch',
      description: 'Interested in hosted Braid? Tell us what you’re putting together and we’ll reply by email.',
      base: '../',
      head: [
        '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>',
        '<script type="module" src="%BASE%contact.js"></script>',
      ].join('\n'),
      body: `${subnav('../')}\n${contactBody}`,
    }),
  };
}

export function contactThanks(): Page {
  return {
    path: 'contact/thanks/index.html',
    html: layout({
      title: 'Thanks — we’ll be in touch',
      description: 'Your message is on its way to the Braid team.',
      base: '../../',
      body: `${subnav('../../')}\n${thanksBody}`,
    }),
  };
}
