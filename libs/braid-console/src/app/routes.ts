/**
 * The standalone app's views, in the URL hash so a view is a link someone can paste into a ticket.
 *
 * Old links keep working: `#fragments`, `#topology` and `#edit` mean what they always did, and
 * anything unrecognized lands on the fragment list rather than a blank page.
 */
export type View = 'fragments' | 'topology' | 'shells' | 'history' | 'edit';

export interface Route {
  view: View;
  /** `#shells/<id>`: the shell open in the designer. */
  shell?: string;
}

export function readRoute(hash: string, edit: boolean): Route {
  const [view = '', ...rest] = hash.replace(/^#\/?/, '').split('/');
  if (view === 'topology' || view === 'history') return { view };
  if (view === 'edit' && edit) return { view };
  if (view === 'shells') {
    const id = rest.join('/');
    if (!id) return { view };
    try {
      return { view, shell: decodeURIComponent(id) };
    } catch {
      return { view };
    }
  }
  return { view: 'fragments' };
}

export function routeHash(route: Route): string {
  return route.view === 'shells' && route.shell ? `shells/${encodeURIComponent(route.shell)}` : route.view;
}
