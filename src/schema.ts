export const CATEGORIES = [
  'tool_registration',
  'market_update',
  'capability',
  'runtime',
  'system',
] as const;

export const ACTIONS = [
  'register',
  'update',
  'deprecate',
  'announce',
  'heartbeat',
  'price_change',
  'availability',
] as const;

export type Category = (typeof CATEGORIES)[number];
export type Action = (typeof ACTIONS)[number];

export const TRUST_LEVELS = ['agentpay_verified', 'community', 'self_reported'] as const;
export type TrustLevel = (typeof TRUST_LEVELS)[number];

export interface TestCase {
  name: string;
  description?: string;
  input: Record<string, unknown>;
  expected_output_schema?: Record<string, unknown>;
}

export interface FeedEventPayload {
  tool_name?: string;
  description?: string;
  schema?: Record<string, unknown>;
  ttl_ms?: number;
  endpoint?: string;
  install_command?: string;
  pricing?: {
    per_call?: number;
    monthly?: number;
    currency?: string;
    model?: 'per_call' | 'subscription' | 'free';
  };
  tags?: string[];
  // Publisher-supplied test vectors — agent runtimes execute these locally before granting tool permissions
  test_cases?: TestCase[];
  // Reserved: future cryptographic attestation
  publisher_signature?: string;
  [key: string]: unknown;
}

export interface FeedEvent {
  event_id: string;
  timestamp: string;
  ts_ms: number;
  category: Category;
  action: Action;
  source: string;
  // Trust level set at publish time by the bearer token tier
  trust_level: TrustLevel;
  payload: FeedEventPayload;
  version: '1';
}

export interface IndexEntry {
  id: string;
  ts_ms: number;
  category: Category;
  action: Action;
  trust_level: TrustLevel;
}

export interface FeedIndex {
  entries: IndexEntry[];
  total_published: number;
}

export type PublishBody = Omit<FeedEvent, 'event_id' | 'timestamp' | 'ts_ms' | 'version' | 'trust_level'>;

export function validatePublishBody(
  body: unknown,
): { ok: true; data: PublishBody } | { ok: false; error: string } {
  if (!body || typeof body !== 'object') return { ok: false, error: 'body must be an object' };
  const b = body as Record<string, unknown>;

  if (!CATEGORIES.includes(b.category as Category))
    return { ok: false, error: `category must be one of: ${CATEGORIES.join(', ')}` };

  if (!ACTIONS.includes(b.action as Action))
    return { ok: false, error: `action must be one of: ${ACTIONS.join(', ')}` };

  if (typeof b.source !== 'string' || !b.source.trim())
    return { ok: false, error: 'source is required (string)' };

  if (!b.payload || typeof b.payload !== 'object' || Array.isArray(b.payload))
    return { ok: false, error: 'payload must be an object' };

  return { ok: true, data: b as unknown as PublishBody };
}
