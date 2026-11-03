import { versioned } from '@braidlabs/skew';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetSharedInvalidators } from './invalidation.js';
import { memoryRecordDriver } from './memory-driver.js';
import { createOutbox } from './outbox.js';
import { createDataClient, type DataClient, type Query, type QueryState } from './query.js';
import { createRecordStore } from './record-store.js';
import { createTenancy } from './tenancy.js';
import type { PushSink } from './adapters.js';

/**
 * The storefront from `docs/tutorials/07-storefront.md`, executed in the order the tutorial builds
 * it: a guest arrives, browses, signs in, orders, loses the network mid-checkout, gets a shipping
 * event, and signs out.
 *
 * A tutorial whose snippets do not run is worse than no tutorial — the reader assumes they made the
 * mistake. These are the tutorial's own shapes, so a change that breaks the walkthrough fails here
 * first.
 */

interface Product {
  id: string;
  name: string;
  priceCents: number;
}

interface Order {
  id: string;
  productId: string;
  quantity: number;
  status: 'placed' | 'shipped';
  /** Assigned by the server — the client cannot know it. */
  reference?: string;
}

const ProductContract = versioned<Product>('shop.product');
const OrderContract = versioned<Order>('shop.order');

/** Step 2 — declared once, and used by the tenancy that purges them and the clients that read them. */
const COLLECTIONS = ['catalogue', 'orders', 'cart', 'outbox'];

/** Step 1 — tenancy first, because the partition decides where everything else lands. */
function openStore(driver = memoryRecordDriver()) {
  const tenancy = createTenancy({ driver, collections: COLLECTIONS });
  return { driver, tenancy };
}

/** Step 2 — one client per collection, all reading the partition from tenancy. */
function connect(driver: ReturnType<typeof memoryRecordDriver>, tenancy: ReturnType<typeof createTenancy>) {
  const errors: string[] = [];
  const orders = createDataClient({
    driver,
    partition: tenancy.partition,
    collection: 'orders',
    outbox: createOutbox({ driver, owner: 'storefront', collection: 'outbox', partition: tenancy.partition }),
    onFlushError: (message) => errors.push(message),
    autoFlush: false,
  });
  const catalogue = createDataClient({ driver, partition: tenancy.partition, collection: 'catalogue' });
  return { orders, catalogue, errors };
}

const settled = <T>(query: Query<T>, predicate: (state: QueryState<T>) => boolean) =>
  new Promise<QueryState<T>>((resolve) => {
    const stop = query.subscribe((state) => {
      if (!predicate(state)) return;
      queueMicrotask(() => {
        stop();
        resolve(state);
      });
    });
  });

afterEach(() => resetSharedInvalidators());

