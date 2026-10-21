import { describe, expect, it } from 'vitest';
import type { DiscoveryEntry } from '@braidlabs/gateway';
import type { ShellManifest } from '@braidlabs/registry';
import { buildTopology, coTenants, neighborhood, FRAGMENT_PREFIX, ROUTE_PREFIX, SHELL_PREFIX } from './topology.js';
import { layoutTopology } from './topology-graph.js';

function entry(overrides: Partial<DiscoveryEntry> & { id: string }): DiscoveryEntry {
  return {
    title: overrides.id,
    adapter: 'compat',
    mount: `/__braid/frag/${overrides.id}/`,
    loadable: true,
    ...overrides,
  };
}

describe('buildTopology', () => {
  it('links a route to every fragment that pierces it', () => {
    const topology = buildTopology([
      entry({ id: 'billing', pierce: ['/billing/*'] }),
      entry({ id: 'reviews', pierce: ['/billing/*'] }),
    ]);

    expect(topology.routes).toHaveLength(1);
    expect(topology.routes[0].label).toBe('/billing/*');
    expect(topology.edges.filter((edge) => edge.kind === 'composes')).toHaveLength(2);
  });

  it('marks a route shared only when more than one fragment pierces it', () => {
    const topology = buildTopology([
      entry({ id: 'billing', pierce: ['/billing/*'] }),
      entry({ id: 'reviews', pierce: ['/billing/*'] }),
      entry({ id: 'payroll', pierce: ['/payroll/*'] }),
    ]);

    const byLabel = Object.fromEntries(topology.routes.map((route) => [route.label, route]));
    expect(byLabel['/billing/*'].shared).toBe(true);
    expect(byLabel['/payroll/*'].shared).toBe(false);
  });

  it('groups fragments served by the same origin', () => {
    const topology = buildTopology([
      entry({ id: 'billing', endpoint: 'http://shared.internal:9101/billing' }),
      entry({ id: 'invoices', endpoint: 'http://shared.internal:9101/invoices' }),
    ]);

    expect(topology.origins).toHaveLength(1);
    expect(topology.origins[0].label).toBe('shared.internal:9101');
    expect(topology.origins[0].degree).toBe(2);
  });

  // A production listing withholds endpoints. That is the gateway working, so the column is
  // reported as unavailable rather than drawn empty.
  it('reports origins as unknown when no entry carries an endpoint', () => {
    const topology = buildTopology([entry({ id: 'billing', pierce: ['/billing/*'] })]);

    expect(topology.origins).toHaveLength(0);
    expect(topology.originsUnknown).toBe(true);
  });

  it('does not claim unknown origins for an empty registry', () => {
    expect(buildTopology([]).originsUnknown).toBe(false);
  });

  // An unbound widget has no pierce pattern, so no route can honestly claim it.
  it('collects fragments that no route pierces', () => {
    const topology = buildTopology([
      entry({ id: 'billing', pierce: ['/billing/*'] }),
      entry({ id: 'rating' }),
    ]);

    expect(topology.unrouted.map((node) => node.label)).toEqual(['rating']);
  });

  it('sorts routes by how many fragments they carry, busiest first', () => {
    const topology = buildTopology([
      entry({ id: 'a', pierce: ['/quiet/*'] }),
      entry({ id: 'b', pierce: ['/busy/*'] }),
      entry({ id: 'c', pierce: ['/busy/*'] }),
    ]);

    expect(topology.routes.map((route) => route.label)).toEqual(['/busy/*', '/quiet/*']);
  });

  it('ignores an endpoint that is not a URL rather than inventing an origin', () => {
    const topology = buildTopology([entry({ id: 'billing', endpoint: 'not a url' })]);

    expect(topology.origins).toHaveLength(0);
  });
});

describe('neighborhood', () => {
  const entries = [
    entry({ id: 'billing', pierce: ['/billing/*'], endpoint: 'http://one:9101' }),
    entry({ id: 'reviews', pierce: ['/billing/*'], endpoint: 'http://two:9102' }),
    entry({ id: 'payroll', pierce: ['/payroll/*'], endpoint: 'http://three:9103' }),
  ];

  it('is empty with nothing selected', () => {
    expect(neighborhood(buildTopology(entries), null).nodes.size).toBe(0);
  });

  it('reaches the fragments a route composes', () => {
    const topology = buildTopology(entries);
    const lit = neighborhood(topology, `${ROUTE_PREFIX}/billing/*`);

    expect(lit.nodes.has(`${FRAGMENT_PREFIX}billing`)).toBe(true);
    expect(lit.nodes.has(`${FRAGMENT_PREFIX}reviews`)).toBe(true);
    expect(lit.nodes.has(`${FRAGMENT_PREFIX}payroll`)).toBe(false);
  });

  // Selecting a fragment answers "who else is on this page with me?", which needs the extra hop
  // through the shared route.
  it('reaches co-tenants from a fragment', () => {
    const topology = buildTopology(entries);
    const lit = neighborhood(topology, `${FRAGMENT_PREFIX}billing`);

    expect(lit.nodes.has(`${FRAGMENT_PREFIX}reviews`)).toBe(true);
    expect(lit.nodes.has(`${FRAGMENT_PREFIX}payroll`)).toBe(false);
  });
});

