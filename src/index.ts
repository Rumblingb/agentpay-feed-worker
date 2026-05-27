import { validatePublishBody, type FeedEvent, type TrustLevel } from './schema';
import { writeEvent, readEvents, getStats } from './kv';

export interface Env {
  FEED_KV: KVNamespace;
  PUBLISH_KEY: string;
  ADMIN_KEY: string;
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
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

      // Determine trust level from token (trim to handle secret storage edge cases)
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
      await writeEvent(env.FEED_KV, event, ttl);

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

      return json({ events, cursor: { since_ms: cursor_ms }, has_more, count: events.length });
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
          'Open agentic newsfeed — real-time tool registrations, capability announcements, and market events for autonomous agents. Any agent, any framework.',
        version: '1.1',
        publisher: {
          name: 'AgentPay Labs',
          url: 'https://agentpay.so',
          contact: 'Rajiv_baskaran@agentpay.so',
        },
        endpoints: {
          events: `${url.origin}/v1/feed/events`,
          event: `${url.origin}/v1/feed/events/{event_id}`,
          publish: `${url.origin}/v1/feed/publish`,
          stats: `${url.origin}/v1/feed/stats`,
        },
        polling: {
          recommended_interval_ms: 10000,
          cursor_param: 'since',
          cursor_type: 'unix_ms',
          example: `GET /v1/feed/events?since=0&categories=tool_registration&trust=agentpay_verified`,
        },
        categories: ['tool_registration', 'market_update', 'capability', 'runtime', 'system'],
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
        auth: {
          read: 'none — all events are public',
          publish: 'Bearer token — contact Rajiv_baskaran@agentpay.so to obtain a key',
          trust_levels_by_token: {
            admin_key: 'agentpay_verified',
            publish_key: 'community',
          },
        },
        mcp_compatible: true,
        a2a_compatible: true,
      });
    }

    return err('Not found', 404);
  },
};
