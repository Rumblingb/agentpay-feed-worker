import { validatePublishBody, type FeedEvent, type TrustLevel, type EndpointProbe, type FeedIndex } from './schema';
import { writeEvent, readEvents, getStats, updateEvent } from './kv';
import { signEvent, verifyEvent } from './signing';
import { archiveEvent, listArchive } from './r2';
import { checkRateLimit, type RateLimiter } from './ratelimit';

export interface Env {
  FEED_KV: KVNamespace;
  FEED_R2?: R2Bucket;
  RATE_LIMITER?: RateLimiter;
  PUBLISH_KEY: string;
  ADMIN_KEY: string;
  SIGN_KEY: string;
  EVENT_TTL_SECONDS: string;
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Agent-ID',
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

function err(msg: string, status = 400): Response {
  return json({ error: msg }, status);
}

function nanoid(len = 21): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  let result = '';
  for (const b of bytes) result += chars[b % chars.length];
  return result;
}

async function runCronProber(env: Env): Promise<void> {
  const raw = await env.FEED_KV.get('feed:index');
  if (!raw) return;
  const index: FeedIndex = JSON.parse(raw);

  const toProbe = index.entries
    .filter((e) => e.category === 'tool_registration' && e.trust_level === 'agentpay_verified')
    .slice(-50);

  const ttl = parseInt(env.EVENT_TTL_SECONDS ?? '86400', 10);
  const BATCH = 10;

  for (let i = 0; i < toProbe.length; i += BATCH) {
    await Promise.allSettled(
      toProbe.slice(i, i + BATCH).map(async (entry) => {
        const evtRaw = await env.FEED_KV.get(`feed:evt:${entry.id}`);
        if (!evtRaw) return;
        const event: FeedEvent = JSON.parse(evtRaw);
        const endpoint = event.payload?.endpoint as string | undefined;
        if (!endpoint) return;

        const prevProbe = event.endpoint_probe;
        const started = Date.now();
        let probe: EndpointProbe;
        try {
          const resp = await fetch(endpoint, {
            method: 'GET',
            signal: AbortSignal.timeout(8_000),
            headers: { 'User-Agent': 'AgentPay-Feed-Probe/1.0' },
          });
          probe = {
            probed_at: new Date().toISOString(),
            endpoint_healthy: resp.status < 500,
            latency_ms: Date.now() - started,
            http_status: resp.status,
          };
        } catch (e: unknown) {
          probe = {
            probed_at: new Date().toISOString(),
            endpoint_healthy: false,
            latency_ms: Date.now() - started,
            error: e instanceof Error ? e.message : String(e),
          };
        }

        // Only write when health status or HTTP status code changed — prevents
        // ~4,800 KV puts/day from cron (96 runs × 50 entries) when endpoints
        // are stable. latency_ms and probed_at change every run so must not
        // be compared.
        const unchanged =
          prevProbe !== undefined &&
          prevProbe.endpoint_healthy === probe.endpoint_healthy &&
          prevProbe.http_status === probe.http_status;
        if (unchanged) return;

        await updateEvent(env.FEED_KV, entry.id, { endpoint_probe: probe }, ttl);
      }),
    );
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const { method, pathname } = { method: request.method, pathname: url.pathname };

    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // POST /v1/feed/publish
    if (method === 'POST' && pathname === '/v1/feed/publish') {
      const auth = request.headers.get('Authorization') ?? '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      if (!token) return err('Unauthorized — Bearer token required', 401);

      const adminKey = env.ADMIN_KEY?.trim();
      const publishKey = env.PUBLISH_KEY?.trim();
      let trust_level: TrustLevel = 'self_reported';
      if (adminKey && token === adminKey) {
        trust_level = 'agentpay_verified';
      } else if (publishKey && token === publishKey) {
        trust_level = 'community';
      } else {
        return err('Unauthorized — invalid token', 401);
      }

      // Rate limit per publisher token prefix (avoids logging full token)
      const allowed = await checkRateLimit(env.RATE_LIMITER, `publish:${token.slice(0, 16)}`);
      if (!allowed) return err('Rate limit exceeded — try again in 60s', 429);

      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return err('Invalid JSON body');
      }

      const result = validatePublishBody(body);
      if (!result.ok) return err(result.error);

      const now = Date.now();
      const event: FeedEvent = {
        ...result.data,
        trust_level,
        event_id: `evt_${nanoid()}`,
        timestamp: new Date(now).toISOString(),
        ts_ms: now,
        version: '1',
      };

      const ttl = parseInt(env.EVENT_TTL_SECONDS ?? '86400', 10);

      if (env.SIGN_KEY?.trim()) {
        event.signature = await signEvent(event, env.SIGN_KEY.trim());
      }

      await writeEvent(env.FEED_KV, event, ttl);

      if (env.FEED_R2) {
        ctx.waitUntil(archiveEvent(env.FEED_R2, event));
      }

      return json({ ok: true, event_id: event.event_id, timestamp: event.timestamp, trust_level }, 201);
    }

    // GET /v1/feed/events/{event_id}
    const singleEventMatch = pathname.match(/^\/v1\/feed\/events\/(evt_[A-Za-z0-9]+)$/);
    if (method === 'GET' && singleEventMatch) {
      const eventId = singleEventMatch[1];
      const raw = await env.FEED_KV.get(`feed:evt:${eventId}`);
      if (!raw) return err('Event not found', 404);
      return json(JSON.parse(raw));
    }

    // GET /v1/feed/events
    if (method === 'GET' && pathname === '/v1/feed/events') {
      const cache = caches.default;
      const cached = await cache.match(request);
      if (cached) return cached;

      const sinceParam = url.searchParams.get('since');
      const categoriesParam = url.searchParams.get('categories');
      const trustParam = url.searchParams.get('trust');
      const limitParam = url.searchParams.get('limit');

      const since_ms = sinceParam ? parseInt(sinceParam, 10) : undefined;
      const categories = categoriesParam
        ? categoriesParam.split(',').map((c) => c.trim()).filter(Boolean)
        : undefined;
      const trust_levels = trustParam
        ? trustParam.split(',').map((t) => t.trim()).filter(Boolean)
        : undefined;
      const limit = limitParam ? Math.min(parseInt(limitParam, 10), 200) : 100;

      if (sinceParam && isNaN(since_ms!)) return err('since must be a unix timestamp in milliseconds');

      const { events, cursor_ms, has_more } = await readEvents(env.FEED_KV, {
        since_ms,
        categories,
        trust_levels,
        limit,
      });

      const body = JSON.stringify({ events, cursor: { since_ms: cursor_ms }, has_more, count: events.length }, null, 2);
      const response = new Response(body, {
        headers: {
          ...CORS_HEADERS,
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=60',
        },
      });
      ctx.waitUntil(cache.put(request, response.clone()));
      return response;
    }

    // GET /v1/feed/archive — browse R2 long-term archive
    if (method === 'GET' && pathname === '/v1/feed/archive') {
      if (!env.FEED_R2) return err('Archive not yet available — R2 not enabled', 503);
      const prefix = url.searchParams.get('prefix') ?? undefined;
      const limitParam = url.searchParams.get('limit');
      const cursor = url.searchParams.get('cursor') ?? undefined;
      const limit = limitParam ? Math.min(parseInt(limitParam, 10), 500) : 100;
      const result = await listArchive(env.FEED_R2, { prefix, limit, cursor });
      return json(result);
    }

    // POST /v1/feed/probe/{event_id}
    const probeMatch = pathname.match(/^\/v1\/feed\/probe\/(evt_[A-Za-z0-9]+)$/);
    if (method === 'POST' && probeMatch) {
      const adminKey = env.ADMIN_KEY?.trim();
      const auth = request.headers.get('Authorization') ?? '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      if (!adminKey || token !== adminKey) return err('Unauthorized', 401);

      const eventId = probeMatch[1];
      const raw = await env.FEED_KV.get(`feed:evt:${eventId}`);
      if (!raw) return err('Event not found', 404);
      const event: FeedEvent = JSON.parse(raw);

      const endpoint = event.payload?.endpoint as string | undefined;
      if (!endpoint) return err('Event has no endpoint to probe');

      const started = Date.now();
      let probe: EndpointProbe;
      try {
        const resp = await fetch(endpoint, {
          method: 'GET',
          signal: AbortSignal.timeout(10_000),
          headers: { 'User-Agent': 'AgentPay-Feed-Probe/1.0' },
        });
        probe = {
          probed_at: new Date().toISOString(),
          endpoint_healthy: resp.status < 500,
          latency_ms: Date.now() - started,
          http_status: resp.status,
        };
      } catch (e: unknown) {
        probe = {
          probed_at: new Date().toISOString(),
          endpoint_healthy: false,
          latency_ms: Date.now() - started,
          error: e instanceof Error ? e.message : String(e),
        };
      }

      const ttl = parseInt(env.EVENT_TTL_SECONDS ?? '86400', 10);
      await updateEvent(env.FEED_KV, eventId, { endpoint_probe: probe }, ttl);

      return json({ ok: true, event_id: eventId, probe });
    }

    // POST /v1/feed/revoke/{event_id}
    const revokeMatch = pathname.match(/^\/v1\/feed\/revoke\/(evt_[A-Za-z0-9]+)$/);
    if (method === 'POST' && revokeMatch) {
      const adminKey = env.ADMIN_KEY?.trim();
      const auth = request.headers.get('Authorization') ?? '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      if (!adminKey || token !== adminKey) return err('Unauthorized', 401);

      const eventId = revokeMatch[1];
      let reason = 'revoked by publisher';
      try {
        const body = await request.json() as Record<string, unknown>;
        if (typeof body?.reason === 'string') reason = body.reason;
      } catch { /* reason stays default */ }

      const ttl = parseInt(env.EVENT_TTL_SECONDS ?? '86400', 10);
      const updated = await updateEvent(env.FEED_KV, eventId, {
        revoked: true,
        revoke_reason: reason,
        revoked_at: new Date().toISOString(),
      }, ttl);

      if (!updated) return err('Event not found', 404);
      return json({ ok: true, event_id: eventId, revoked: true, reason });
    }

    // GET /v1/feed/verify/{event_id}
    const verifyMatch = pathname.match(/^\/v1\/feed\/verify\/(evt_[A-Za-z0-9]+)$/);
    if (method === 'GET' && verifyMatch) {
      const eventId = verifyMatch[1];
      const raw = await env.FEED_KV.get(`feed:evt:${eventId}`);
      if (!raw) return err('Event not found', 404);
      const event: FeedEvent = JSON.parse(raw);

      let signature_valid: boolean | null = null;
      if (event.signature && env.SIGN_KEY?.trim()) {
        const { signature, ...eventWithoutSig } = event;
        signature_valid = await verifyEvent(eventWithoutSig as FeedEvent, signature, env.SIGN_KEY.trim());
      }

      return json({
        event_id: eventId,
        trust_level: event.trust_level,
        source: event.source,
        category: event.category,
        published_at: event.timestamp,
        signature_valid,
        revoked: event.revoked ?? false,
        revoke_reason: event.revoke_reason ?? null,
        endpoint_probe: event.endpoint_probe ?? null,
      });
    }

    // GET /v1/feed/stats
    if (method === 'GET' && pathname === '/v1/feed/stats') {
      const stats = await getStats(env.FEED_KV);
      return json(stats);
    }

    // GET /.well-known/agent-card.json
    if (method === 'GET' && pathname === '/.well-known/agent-card.json') {
      return json({
        schema_version: '1.0',
        name: 'AgentPay Feed',
        description:
          'Open agentic newsfeed — real-time tool registrations, capability announcements, market events, and agent economy signals for autonomous agents. Any agent, any framework.',
        version: '1.2',
        publisher: {
          name: 'AgentPay Labs',
          url: 'https://agentpay.so',
          contact: 'Rajiv_baskaran@agentpay.so',
        },
        endpoints: {
          events: `${url.origin}/v1/feed/events`,
          event: `${url.origin}/v1/feed/events/{event_id}`,
          verify: `${url.origin}/v1/feed/verify/{event_id}`,
          probe: `${url.origin}/v1/feed/probe/{event_id}`,
          revoke: `${url.origin}/v1/feed/revoke/{event_id}`,
          publish: `${url.origin}/v1/feed/publish`,
          stats: `${url.origin}/v1/feed/stats`,
          archive: `${url.origin}/v1/feed/archive`,
        },
        polling: {
          recommended_interval_ms: 10000,
          cursor_param: 'since',
          cursor_type: 'unix_ms',
          example: `GET /v1/feed/events?since=0&categories=tool_registration&trust=agentpay_verified`,
        },
        categories: [
          'tool_registration',
          'market_update',
          'capability',
          'runtime',
          'system',
          'agent_economy',
        ],
        trust_levels: {
          agentpay_verified: 'Tool tested and attested by AgentPay Labs',
          community: 'Submitted by a verified community publisher',
          self_reported: 'Self-reported by publisher, unverified',
        },
        sandbox_protocol: {
          description:
            'Tools may include test_cases in their payload. Agents SHOULD execute these in a local sandboxed MCP runtime before granting the tool real credentials or data. The feed distributes test vectors; execution happens client-side.',
          payload_field: 'payload.test_cases',
          test_case_schema: {
            name: 'string',
            description: 'string (optional)',
            input: 'object — pass as tool arguments',
            expected_output_schema: 'JSON Schema object (optional) — validate response against this',
          },
          recommendation:
            'Run all test_cases in an isolated context. If any fail or produce unexpected side effects, do not grant the tool production access.',
        },
        trust_signals: {
          trust_level: 'Set at publish time — agentpay_verified > community > self_reported',
          signature: 'HMAC-SHA256 over canonical event fields — verify via GET /v1/feed/verify/{id}',
          endpoint_probe: 'HTTP reachability check run by AgentPay Labs every 15 min — endpoint_healthy: true means we reached it',
          revoked: 'revoked: true means the tool has been withdrawn — agents must stop using it',
          recommendation: 'Only act on events where trust_level=agentpay_verified AND revoked=false. Prefer events where endpoint_probe.endpoint_healthy=true.',
        },
        auth: {
          read: 'none — all events are public',
          verify: 'none — GET /v1/feed/verify/{id} is public',
          publish: 'Bearer token — contact Rajiv_baskaran@agentpay.so to obtain a key',
          probe_revoke: 'admin Bearer token only',
        },
        mcp_compatible: true,
        a2a_compatible: true,
      });
    }

    return err('Not found', 404);
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runCronProber(env));
  },
};
