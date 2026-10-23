# Tutorial 7 — Build a storefront, end to end

**Package:** `@braidlabs/data` · **Time:** ~45 minutes ·
**Prerequisites:** none, though [tutorial 6](04-data-storage.md) is the reference for anything here
you want more detail on.

Tutorial 4 is a tour of the parts. This one builds one thing, in the order you would actually build
it, and every step earns its place by solving a problem the previous step created.

**What you will build:** a storefront that works for a guest, keeps their data separate from the
signed-in customer's, places orders that survive the network dropping mid-checkout, reacts to a
shipping event pushed from the server, and destroys everything on sign-out. The last section takes
the same storefront and splits it across several independently deployed micro-frontends sharing one
partition.

Every snippet on this page is executed by
[`storefront.spec.ts`](https://github.com/braidjs/braid/blob/main/libs/data/src/lib/storefront.spec.ts). If one of them does not work for
you, that is a bug on our side, not yours.

---

## The order these steps come in

That order is itself the lesson, so it is worth saying why before you write any code.

**Tenancy is the first real decision.** Every record this library stores lands in a *partition*, and
the partition is derived from who is signed in. Decide that late and you will have written a pile of
code whose data all landed in the wrong place — or worse, in one place shared by two people who used
the same laptop.

Two things have to exist before you can make that decision, though, and they are steps 1 and 2: the
**contracts** that describe your data, and the **driver** that says where bytes live. Then tenancy.
Then reads, because they are the easy half. Then writes, which is where optimism and durability come
from. Then the server pushing at you. Then sign-out, which has to actually destroy things.

---

## Step 1 — Describe your data

Every record is stored inside an envelope stamped with the version it was written at. That is not
ceremony: a record written today is read by a build that does not exist yet, and by one you shipped
last year that is still open in somebody's tab.

```ts
import { versioned } from '@braidlabs/skew';

export interface Product {
  id: string;
  name: string;
  priceCents: number;
}

export interface Order {
  id: string;
  productId: string;
  quantity: number;
  status: 'placed' | 'shipped';
  /** Assigned by the server — the client cannot know it. */
  reference?: string;
}

export const ProductContract = versioned<Product>('shop.product');
export const OrderContract = versioned<Order>('shop.order');
```

A contract with no migrations yet is still worth declaring, because the alternative is retrofitting
one onto records already on ten thousand devices. When the shape changes you add a step:

```ts
export const OrderContract = versioned<OrderV1>('shop.order').next<OrderV2>('carry the currency', {
  up: (v1) => ({ ...v1, currency: 'GBP' }),
  down: ({ currency, ...rest }) => rest, // lets older readers still read new records
  derives: ['currency'], // the value is this migration's guess, not the server's word
  lossy: ['currency'],
});
```

The name (`'shop.order'`) is the identity that ties versions together, so choose it once and do not
rename it.

---

## Step 2 — Open storage

The **driver** is where bytes go. It is the one piece you choose per environment, and every collection
has to be declared up front — IndexedDB can only create object stores during a version upgrade, so a
collection you forgot cannot be conjured later:

```ts
import { indexedDbRecordDriver } from '@braidlabs/data';

const driver = indexedDbRecordDriver({
  database: 'storefront',
  collections: ['catalogue', 'orders', 'cart', 'outbox'],
});
```

In tests, or on the server where there is no IndexedDB, swap the driver and change nothing else:

```ts
import { memoryRecordDriver } from '@braidlabs/data';
const driver = memoryRecordDriver();
```

That list of collections appears twice more — in the tenancy that purges them and in the clients that
read them — so declare it once and export it:

```ts
export const COLLECTIONS = ['catalogue', 'orders', 'cart', 'outbox'] as const;
```

A **collection** is a bucket of records of one kind. A **partition** is who they belong to, and comes
next.

> **When several apps share one database**, each declares the collections it uses and the driver
> reconciles them — it opens at whatever version exists and adds only the stores actually missing, so
> two fragments with different lists converge instead of fighting over a version number. Declaring the
> same list everywhere is still simpler, and a shared contracts package is the natural place for it.

---

## Step 3 — Decide who the data belongs to

Before a single read, answer one question: **whose data is this?** For a storefront the answer has
two shapes, and both are principals:

- a **guest** — nobody has signed in, but the cart has to live somewhere
- a **customer** — signed in, with orders and addresses

```ts
import { createTenancy } from '@braidlabs/data';

const tenancy = createTenancy({
  driver,
  // The same list from step 2. A purge clears every one of them, and a purge that quietly misses a
  // collection looks exactly like one that worked.
  collections: COLLECTIONS,
});

// A guest is a principal like any other. The id is per device, not per person.
await tenancy.signIn({ userId: `guest:${deviceId}` });
```

Reads before that throw, deliberately:

```ts
tenancy.partition();
// Error: no partition is active: sign in before reading.
```

That refusal is a feature. The alternative — answering with nothing — is indistinguishable from a
customer who genuinely has no orders, including to your own error handling.

> **Why a guest gets a real partition.** You could keep guest data in memory and "upgrade" it at
> sign-in. Then a guest who reloads loses their cart, which is the single most expensive bug in
> e-commerce. Give them a partition and it survives.

---

## Step 4 — Point the client at the partition

The client does not own the partition; it *asks* for it on every access:

```ts
import { createDataClient, createOutbox } from '@braidlabs/data';

const orders = createDataClient({
  driver,
  partition: tenancy.partition, // read per access, so switching users is a pointer move
  collection: 'orders',
  outbox: createOutbox({ driver, owner: 'storefront', collection: 'outbox' }),
});

const catalogue = createDataClient({
  driver,
  partition: tenancy.partition,
  collection: 'catalogue',
});
```

Passing `tenancy.partition` — the function, uncalled — is what makes a tenant switch a pointer move
rather than a rebuild. Passing `tenancy.partition()` would capture today's partition forever, and
your customer would keep seeing the guest's cart after signing in.

Two clients because they hold different collections. They share one driver, so they share storage.

---

## Step 5 — Read the catalogue

```ts
const product = catalogue.query<Product>({
  key: 'product:p1',
  tags: ['product#p1'], // what invalidation will name later
  schema: ProductContract,
  fetch: async () => (await fetch('/api/products/p1')).json(),
  staleWhileRevalidate: false,
});

product.subscribe((state) => {
  render(state.data, { loading: state.status === 'loading' });
});
```

Open the product page a second time — from another component, another route, or another *application
on the same page* — and nothing hits the network. The cache lives in storage rather than in one
app's memory, so the second reader finds what the first one stored:

```ts
state.fromCache; // true
```

That is the whole trick behind "these two apps fetched it once between them", and you get it by
using the same `key`.

---

## Step 6 — The customer signs in

```ts
await tenancy.signIn({ userId: 'user:ana' });
```

That is it. Every query created from here reads a different partition, and the guest's partition is
still on disk, untouched.

**The question this raises, and its honest answer.** What happens to the guest's cart?

Nothing happens to it automatically, and that is the design rather than an omission. A partition is
fully self-contained — no read crosses the boundary — which is what makes purge complete and tenant
switching cheap. But *"the guest just signed in"* is a real event with a real answer, so there is a
first-class way to carry their records across:

```ts
const guest = await tenancy.signIn({ userId: `guest:${deviceId}` });
// …they shop, then sign in…
await tenancy.signIn({ userId: 'user:ana' });

const result = await tenancy.adopt(guest, {
  collections: ['cart'], // not the outbox — see below
  mode: 'move', // 'copy' (default) leaves the guest partition intact
});

result; // { copied: 1, skipped: 0, replaced: 0 }
```

Three decisions are baked into that call, and each is one you would otherwise get wrong once:

**The destination wins by default.** `onConflict` defaults to `'skip'`, so a cart the account already
had is left alone. Ana signing in on a shared laptop should not have her real basket replaced by
whatever the last guest left in it. Pass `'overwrite'` when you genuinely mean the guest's version is
newer.

**Records move as stored bytes, envelope untouched.** Reading each one through a typed store and
writing it back would re-envelope it at *this* build's version — silently down-projecting a record
written by a newer tab, or refusing it outright. Copying the bytes means a v3 record arrives as a v3
record.

**You name the collections.** A cart should follow its owner. A queued mutation usually should not:
the outbox belongs to the session that made it, and replaying a guest's queued writes as a signed-in
customer changes who performed them. Omit `collections` and every collection the tenancy manages
comes across, which is convenient and rarely what you want here.

`copyPartition({ driver, from, to, collections })` is the same operation without a tenancy, for
moving records between two partitions you name yourself.

---

## Step 7 — Place an order

```ts
const outcome = await orders.mutate<Order>({
  key: 'order:o1',
  schema: OrderContract,
  mutationId: 'order.place', // names the *kind* of write, for replay after a reload
  input: { id: 'o1', productId: 'p1', quantity: 1 },
  patch: { id: 'o1', productId: 'p1', quantity: 1, status: 'placed' }, // shown at once
  tags: ['orders'], // the order list refreshes when this lands
  send: (input) => post('/api/orders', input),
});

outcome.status; // 'confirmed'
outcome.value?.reference; // 'ORD-8821' — the server knew something you could not
```

Four things happened in that one call: the order appeared on screen immediately, it was queued
durably before anything was sent, the server's version was stored when it answered, and `orders` was
marked stale so every list showing orders refetched.

### When the server disagrees with you

The customer asks for five; two are in stock. The server accepts the order and stores a quantity of
two. **That is not an error, and it must not be silent:**

```ts
const outcome = await orders.mutate<Order>({
  // …
  patch: { quantity: 5, status: 'placed' },
  send: (input) => post('/api/orders', input), // server answers with quantity: 2
});

outcome.conflict?.paths; // ['quantity']
outcome.conflict?.actual; // what the server stored
outcome.value?.quantity; // 2 — the server's value is what is kept
```

The stored record always becomes the server's, because you cannot make a server hold your number by
insisting. The only choice is whether the customer is told, and the default is to tell them —
`onConflict: 'accept'` opts into silence per mutation, for fields you know are server-authoritative.

Show it. "You asked for 5, we could only reserve 2" is a sentence a customer can act on; silently
changing the number under them is a support call.

---

## Step 8 — The network drops mid-checkout

Change nothing. Run the same `mutate` with the network down:

```ts
const outcome = await orders.mutate<Order>({ ...sameAsBefore });

outcome.status; // 'queued' — it did not reach the server, and it is not lost
```

The order stays on screen. It is in a durable queue. When the browser says the network is back the
client sends it, and you can force the attempt yourself:

```ts
await orders.flush(); // { sent: 1, failed: 0, remaining: 0, skipped: false }
```

### The one thing you must wire yourself

A queued order outlives the page that placed it. After a reload the function that would have sent it
is gone — entries store **data**, never closures — so your bootstrap has to reintroduce the mutation
kinds:

```ts
orders.registerMutation('order.place', (input) => post('/api/orders', input), { tags: ['orders'] });
```

Forget it and the client will not guess. It keeps the entry and reports through `onFlushError` that
nothing knows how to send `order.place`, because dropping it would discard an order the customer was
told had been placed.

```ts
const result = await orders.flush();
result.remaining; // 1 — still queued, waiting for a build that knows what it is
```

### What the drain guarantees

| | |
| --- | --- |
| **Sequential, stopping at the first failure** | Orders depend on each other. Replaying in parallel, or skipping a failure, applies them out of order. |
| **One drain per origin** | Five tabs coming back online do not place the same order five times. A tab that finds the lock taken reports `skipped: true` instead of waiting. |
| **Give up loudly** | After `maxAttempts` the entry is abandoned *and reported*. The customer left believing it was placed. |
| **Only your own entries** | Another app on the origin has its own `owner`; its queue is left where it is. |

---

## Step 9 — "Your order has shipped"

The last event does not come from a request you made. It arrives:

```ts
const disconnect = orders.connect({
  schema: OrderContract,
  source: (sink, signal) => {
    const socket = new WebSocket('wss://shop.example/events');
    socket.onmessage = (event) => {
      const order = JSON.parse(event.data);
      void sink.receive({ key: `order:${order.id}`, value: order });
    };
    signal.addEventListener('abort', () => socket.close());
  },
});
```

Anyone watching that order sees `status: 'shipped'` without asking for it, and **without a refetch**
— the push already is the newest thing anyone has, so answering it with a network request would ask
the server for what it just sent.

The part that matters more than the convenience: a pushed record goes through the **same enveloping
path** as every other write. Skip that and your WebSocket update is the one record in storage with
no version stamped on it — which is precisely the record that a tab running last week's build will
read tomorrow.

---

## Step 10 — Sign out

```ts
await tenancy.signOut();
```

Every partition belonging to that customer is destroyed — orders, cached catalogue, queued writes —
across every collection you declared in step 1, under a lock so a second tab cannot resurrect one
mid-purge. Afterwards, reads are refused rather than answered emptily:

```ts
tenancy.partition(); // throws
```

A query created after sign-out reports it as an error state rather than throwing at the call site,
because it has a subscriber rather than a promise you could have caught:

```ts
orphan.subscribe((state) => {
  state.status; // 'error'
  state.error; // "no partition is active: sign in before reading"
});
```

### Two tabs, two customers

A user who acts on behalf of others — an advisor with clients, a desk with funds — opens two tabs on
two of them. Everything is keyed the same way in both: same app, same entity ids, same fetches.

What separates them is the partition, and five things follow it: **records**, **the shared cache**,
**fetch de-duplication**, **invalidation**, and **the optimistic overlay**. Two tabs reading
`holding:h1` for different clients each get their own record, each go to the network, and neither
one's staleness reaches the other.

One thing deliberately does **not** follow it: the **queue**. A write queued offline belongs to the
session, not to whichever client was on screen when it was made, so it flushes from whichever tab is
open. Only its *prediction* is tenant-scoped.

```ts
// tab one
await tenancy.signIn({ userId: 'advisor:ana', actingAs: 'client:smith' });
// tab two
await tenancy.signIn({ userId: 'advisor:ana', actingAs: 'client:jones' });
```

If a stream carries events for more than one of them — one socket, every fund the desk covers — say
which one each record belongs to, or it lands in whichever tenant that tab happens to be showing:

```ts
sink.receive({ key: 'holding:h1', value, partition: partitionKey('advisor:ana', 'fund:beta') });
```

**If a purge is interrupted** — the tab closes, storage throws — the partitions it named are marked
poisoned and refused on the next open until `recover()` finishes the job. A half-emptied partition is
never served as though it were whole.

---

## The bootstrap, in one place

Everything above, in the order an application would actually run it:

```ts
// step 1 — the contracts, declared once and exported
export const OrderContract = versioned<Order>('shop.order');

// step 2 — where bytes live, and every collection declared up front
const driver = indexedDbRecordDriver({ database: 'storefront', collections: COLLECTIONS });

async function bootstrap(principal: Principal) {
  const tenancy = createTenancy({ driver, collections: COLLECTIONS });

  // Finish any purge a previous session was interrupted mid-way through.
  await tenancy.recover();
  await tenancy.signIn(principal);

  const orders = createDataClient({
    driver,
    partition: tenancy.partition,
    collection: 'orders',
    outbox: createOutbox({ driver, owner: 'storefront', collection: 'outbox' }),
    onFlushError: (message, detail) => telemetry.error(message, detail),
  });

  // Before anything can flush: the queue may already hold orders from a previous session.
  orders.registerMutation('order.place', (input) => post('/api/orders', input), { tags: ['orders'] });
  await orders.flush();

  return { tenancy, orders };
}
```

Read that top to bottom and the dependencies are visible: recover before signing in, sign in before
constructing clients, register before flushing.

---

## Sharing one partition across several micro-frontends

Everything above assumed one application. Now suppose the storefront is composed with
[Braid](../braid-explained.md): checkout is one deployment, the account panel is another, the
recommendations rail is a third. All three want the same customer's data, and none of them imports
the others.

The good news is that most of it already works, for one reason: **Braid composes fragments onto a
single origin.** One origin means one IndexedDB, one `navigator.locks` manager, one
`BroadcastChannel` namespace. The cache is shared because of *where it lives*, not because anybody
coordinated.

The bad news is one specific thing that does not work by default, and it fails silently. It is the
fourth point below.

### 1. The host publishes who is signed in; each fragment derives its own partition

A fragment cannot ask another fragment anything — that is the point of the isolation. It does not
have to. The partition is a pure function of the identity:

```ts
// in the host, once
braidContext.register('session', SessionContract); // versioned, so an older fragment still reads it
braidContext.set('session', { userId: 'user:ana', actingAs: 'acme' });
```

```ts
// in every fragment, independently
env.context.subscribe(
  'session',
  async (session) => {
    await tenancy.signIn({ userId: session.userId, actingAs: session.actingAs });
  },
  // the host set the session before this fragment mounted; replay hands it over now
  { replay: true },
);
```

`replay: true` matters here. Without it, `subscribe` fires only on the *next* change, and a fragment
that mounts after sign-in, such as a lazy route or a slot rendered later, would never sign in.

Same identity in, same partition out, in every realm, with no shared state and no handshake. Publish
it on the **versioned** context bus rather than a bare event, because a fragment deployed months ago
will be reading today's session object — that is the whole reason the bus projects per subscriber.

### 2. Shared data goes in a shared collection, under the same key

```ts
const customer = createDataClient({
  driver, // same database name in each fragment
  partition: tenancy.partition,
  collection: 'shared', // same collection
});

customer.query<Customer>({ key: 'customer:c1' /* same key */, schema: MyContract, fetch });
```

Three things must match for two fragments to share a record: the database, the collection, and the
key. The **schema does not** — each fragment reads through its own contract version, which is the
per-reader projection the whole library is built on. Checkout at v3 and the rail at v1 read the same
stored bytes and each get a shape they understand.

Keep private data in a collection of the fragment's own (`'checkout'`, `'account'`). Sharing is a
decision per collection, not per origin.

### 3. Every fragment gets its own outbox owner

```ts
outbox: createOutbox({ driver, owner: 'checkout', collection: 'outbox' });
```

The queue is one store; ownership is what keeps it safe. Each fragment replays only its own entries,
so checkout cannot send — or drop — an entry the account panel queued, and the flush lock is per
owner so the two do not wait on each other. Both can still *count* the page's unsent work honestly,
which is what an "unsaved changes" indicator should report.

Give two fragments the same owner and they will replay each other's writes. That is the collision
`owner` exists to prevent, and it is why the field is not defaulted.

### 4. Turn on cross-context invalidation — realms need it, not just tabs

This is the one that surprises people, so it is worth being blunt:

> **A Braid realm is a separate JavaScript context.** Two fragments on the same page are as isolated
> from each other, in memory, as two browser tabs are.

Invalidation reaches other contexts over `BroadcastChannel`, and that channel is off by default. So
with the default settings, checkout can pay an invoice, invalidate `invoice#42`, and the account
panel two hundred pixels away will never hear about it:

```ts
const client = createDataClient({
  driver,
  partition: tenancy.partition,
  crossContextInvalidation: true, // a realm is a context, and so is a tab
});
```

The flag is named for *contexts* rather than tabs precisely because of this: the two cases are one
mechanism, and only the tab one is obvious. Leave it off on a composed page and staleness is
invisible — the fragment that never heard looks exactly like one that is working, which is the worst
property a bug can have.

Both behaviours are pinned down in
[`composition.spec.ts`](https://github.com/braidjs/braid/blob/main/libs/data/src/lib/composition.spec.ts): without the channel the second
fragment never refetches, with it it does.

### 5. Sign-out has to reach every fragment

Purge clears the collections **the tenancy that runs it was told about**, and no fragment can know
another's collections. So sign-out is a broadcast, and each fragment purges its own:

```ts
// host
braidContext.set('session', null);
```

```ts
// each fragment
if (session === null) await tenancy.signOut();
```

A fragment that misses the signal keeps serving its own cached slice of a signed-out customer. If you
build one thing carefully on this page, build this one — and there is a safety net worth calling:
`tenancy.recover()` notices that the partition it was reading has been destroyed and ends its own
session, so a fragment that mounts late, or wakes from a background tab, does not resume a session
that ended.

### 6. Eventing between fragments

Tag invalidation says "this went stale". When fragments need to tell each other *things*, there is a
bus in the same package:

```ts
const bus = createEventBus({ consumer: 'checkout', partition: tenancy.partition, driver });
const orders = bus.channel('orders', { scope: 'origin' });

await orders.emit('order.placed', order, { delivery: 'at-least-once' });
```

Three points that matter on a composed page. **`scope: 'origin'`** reaches other realms *and* other
tabs, for the same reason `crossContextInvalidation` has to be on. **`at-least-once`** means a
fragment that had not mounted yet still gets the event when it arrives — it is queued in the same
outbox your mutations use. And **`entity`** gives one channel name a separate context per thing:

```ts
bus.channel('selection', { entity: `customer:${id}` });
```

Same shape, separate state, separate queue — which is what you want the moment the page shows more
than one of something.

### 7. What happens when two fragments race

Sharing a partition means two independently deployed apps write to one place. It is worth being
precise about what that does and does not protect you from, because the answer is different for
reads and writes.

**Two fragments reading the same key: serialized, and you get one fetch.**

The fetch runs inside a per-key lock, and the lock is re-checked from the other side:

```ts
withLock(`skew:data:fetch:${partition}:${key}`, async () => {
  if (await readView()) return; // someone else fetched it while we waited
  // …only now go to the network
}, { ifAvailable: false }); // wait for our turn rather than declining
```

Two details make that work between fragments specifically. `ifAvailable: false` means the second
fragment **waits** instead of giving up and fetching anyway. And `navigator.locks` is scoped to the
**origin**, so the lock spans realms and tabs — which is precisely why the code uses it instead of a
module-level map, since a map lives in one JavaScript context and a realm is another one.

*Where it degrades:* on a runtime with no `navigator.locks`, the lock falls back to an in-process one
that cannot see other realms, and both fragments fetch. They then store the same server response, so
this costs a duplicate request rather than correctness. `hasCrossContextLocks()` tells you which mode
you are in.

**Two fragments writing the same key: not serialized. The last write wins, wholesale.**

There is no compare-and-set in the store — no expected version, no etag, no field-level merge. What
you do get:

- **No torn records.** Every operation is a single-record transaction, so a reader sees one writer's
  whole record, never halves of two.
- **No lost updates through read-modify-write**, because nothing reads before writing. This is why
  the outbox stores one record per entry: appending is a `put`, so two fragments queueing at the same
  moment cannot overwrite each other's queue.
- **The server is the arbiter, not the store.** Writes go through `mutate`, which stores the server's
  *response* rather than your optimistic patch. Neither fragment invents an ordering; each keeps what
  the server handed back to it.

The residual race is real, and naming it is more useful than implying it away: if checkout confirms
at T1 and the account panel confirms at T2 from a stale read, T2's value lands on top of T1's. Both
are values the server blessed; the store simply holds the most recent arrival.

**If that ordering matters, the server has to enforce it.** Reject the stale write with a version
check, and the fragment that lost finds out properly — `mutate` surfaces it as
`{ expected, actual, paths }` instead of silently winning. A client-side store cannot decide which of
two server-accepted writes should have come first, and one that pretended to would be guessing with
someone's order.

**One subtlety, for completeness.** Sequence numbers are allocated per store instance, so two
contexts can hand out the same one. For entity records that is harmless — nothing derives meaning
from consecutive numbers. For the outbox it means the relative order of entries queued by two *tabs
of the same fragment* is ambiguous. The flush lock still guarantees only one drains at a time, so
this is ordering ambiguity rather than double-sending, and it does not arise between two fragments,
which have different owners by construction.

Both behaviours are pinned down in
[`composition.spec.ts`](https://github.com/braidjs/braid/blob/main/libs/data/src/lib/composition.spec.ts) — the later write winning
whole, and concurrent queue appends keeping every entry.

### The setup, in one table

| Piece | Same across fragments? | Why |
| --- | --- | --- |
| Origin | yes, always | Braid composes onto one — this is what makes any of it possible |
| Database name | yes, for shared data | different databases share nothing |
| Collection | yes, for shared data | private data belongs in the fragment's own |
| Key | yes, for shared records | this is what "the same record" means |
| Partition | yes, derived | same identity in, same partition out |
| Schema version | **no** | each reader projects to its own — that is the point |
| Outbox `owner` | **no** | ownership is what stops one fragment replaying another's writes |
| `crossContextInvalidation` | on, everywhere | a realm is a separate context, exactly as a tab is |

One line to keep from the section above: **reads are serialized between fragments, writes are not.**
Concurrent writes to one record end in last-write-wins, and the server is the only thing that can
decide otherwise.

---

## What to remember

1. **Declare contracts before you store anything.** Retrofitting an envelope onto records already on
   ten thousand devices is not a refactor you want.
2. **Every collection is declared up front**, at the driver and at the tenancy. IndexedDB cannot
   create an object store you forgot, and a purge cannot clear one it was never told about.
3. **Tenancy is the first real decision.** The partition decides where everything lands, so deciding
   it late means deciding it wrong.
4. **Pass `tenancy.partition`, not `tenancy.partition()`.** The function, uncalled — that is what
   makes a tenant switch a pointer move.
5. **A guest is a principal.** Give them a partition and their cart survives a reload.
6. **Nothing crosses a partition boundary on its own.** `tenancy.adopt(guestPartition)` is the
   deliberate way to bring a guest cart along, and it keeps the account's own records by default.
7. **Register your mutation kinds at bootstrap**, or a queue rehydrated from storage has nowhere to
   go.
8. **A server that changes your write is not an error** — but it is something to tell the customer.
9. **Sign-out destroys data**, and an interrupted purge refuses to serve rather than guessing it
   finished.
10. **Composing with Braid? Turn on `crossContextInvalidation`.** A realm is a separate JavaScript
    context, so without it one fragment's invalidation never reaches another — and staleness is
    invisible.
11. **Reads are serialized between fragments; writes are not.** Two fragments asking for the same
    record produce one fetch. Two fragments *writing* it end in last-write-wins — if the order
    matters, the server has to reject the stale one.

## Where to go next

- [Tutorial 4](04-data-storage.md) — the same library feature by feature, when you want the detail
  behind a step here
- [Tutorial 6](06-angular-data.md) — the same ideas in Angular, with a normalized graph on top
- [Braid, explained](../braid-explained.md) — what a realm, a fragment, and a slot actually are, if
  the composition section was your first encounter with them
- [The storefront demo plan](https://github.com/braidjs/braid/blob/main/docs/plans/braid-storefront-demo-plan.md) — this tutorial as a running
  site, split across three deployed fragments. Proposed, not built
- [`@braidlabs/data` sources](https://github.com/braidjs/braid/tree/main/libs/data/src) — every decision above is commented where it is made
