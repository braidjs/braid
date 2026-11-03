# Tutorial 4 — Client storage that survives a reload

> **This is the feature-by-feature tour.** If you would rather build one working thing in the
> order you would actually build it — tenancy, then reads, then orders, then offline, then sign-out —
> read [Tutorial 7: Build a storefront](07-storefront.md) and come back here for the detail.

**Package:** `@braidlabs/data` · **Time:** ~40 minutes ·
**Prerequisites:** Tutorial 2 (contracts and `versioned()`). You will need a browser; the store is
a browser API. No Braid, no micro-frontends, and no Angular are required — the last step shows the
Angular binding, but everything before it is plain TypeScript.

> **Tutorial 6 or this one?** [Tutorial 6](06-angular-data.md) builds a normalized graph in an
> Angular app. This one is the storage engine underneath it — the same records, queue, and
> versioning, without a framework. Read this one if you are not on Angular, or if tutorial 4 worked
> and you now want to know what it was doing.

You are going to build a small offline-capable feature: it reads data, shows it instantly on a
second visit, and keeps a user's edit safe when the network is not there.

```sh
npm install @braidlabs/skew @braidlabs/data
```

---

## The idea in one paragraph

Most client caches live in memory: the app starts empty, fetches, and forgets everything on reload.
This one lives in **IndexedDB**, so it starts warm — and because IndexedDB belongs to the *origin*
rather than to your app, a second application on the same page reads what yours already fetched.
Everything stored carries a **version envelope**, which is what lets an app that has not been
redeployed yet still read a record written by one that has.

Three pieces, and you only need the ones you use:

| Piece | What it is |
| --- | --- |
| **Record store** | put/get/list of versioned records, partitioned by tenant |
| **Query client** | reactive reads with a shared cache and tag invalidation |
| **Outbox** | a durable queue of writes that have not reached the server yet |

---

## Step 1 — Describe your data with a version

Never store a bare object. Give it a contract, even a one-line one:

```ts
// src/contracts/note.ts
import { versioned } from '@braidlabs/skew';

export interface Note {
  id: string;
  title: string;
}

export const NoteContract = versioned<Note>('note');
```

`versioned<Note>('note')` says: *this shape is version 1 of a contract named `note`*. That name and
number get written next to every record.

**Why bother on day one?** Because a record you store today is read by the app you deploy in March.
Adding the envelope later means every record already on disk has no version, and you will have to
guess. It costs one line now and cannot be retrofitted cheaply.

---

## Step 2 — Open a store

```ts
// src/data.ts
import { indexedDbRecordDriver, createRecordStore } from '@braidlabs/data';
import { NoteContract } from './contracts/note';

const driver = indexedDbRecordDriver({
  database: 'my-app',
  collections: ['notes'],   // every collection, declared up front
});

export const notes = createRecordStore({
  driver,
  collection: 'notes',
  schema: NoteContract,
});
```

> **Declare every collection.** IndexedDB can only create storage areas during a version upgrade, so
> a collection you use but did not list fails on first read. The error tells you exactly which one
> and where to add it, but it is easier to just list them.

---

## Step 3 — Write and read

```ts
await notes.put({ id: 'n1', partition: 'default', value: { id: 'n1', title: 'Buy milk' } });

const note = await notes.get('n1', 'default');
console.log(note?.value.title); // 'Buy milk'
```

Two things to notice in that signature.

**`partition` is not optional.** It is the tenant boundary: records in one partition are invisible
to another, so `get('n1', 'tenant-a')` cannot see tenant B's `n1`. Use `'default'` if you have one
tenant. Use something like `hash(userId, accountId)` when you have more.

**`get` returns a wrapper, not your object.** `note.value` is your data; the rest is *provenance* —
covered in step 6, and the reason this store exists.

---

## Step 4 — Reactive reads with a shared cache

Most of the time you want a query rather than a raw store:

```ts
import { createDataClient } from '@braidlabs/data';

export const data = createDataClient({
  driver,
  partition: () => 'default',
  collection: 'notes',
});

const note = data.query({
  key: 'note:n1',
  tags: ['note#n1', 'notes'],
  schema: NoteContract,
  fetch: async (signal) => (await fetch('/api/notes/n1', { signal })).json(),
});

const stop = note.subscribe((state) => {
  if (state.status === 'ready') render(state.data);
});
```

What you get:

- **A warm start.** On the second visit the cached value renders before the network is touched, and
  a refresh happens behind it.
- **One fetch across apps.** Another app on the page asking for `note:n1` reads what you stored
  rather than fetching again — even if both ask at the same moment, because the fetch is taken under
  a lock that works across tabs and frames.
- **`tags`** — see the next step.

Call `stop()` when your component goes away, and `note.dispose()` when you are done with the query.

---

## Step 5 — Write through the client

Writes go through the same client the reads do:

```ts
await data.mutate({
  key: 'note:n1',
  schema: NoteContract,
  mutationId: 'note.rename', // names the *kind* of write, so a queued one can be replayed
  input: { id: 'n1', title: 'Buy oat milk' },
  patch: { title: 'Buy oat milk' }, // shown immediately, before the server answers
  tags: ['note#n1'], // marked stale once it lands
  send: (input) => fetch('/api/notes/n1', { method: 'POST', body: JSON.stringify(input) }).then((r) => r.json()),
});
```

That one call does four things you would otherwise wire up by hand: it shows the change immediately,
queues it durably so a failed send is not lost, stores what the server actually returned, and marks
`note#n1` stale.

Every query that declared `note#n1` refetches — **including queries in other applications on the
page**. You do not need a reference to them, and they do not need one to you. The tag is the whole
channel.

### Invalidating by hand

`mutate` invalidates for you. Reach for `invalidate` directly when the change did **not** come
through this client — a WebSocket message, a write another app made, a server-sent signal:

```ts
data.invalidate('note#n1');
```

Tags are just strings you choose. A useful convention:

| Tag | Meaning |
| --- | --- |
| `note#n1` | this one record |
| `notes` | any list of notes |
| `note#*` | wildcard: every `note#…` subscriber |

Invalidate the narrowest tag that is true. `invalidate('notes')` after editing one note refetches
every list on the page, which is correct but wasteful.

---

## Step 6 — Read the provenance

This is the part no other client cache gives you, and the reason for the envelope in step 1.

```ts
note.subscribe((state) => {
  if (state.status !== 'ready') return;

  render(state.data);

  if (state.derivedPaths.length > 0) {
    // these fields were filled in by a migration — the server never sent them
    markAsEstimated(state.derivedPaths);
  }
  if (state.downgradedFrom) {
    // this record was written by a newer app than yours; you are seeing a reduced copy
    showBanner(`Some fields are not shown: ${state.lossyPaths.join(', ')}`);
  }
});
```

What each field means:

| Field | Meaning |
| --- | --- |
| `migratedFrom` | the record was older than your app, and was upgraded on the way out |
| `derivedPaths` | fields a migration **guessed** rather than the server reporting them |
| `downgradedFrom` | the record was **newer** than your app, and was reduced to fit |
| `lossyPaths` | fields the reduction had to drop |

**Why you should care.** If your app is a version behind and displays a field a migration invented,
you are showing the user a guess as though it were a fact. `derivedPaths` is how you tell the
difference. In a form that submits back to a server, this is the difference between a correct save
and quietly overwriting good data with a default.

---

## Step 7 — Keep a write that cannot be sent

Pass an outbox to the client and durability stops being something you assemble:

```ts
import { createDataClient, createOutbox } from '@braidlabs/data';

const data = createDataClient({
  driver,
  partition: () => 'demo',
  outbox: createOutbox({ driver, owner: 'notes-app' }), // who this queue belongs to
});
```

That is the whole wiring. From here, the `mutate` from step 5 behaves differently when the network
is not there: the write is queued before it is sent, the change stays on screen, and the client
replays it when the browser says the network is back — or when you call `data.flush()` yourself.