describe('coTenants', () => {
  it('lists the fragments sharing a route, and not the fragment itself', () => {
    const topology = buildTopology([
      entry({ id: 'billing', pierce: ['/billing/*'] }),
      entry({ id: 'reviews', pierce: ['/billing/*'] }),
      entry({ id: 'payroll', pierce: ['/payroll/*'] }),
    ]);

    expect(coTenants(topology, `${FRAGMENT_PREFIX}billing`)).toEqual([`${FRAGMENT_PREFIX}reviews`]);
    expect(coTenants(topology, `${FRAGMENT_PREFIX}payroll`)).toEqual([]);
  });
});

describe('buildTopology with shells', () => {
  const entries = [
    entry({ id: 'billing', pierce: ['/billing/*'], endpoint: 'https://billing.internal' }),
    entry({ id: 'notifications', endpoint: 'https://notify.internal' }),
    entry({ id: 'reviews', pierce: ['/reviews/*'] }),
  ];
  const shells: ShellManifest[] = [
    {
      id: 'portal',
      framework: 'react',
      routes: [
        { path: '/billing/*', layout: { areas: 'header\nmain' }, slots: { header: 'notifications', main: 'billing' } },
        { path: '/settings', layout: { areas: 'main' }, slots: { main: 'ghost' } },
      ],
    },
  ];

  it('adds shell nodes that host their routes, and slots the fragments their layouts place', () => {
    const topology = buildTopology(entries, { shells });

    expect(topology.shells.map((node) => node.label)).toEqual(['portal']);
    expect(topology.edges.filter((edge) => edge.kind === 'hosts').map((edge) => edge.to)).toEqual([
      `${ROUTE_PREFIX}/billing/*`,
      `${ROUTE_PREFIX}/settings`,
    ]);
    // billing already pierces /billing/*, so routing draws that pair; only notifications needs a slot edge.
    expect(topology.edges.filter((edge) => edge.kind === 'slots')).toEqual([
      { from: `${ROUTE_PREFIX}/billing/*`, to: `${FRAGMENT_PREFIX}notifications`, kind: 'slots' },
    ]);
    expect(topology.routes.find((route) => route.label === '/billing/*')?.shared).toBe(true);
  });

  it('draws a shell route nothing pierces, and ignores slots naming unregistered fragments', () => {
    const topology = buildTopology(entries, { shells });

    expect(topology.routes.find((route) => route.label === '/settings')?.degree).toBe(0);
    expect(topology.edges.some((edge) => edge.to === `${FRAGMENT_PREFIX}ghost`)).toBe(false);
  });

  it('reaches every fragment a shell composes from the shell node', () => {
    const topology = buildTopology(entries, { shells });
    const lit = neighborhood(topology, `${SHELL_PREFIX}portal`);

    expect(lit.nodes.has(`${FRAGMENT_PREFIX}billing`)).toBe(true);
    expect(lit.nodes.has(`${FRAGMENT_PREFIX}notifications`)).toBe(true);
    expect(lit.nodes.has(`${FRAGMENT_PREFIX}reviews`)).toBe(false);
  });

  it('is unchanged without shells', () => {
    const { shells: none, ...withoutShells } = buildTopology(entries);
    const { shells: empty, ...withEmpty } = buildTopology(entries, { shells: [] });

    expect(none).toEqual([]);
    expect(empty).toEqual([]);
    expect(withEmpty).toEqual(withoutShells);
    expect(withoutShells.edges.every((edge) => edge.kind === 'composes' || edge.kind === 'served-by')).toBe(true);
  });

  it('adds a shells column to the layout only when there are shells', () => {
    expect(new Set(layoutTopology(buildTopology(entries)).nodes.map((node) => node.x)).size).toBe(3);
    expect(new Set(layoutTopology(buildTopology(entries, { shells })).nodes.map((node) => node.x)).size).toBe(4);
  });
});
