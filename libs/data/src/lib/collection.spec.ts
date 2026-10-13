import { afterEach, describe, expect, it, vi } from 'vitest';
import { versioned } from '@braidlabs/skew';
import { memoryRecordDriver } from './memory-driver.js';
import { createRecordStore, type RecordDriver } from './record-store.js';
import { resetSharedInvalidators } from './invalidation.js';
import { createOutbox } from './outbox.js';
import type { PushSink } from './adapters.js';
import { createDataClient, type CollectionQuery, type CollectionState, type RecordChange } from './query.js';

/**
 * Whole-collection reads: the change feed (`watch`) and the live view built on it (`collection`).
 *
 * The cases that matter are the ones where the write comes from somewhere other than the reader —
 * a key query's fetch, a push, a second application — because a view that only noticed its own
 * writes would look right in every single-app demo.
 */

interface Note {
  id: string;
  title: string;
}

const NoteSchema = versioned<Note>('collection-spec-note');

/** Resolves on the first state matching `predicate`, so no test sleeps on a guess. */
function until<T>(query: CollectionQuery<T>, predicate: (s: CollectionState<T>) => boolean): Promise<CollectionState<T>> {
  return new Promise((resolve) => {
    const stop = query.subscribe((state) => {
      if (!predicate(state)) return;
      queueMicrotask(() => stop());
      resolve(state);
    });
  });
}

const titles = (state: CollectionState<Note>) => state.data?.map((record) => record.value.title);
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => resetSharedInvalidators());

const setup = (driver: RecordDriver = memoryRecordDriver(), partition = () => 'tenant-a') => {
  const outbox = createOutbox({ driver, owner: 'notes-app' });
  const client = createDataClient({ driver, partition, outbox, autoFlush: false });
  return { driver, client };
};

const seed = (driver: RecordDriver, partition: string, id: string, title = id) =>
  createRecordStore<Note>({ driver, collection: 'entities', schema: NoteSchema }).put({
    id,
    partition,
    value: { id, title },
  });

describe('collection query', () => {
  it('lists every readable record in the current partition, in seq order, without fetching', async () => {
    const driver = memoryRecordDriver();
    await seed(driver, 'tenant-a', 'n2', 'second');
    await seed(driver, 'tenant-a', 'n1', 'first');
    await seed(driver, 'tenant-b', 'n3', 'someone else');
    const ahead = versioned<Note>('collection-spec-note').next<Note & { tag: string }>('add tag', {
      up: (v1) => ({ ...v1, tag: '' }),
    });
    await createRecordStore({ driver, collection: 'entities', schema: ahead }).put({
      id: 'n4',
      partition: 'tenant-a',
      value: { id: 'n4', title: 'from the future', tag: 'x' },
    });
    const onFetch = vi.fn();
    const client = createDataClient({ driver, partition: () => 'tenant-a', onFetch });

    const state = await until(client.collection({ schema: NoteSchema }), (s) => s.status === 'ready');

    expect(titles(state)).toEqual(['second', 'first']);
    expect(state.data?.every((record) => record.partition === 'tenant-a')).toBe(true);
    expect(onFetch).not.toHaveBeenCalled();
    client.close();
  });

  it('re-reads after a key query fetches into the collection', async () => {
    const { client } = setup();
    const notes = client.collection({ schema: NoteSchema });
    await until(notes, (s) => s.status === 'ready');

    const query = client.query({ key: 'n1', schema: NoteSchema, fetch: async () => ({ id: 'n1', title: 'fetched' }) });

    expect(titles(await until(notes, (s) => s.data?.length === 1))).toEqual(['fetched']);
    query.dispose();
    client.close();
  });

  it('re-reads after a confirmed mutation', async () => {
    const { client } = setup();
    const notes = client.collection({ schema: NoteSchema });
    await until(notes, (s) => s.status === 'ready');

    await client.mutate<Note>({
      key: 'n1',
      schema: NoteSchema,
      mutationId: 'note.create',
      input: {},
      patch: { title: 'created' },
      send: async () => ({ id: 'n1', title: 'created' }),
    });

    expect(titles(await until(notes, (s) => s.data?.length === 1))).toEqual(['created']);
    client.close();
  });

  it('re-reads after a pushed record', async () => {
    const { client } = setup();
    const notes = client.collection({ schema: NoteSchema });
    await until(notes, (s) => s.status === 'ready');
    let sink!: PushSink;

    client.connect({ schema: NoteSchema, source: (s) => void (sink = s) });
    await sink.receive({ key: 'n1', value: { id: 'n1', title: 'pushed' } });

    expect(titles(await until(notes, (s) => s.data?.length === 1))).toEqual(['pushed']);
    client.close();
  });

  it('empties after the partition is cleared', async () => {
    const { driver, client } = setup();
    await seed(driver, 'tenant-a', 'n1');
    const notes = client.collection({ schema: NoteSchema });
    await until(notes, (s) => s.data?.length === 1);

    await client.clearPartition();

    expect(await until(notes, (s) => s.data?.length === 0)).toMatchObject({ status: 'ready' });
    client.close();
  });

  it('re-reads after a second client on the same driver and partition writes', async () => {
    const driver = memoryRecordDriver();
    const reader = setup(driver).client;
    const writer = setup(driver).client;
    const notes = reader.collection({ schema: NoteSchema });
    await until(notes, (s) => s.status === 'ready');

    writer.query({ key: 'n1', schema: NoteSchema, fetch: async () => ({ id: 'n1', title: 'from the other app' }) });

    expect(titles(await until(notes, (s) => s.data?.length === 1))).toEqual(['from the other app']);
    reader.close();
    writer.close();
  });

  it('stops emitting once disposed', async () => {
    const { client } = setup();
    const notes = client.collection({ schema: NoteSchema });
    await until(notes, (s) => s.status === 'ready');
    const listener = vi.fn();
    notes.subscribe(listener);
    listener.mockClear();

    notes.dispose();
    client.connect({ schema: NoteSchema, source: (sink) => void sink.receive({ key: 'n1', value: { id: 'n1', title: 'x' } }) });
    await flush();

    expect(listener).not.toHaveBeenCalled();
    client.close();
  });

  it('reports a partition that cannot be read as an error state', async () => {
    let signedIn = true;
    // Signed in at construction, which reads the partition once; signed out by the time we look.
    const { client } = setup(memoryRecordDriver(), () => {
      if (signedIn) return 'tenant-a';
      throw new Error('signed out');
    });
    signedIn = false;

    const state = await until(client.collection({ schema: NoteSchema }), (s) => s.status === 'error');

    expect((state.error as Error).message).toBe('signed out');
    client.close();
  });
});