```ts
const outcome = await data.mutate({ ...rename });
outcome.status; // 'confirmed' — it landed
//             | 'queued'    — it did not, and it is waiting
```

### The one thing you must do yourself

A queued write outlives the page that made it, and after a reload the function that would send it is
gone. Entries store **data**, never closures, so the app has to re-introduce its mutation kinds at
start-up:

```ts
// at bootstrap, before anything can flush
data.registerMutation('note.rename', (input) => sendRename(input), { tags: ['note#n1'] });
```

Skip that and the client will not guess. It leaves the entry queued and reports through
`onFlushError` that it has no runner for it — because dropping the entry would discard a write the
user was already told had saved.

### Rules the drain follows

**Strictly sequential, stopping at the first failure.** Queued writes routinely depend on each other
— create a thing, then rename the thing — and replaying them in parallel, or skipping past a failed
one, applies them out of order.

**One drain at a time across the whole origin.** The flush runs under a Web Lock keyed to the queue's
owner, so five open tabs coming back online do not replay the same write five times. A tab that finds
the lock taken reports `skipped: true` rather than waiting, because waiting would drain a queue the
other tab has already emptied.

**Permanently failing entries are dropped loudly.** After `maxAttempts` the entry is abandoned and
reported through `onFlushError` — never silently, because the user has long since navigated away
believing it saved.

**`owner` matters.** Storage belongs to the origin, so several apps share it. Each replays only its
own entries; another app's queued work is left exactly where it is, waiting for the app that knows
how to send it.

---

## Step 8 — Turn on persistence, and see what it buys

Everything so far works in memory. One change makes it durable — and it is worth seeing the
difference rather than taking it on faith.

Queue the same change into two outboxes that differ in exactly one way:

```ts
import { memoryRecordDriver } from '@braidlabs/data';

const durable = createOutbox({ driver, owner: 'demo' });                       // IndexedDB
const volatile = createOutbox({ driver: memoryRecordDriver(), owner: 'demo' }); // memory

await durable.enqueue({ mutationId: 'note.rename', input: { id: 'n1' } });
await volatile.enqueue({ mutationId: 'note.rename', input: { id: 'n1' } });

console.log((await durable.mine()).length);   // 1
console.log((await volatile.mine()).length);  // 1
```

Now reload the page and check again:

```
durable   → 1
volatile  → 0
```

