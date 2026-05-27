// HMAC-SHA256 event signing using crypto.subtle (CF Workers native)
// Agents verify integrity via GET /v1/feed/verify/{event_id} — no key needed client-side.

import type { FeedEvent } from './schema';

function canonical(event: FeedEvent): string {
  // Deterministic canonical string — all fields that represent the event's identity and content
  return [
    event.event_id,
    event.timestamp,
    event.version,
    event.category,
    event.action,
    event.source,
    event.trust_level,
    JSON.stringify(event.payload, Object.keys(event.payload).sort()),
  ].join('\x00');
}

async function importKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

export async function signEvent(event: FeedEvent, signKey: string): Promise<string> {
  const key = await importKey(signKey);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(canonical(event)));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

export async function verifyEvent(event: FeedEvent, signature: string, signKey: string): Promise<boolean> {
  try {
    const key = await importKey(signKey);
    const sigBytes = Uint8Array.from(atob(signature), (c) => c.charCodeAt(0));
    return crypto.subtle.verify('HMAC', key, sigBytes, new TextEncoder().encode(canonical(event)));
  } catch {
    return false;
  }
}