describe('the storefront, in build order', () => {
  it('step 1: a guest gets a partition of their own, and reads are refused before that', async () => {
    const { tenancy } = openStore();

    expect(() => tenancy.partition()).toThrow(/sign in before reading/);

    const guest = await tenancy.signIn({ userId: 'guest:device-42' });
    expect(guest).toBe(tenancy.partition());
  });

  it('step 3: the catalogue is fetched once and served from storage after that', async () => {
    const { driver, tenancy } = openStore();
    await tenancy.signIn({ userId: 'guest:device-42' });
    const { catalogue } = connect(driver, tenancy);

    const fetches = vi.fn(async () => ({ id: 'p1', name: 'Cast iron pan', priceCents: 4900 }));
    const definition = {
      key: 'product:p1',
      tags: ['product#p1'],
      schema: ProductContract,
      fetch: fetches,
      staleWhileRevalidate: false,
    };

    const first = catalogue.query<Product>(definition);
    await settled(first, (state) => state.data !== undefined);
    first.dispose();

    // A second reader — another component, another app on the page — pays nothing.
    const second = catalogue.query<Product>(definition);
    const state = await settled(second, (s) => s.data !== undefined);

    expect(state.data?.name).toBe('Cast iron pan');
    expect(state.fromCache).toBe(true);
    expect(fetches).toHaveBeenCalledTimes(1);

    second.dispose();
    catalogue.close();
  });

  it('step 6: the guest cart follows them into the account they sign in to', async () => {
    const { driver, tenancy } = openStore();
    const carts = createRecordStore<{ id: string; items: number }>({
      driver,
      collection: 'cart',
      schema: versioned<{ id: string; items: number }>('shop.cart'),
    });

    const guest = await tenancy.signIn({ userId: 'guest:device-42' });
    await carts.put({ id: 'cart', partition: guest, value: { id: 'cart', items: 2 } });

    await tenancy.signIn({ userId: 'user:ana' });
    const result = await tenancy.adopt(guest, { collections: ['cart'], mode: 'move' });

    expect(result).toEqual({ copied: 1, skipped: 0, replaced: 0 });
    expect((await carts.get('cart', tenancy.partition()))?.value.items).toBe(2);
    // 'move' leaves nothing behind on a shared device.
    expect(await carts.get('cart', guest)).toBeNull();
  });

  it('step 6: an account that already has a cart keeps its own', async () => {
    const { driver, tenancy } = openStore();
    const carts = createRecordStore<{ id: string; items: number }>({
      driver,
      collection: 'cart',
      schema: versioned<{ id: string; items: number }>('shop.cart'),
    });

    const guest = await tenancy.signIn({ userId: 'guest:device-42' });
    await carts.put({ id: 'cart', partition: guest, value: { id: 'cart', items: 2 } });

    await tenancy.signIn({ userId: 'user:ana' });
    await carts.put({ id: 'cart', partition: tenancy.partition(), value: { id: 'cart', items: 9 } });

    const result = await tenancy.adopt(guest, { collections: ['cart'] });

    // Signing in on a shared laptop must not replace someone's real basket with the last guest's.
    expect(result.skipped).toBe(1);
    expect((await carts.get('cart', tenancy.partition()))?.value.items).toBe(9);
  });

  it('step 6: signing in moves to a different partition and leaves the guest one on disk', async () => {
    const { driver, tenancy } = openStore();
    await tenancy.signIn({ userId: 'guest:device-42' });
    const guestPartition = tenancy.partition();

    const { catalogue } = connect(driver, tenancy);
    const browsing = catalogue.query<Product>({
      key: 'product:p1',
      schema: ProductContract,
      fetch: async () => ({ id: 'p1', name: 'Cast iron pan', priceCents: 4900 }),
    });
    await settled(browsing, (state) => state.data !== undefined);
    browsing.dispose();
    catalogue.close();

    await tenancy.signIn({ userId: 'user:ana' });

    // A different person, so a different partition. Nothing carries over on its own — which is the
    // point of the boundary, and why a guest cart has to be copied deliberately.
    expect(tenancy.partition()).not.toBe(guestPartition);
  });

  it('step 5: placing an order shows instantly, then settles to what the server stored', async () => {
    const { driver, tenancy } = openStore();
    await tenancy.signIn({ userId: 'user:ana' });
    const { orders } = connect(driver, tenancy);

    const placed = await orders.mutate<Order>({
      key: 'order:o1',
      schema: OrderContract,
      mutationId: 'order.place',
      input: { id: 'o1', productId: 'p1', quantity: 1 },
      patch: { id: 'o1', productId: 'p1', quantity: 1, status: 'placed' },
      tags: ['orders'],
      send: async (input) => ({ ...(input as Order), status: 'placed', reference: 'ORD-8821' }),
    });

    expect(placed.status).toBe('confirmed');
    // The server knows things the client cannot guess, and its answer is what is stored.
    expect(placed.value?.reference).toBe('ORD-8821');

    orders.close();
  });

  it('step 5: a server that changes the order tells you, rather than swapping it silently', async () => {
    const { driver, tenancy } = openStore();
    await tenancy.signIn({ userId: 'user:ana' });
    const { orders } = connect(driver, tenancy);

    const placed = await orders.mutate<Order>({
      key: 'order:o2',
      schema: OrderContract,
      mutationId: 'order.place',
      input: { id: 'o2', productId: 'p1', quantity: 5 },
      patch: { id: 'o2', productId: 'p1', quantity: 5, status: 'placed' },
      // only two left in stock
      send: async (input) => ({ ...(input as Order), quantity: 2, status: 'placed' }),
    });

    expect(placed.conflict?.paths).toEqual(['quantity']);
    expect((placed.conflict?.actual as Order).quantity).toBe(2);
    expect(placed.value?.quantity).toBe(2);

    orders.close();
  });

  it('step 6: an order placed with no network is kept, shown, and sent later', async () => {
    const { driver, tenancy } = openStore();
    await tenancy.signIn({ userId: 'user:ana' });
    const { orders } = connect(driver, tenancy);

    let online = false;
    const send = async (input: unknown) => {
      if (!online) throw new TypeError('Failed to fetch');
      return { ...(input as Order), status: 'placed', reference: 'ORD-9002' };
    };

    const outcome = await orders.mutate<Order>({
      key: 'order:o3',
      schema: OrderContract,
      mutationId: 'order.place',
      input: { id: 'o3', productId: 'p1', quantity: 1 },
      patch: { id: 'o3', productId: 'p1', quantity: 1, status: 'placed' },
      tags: ['orders'],
      send,
    });

    expect(outcome.status).toBe('queued');

    online = true;
    expect((await orders.flush()).sent).toBe(1);

    orders.close();
  });

  it('step 6: after a reload the queue needs its mutation kinds re-registered', async () => {
    const driver = memoryRecordDriver();
    const { tenancy } = openStore(driver);
    await tenancy.signIn({ userId: 'user:ana' });

    const before = connect(driver, tenancy);
    await before.orders.mutate<Order>({
      key: 'order:o4',
      schema: OrderContract,
      mutationId: 'order.place',
      input: { id: 'o4', productId: 'p1', quantity: 1 },
      patch: { id: 'o4', productId: 'p1', quantity: 1, status: 'placed' },
      send: async () => {
        throw new TypeError('Failed to fetch');
      },
    });
    before.orders.close();

    // The reload. The closure that would have sent it is gone; the entry is not.
    const { tenancy: reopened } = openStore(driver);
    await reopened.signIn({ userId: 'user:ana' });
    const after = connect(driver, reopened);

    expect((await after.orders.flush()).remaining).toBe(1);
    expect(after.errors[0]).toContain('no registered mutation');

    after.orders.registerMutation('order.place', async (input) => input, { tags: ['orders'] });
    expect((await after.orders.flush()).sent).toBe(1);

    after.orders.close();
  });

  it('step 7: a shipping event from the server lands enveloped and refreshes readers', async () => {
    const { driver, tenancy } = openStore();
    await tenancy.signIn({ userId: 'user:ana' });
    const { orders } = connect(driver, tenancy);

    const fetches = vi.fn(async () => ({
      id: 'o1',
      productId: 'p1',
      quantity: 1,
      status: 'placed' as const,
      reference: 'ORD-8821',
    }));
    const watching = orders.query<Order>({
      key: 'order:o1',
      schema: OrderContract,
      fetch: fetches,
      staleWhileRevalidate: false,
    });
    await settled(watching, (state) => state.data !== undefined);

    let sink!: PushSink;
    const disconnect = orders.connect({ schema: OrderContract, source: (given) => void (sink = given) });

    await sink.receive({
      key: 'order:o1',
      value: { id: 'o1', productId: 'p1', quantity: 1, status: 'shipped', reference: 'ORD-8821' },
    });
    const shipped = await settled(watching, (state) => state.data?.status === 'shipped');

    expect(shipped.data?.status).toBe('shipped');
    // The push *is* the newest thing anyone has, so it does not send the reader back to the network.
    expect(fetches).toHaveBeenCalledTimes(1);

    disconnect();
    watching.dispose();
    orders.close();
  });

  it('step 8: signing out destroys this user\'s data and refuses reads', async () => {
    const { driver, tenancy } = openStore();
    await tenancy.signIn({ userId: 'user:ana' });
    const { orders } = connect(driver, tenancy);

    await orders.mutate<Order>({
      key: 'order:o5',
      schema: OrderContract,
      mutationId: 'order.place',
      input: { id: 'o5', productId: 'p1', quantity: 1 },
      patch: { id: 'o5', productId: 'p1', quantity: 1, status: 'placed' },
      send: async (input) => input,
    });

    await tenancy.signOut();

    expect(() => tenancy.partition()).toThrow(/sign in before reading/);

    // And the client cannot serve anything either, because it reads the partition on every access.
    // The query reports it as an error state rather than throwing at the call site: it has a
    // subscriber, not a promise the caller could have caught.
    const orphan = orders.query<Order>({
      key: 'order:o5',
      schema: OrderContract,
      fetch: async () => ({ id: 'o5', productId: 'p1', quantity: 1, status: 'placed' }),
    });
    const failed = await settled(orphan, (state) => state.status === 'error');
    expect(String((failed.error as Error).message)).toContain('sign in before reading');
    orphan.dispose();

    orders.close();
  });
});