That zero is a user's edit, gone, after your UI told them it saved. That is what
`persistOutbox: true` buys, and you can watch it happen in panel 9 of the
[demo](../braid-poc.md) (`npm run demo:braid`, then <http://localhost:4500/demo>).

It is **off by default** because it is not free: your inputs must be serializable, and your
mutations need stable ids registered when the app starts. If every write is fire-and-forget, skip
it.

---

## Step 9 — In an Angular app

The binding wires all of the above into DI and signals. This is a sketch of the shape;
[Tutorial 6](06-angular-data.md) builds it properly, including the normalized graph:

```ts
// app.config.ts
import { provideSkewData } from '@braidlabs/angular-data';

providers: [
  provideSkewData({
    owner: 'notes-app',            // required when persisting
    persistOutbox: true,
    database: 'my-app',
    collections: ['notes'],
  }),
];
```

```ts
import { OutboxService } from '@braidlabs/angular-data';

export class NotesPage {
  private readonly outbox = inject(OutboxService);

  // this app's queued work
  readonly mine = this.outbox.entries;
  // unsent work across the whole page, including other apps
  readonly unsent = this.outbox.pendingCount;

  constructor() {
    // register at construction: a queued entry replayed after a reload needs its runner to
    // already exist, because there is no closure left to call
    this.outbox.register('note.rename', async (input) => send(input));
  }
}
```

`owner` is **required** when persisting and deliberately has no default. Every app defaulting to
the same name is exactly the collision ownership prevents, and it would fail silently, in
production, on someone's unsent work.

---

## Step 10 — Sign in, switch tenant, sign out

Partitions are the boundary; `createTenancy` is what moves between them and what destroys one.

```ts
import { createTenancy } from '@braidlabs/data';

const tenancy = createTenancy({
  driver,
  collections: ['entities', 'outbox'],   // everything a purge has to clear
});

await tenancy.signIn({ userId: 'u-1', actingAs: 'household-a' });
const client = createDataClient({
  driver,
  partition: tenancy.partition,
  // The outbox takes the partition separately. Without it the queue stays in one device-wide
  // partition the purge never visits, so listing 'outbox' above would clear nothing.
  outbox: createOutbox({ driver, owner: 'notes-app', partition: tenancy.partition }),
});

await tenancy.switchTenant('household-b');  // a pointer move; household-a stays warm on disk
await tenancy.signOut();                    // every partition for u-1 is destroyed
```

Three behaviours that are the whole reason this is a component rather than a `let partition`:

**Reads are refused, not emptied.** After sign-out `partition()` throws. An empty result would be
indistinguishable from a user who genuinely has no data — including to your own error handling.

**Purge survives being interrupted.** A marker record is written before the first delete and removed
after the last, so a crash halfway is discoverable. The partitions it names are **poisoned**: refused
on the next open until a `recover()` finishes the job. A half-emptied partition served as if it were
whole is the failure this exists to prevent.

**A guest who signs in can bring their records with them.** Partitions never merge on their own, but
`tenancy.adopt(guestPartition, { collections: ['cart'], mode: 'move' })` carries them across — as
stored bytes, envelope untouched, keeping the destination's own records by default.
`copyPartition({ driver, from, to, collections })` is the same operation without a tenancy.

**A sign-out anywhere ends the session everywhere.** Another tab holding a principal in memory has no
reason to doubt it; `recover()` notices the partition it was reading is gone and clears its own
session, because a signed-out user still looking at their data is the same bug as never purging.

`collections` is enumerated rather than discovered on purpose — a purge that quietly misses a
collection looks exactly like one that worked, until the next user opens the page.

---

## Step 11 — Records the server sends you

Reads pull, writes command, and some data simply arrives. All three are named shapes, and the layer
never learns any protocol:

```ts
const disconnect = client.connect({
  schema: Quote,
  source: (sink, signal) => {
    const socket = new WebSocket('wss://example.test/quotes');
    socket.onmessage = (event) =>
      void sink.receive({ key: `quote:${event.data.symbol}`, value: event.data });
    signal.addEventListener('abort', () => socket.close());
  },
});
```

**A pushed record goes through the same enveloping path as every other write.** Skipping it would
make the WebSocket update the one record in your store with no version on it — which is precisely
the record a fragment two majors behind will read.

Readers refresh **from storage**, not from the network: the push already is the newest thing anyone
has, so answering it with a fetch would ask the server for what it just sent. Pass `tags` when a
push should also refresh list queries, which cannot be rebuilt from one record.

---

## What to remember

1. **Envelope from day one.** `versioned()` costs a line and cannot be retrofitted cheaply.
2. **Partition is a boundary, not a label.** Records never cross one.
3. **Read `derivedPaths` before trusting a field.** A guess that looks like data is the failure mode
   this whole library exists to prevent.
4. **Outbox entries are data, not closures**, and you only ever send your own.
5. **Persistence is opt-in**, and step 8 is what it buys.
6. **Sign-out destroys partitions**, and an interrupted purge refuses to serve rather than guessing
   it finished.

## Where to go next

- [Tutorial 6](06-angular-data.md) — the same ideas in Angular, with a normalized graph on top
- [Tutorial 2](02-skew.md) — migrations in depth, for when your shape changes
- [The demo](../braid-poc.md) — every claim above, running, with the evidence on screen

Every snippet in this tutorial is executed by `libs/data/src/lib/tutorial.spec.ts`, so if one of
them stops working, that suite fails before you find out the hard way.