describe('watch', () => {
  it('reports puts from a fetch, a mutation and a push, and a clear, with the caller key', async () => {
    const { client } = setup();
    const changes: RecordChange[] = [];
    client.watch((change) => changes.push(change));
    let sink!: PushSink;
    client.connect({ schema: NoteSchema, source: (s) => void (sink = s) });

    const query = client.query({ key: 'fetched', schema: NoteSchema, fetch: async () => ({ id: 'fetched', title: 'f' }) });
    await vi.waitFor(() => expect(changes).toHaveLength(1));
    await client.mutate<Note>({
      key: 'mutated',
      schema: NoteSchema,
      mutationId: 'note.create',
      input: {},
      patch: { title: 'm' },
      send: async () => ({ id: 'mutated', title: 'm' }),
    });
    await sink.receive({ key: 'pushed', value: { id: 'pushed', title: 'p' }, partition: 'tenant-b' });
    await client.clearPartition();

    expect(changes).toEqual([
      { type: 'put', collection: 'entities', partition: 'tenant-a', key: 'fetched' },
      { type: 'put', collection: 'entities', partition: 'tenant-a', key: 'mutated' },
      { type: 'put', collection: 'entities', partition: 'tenant-b', key: 'pushed' },
      { type: 'clear', collection: 'entities', partition: 'tenant-a' },
    ]);
    query.dispose();
    client.close();
  });

  it('stops delivering after the disposer runs, and after close', async () => {
    const { client } = setup();
    const disposed = vi.fn();
    const closed = vi.fn();
    client.watch(disposed)();
    client.watch(closed);
    client.close();

    await client.clearPartition();

    expect(disposed).not.toHaveBeenCalled();
    expect(closed).not.toHaveBeenCalled();
  });

  it('does not hear about another collection', async () => {
    const driver = memoryRecordDriver();
    const notes = createDataClient({ driver, partition: () => 'tenant-a', collection: 'notes' });
    const other = createDataClient({ driver, partition: () => 'tenant-a', collection: 'other' });
    const heard = vi.fn();
    notes.watch(heard);

    await other.clearPartition();

    expect(heard).not.toHaveBeenCalled();
    notes.close();
    other.close();
  });
});