/** The bootstrap the tutorial recommends, in one place, as an application would write it. */
describe('the recommended bootstrap', () => {
  it('re-registers mutation kinds before anything can flush', async () => {
    const driver = memoryRecordDriver();

    async function bootstrap(principal: { userId: string }): Promise<{ orders: DataClient }> {
      const tenancy = createTenancy({ driver, collections: COLLECTIONS });
      await tenancy.recover(); // finish any purge a previous session was interrupted mid-way
      await tenancy.signIn(principal);

      const orders = createDataClient({
        driver,
        partition: tenancy.partition,
        collection: 'orders',
        outbox: createOutbox({ driver, owner: 'storefront', collection: 'outbox', partition: tenancy.partition }),
        autoFlush: false,
      });

      // Before anything can flush: the queue may already hold writes from a previous session.
      orders.registerMutation('order.place', async (input) => input, { tags: ['orders'] });
      await orders.flush();

      return { orders };
    }

    const first = await bootstrap({ userId: 'user:ana' });
    await first.orders.mutate<Order>({
      key: 'order:o6',
      schema: OrderContract,
      mutationId: 'order.place',
      input: { id: 'o6', productId: 'p1', quantity: 1 },
      patch: { id: 'o6', productId: 'p1', quantity: 1, status: 'placed' },
      send: async () => {
        throw new TypeError('Failed to fetch');
      },
    });
    first.orders.close();

    // A fresh start-up drains what the last one could not send, with no extra wiring.
    const second = await bootstrap({ userId: 'user:ana' });
    expect((await second.orders.flush()).remaining).toBe(0);
    second.orders.close();
  });
});
