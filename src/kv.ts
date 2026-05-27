import type { FeedEvent, FeedIndex, IndexEntry } from './schema';

const INDEX_KEY = 'feed:index';
const EVENT_PREFIX = 'feed:evt:';
const MAX_RING = 1000;

export async function writeEvent(
  kv: KVNamespace,
  event: FeedEvent,
  ttlSeconds: number,
): Promise<void> {
  await kv.put(`${EVENT_PREFIX}${event.event_id}`, JSON.stringify(event), {
    expirationTtl: ttlSeconds,
  });

  const raw = await kv.get(INDEX_KEY);
  const index: FeedIndex = raw ? JSON.parse(raw) : { entries: [], total_published: 0 };

  const entry: IndexEntry = {
    id: event.event_id,
    ts_ms: event.ts_ms,
    category: event.category,
    action: event.action,
    trust_level: event.trust_level,
  };

  index.entries.push(entry);
  index.total_published += 1;

  if (index.entries.length > MAX_RING) {
    index.entries = index.entries.slice(index.entries.length - MAX_RING);
  }

  await kv.put(INDEX_KEY, JSON.stringify(index));
}

export async function readEvents(
  kv: KVNamespace,
  opts: { since_ms?: number; categories?: string[]; trust_levels?: string[]; limit?: number },
): Promise<{ events: FeedEvent[]; cursor_ms: number; has_more: boolean }> {
  const raw = await kv.get(INDEX_KEY);
  if (!raw) return { events: [], cursor_ms: Date.now(), has_more: false };

  const index: FeedIndex = JSON.parse(raw);
  const limit = Math.min(opts.limit ?? 100, 200);

  let entries = index.entries;

  if (opts.since_ms !== undefined) {
    entries = entries.filter((e) => e.ts_ms > opts.since_ms!);
  }

  if (opts.categories?.length) {
    entries = entries.filter((e) => opts.categories!.includes(e.category));
  }

  if (opts.trust_levels?.length) {
    entries = entries.filter((e) => opts.trust_levels!.includes(e.trust_level ?? 'self_reported'));
  }

  const has_more = entries.length > limit;
  entries = entries.slice(0, limit);

  const events = (
    await Promise.all(
      entries.map(async (e) => {
        const raw = await kv.get(`${EVENT_PREFIX}${e.id}`);
        return raw ? (JSON.parse(raw) as FeedEvent) : null;
      }),
    )
  ).filter(Boolean) as FeedEvent[];

  const cursor_ms = events.length > 0 ? events[events.length - 1].ts_ms : Date.now();

  return { events, cursor_ms, has_more };
}

export async function getStats(
  kv: KVNamespace,
): Promise<{ total_published: number; ring_size: number; oldest_ms: number | null }> {
  const raw = await kv.get(INDEX_KEY);
  if (!raw) return { total_published: 0, ring_size: 0, oldest_ms: null };
  const index: FeedIndex = JSON.parse(raw);
  return {
    total_published: index.total_published,
    ring_size: index.entries.length,
    oldest_ms: index.entries[0]?.ts_ms ?? null,
  };
}
