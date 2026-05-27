#!/usr/bin/env python3
"""
Bootstrap: publish all 42 AgentPay MCP servers to the feed.
Run after deploying the CF Worker and setting PUBLISH_KEY.

Usage:
  FEED_URL=https://agentpay-feed.<account>.workers.dev \
  PUBLISH_KEY=<secret> \
  python3 publish_bootstrap.py
"""

import os, json, time
import httpx

FEED_URL = os.environ["FEED_URL"]
# Use ADMIN_KEY to publish as agentpay_verified (PUBLISH_KEY yields community trust)
PUBLISH_KEY = os.environ.get("ADMIN_KEY") or os.environ["PUBLISH_KEY"]

SERVERS = [
    {
        "tool_name": "search-proxy-mcp",
        "description": "Web and news search proxy for AI agents — real-time results via Search API",
        "tags": ["search", "web", "news"],
        "pricing": {"model": "per_call", "per_call": 0.001, "currency": "USD"},
    },
    {
        "tool_name": "agent-audit-mcp",
        "description": "Immutable audit trail for AI agent actions — log, search, and verify agent history",
        "tags": ["audit", "compliance", "logging"],
        "pricing": {"model": "per_call", "per_call": 0.001, "currency": "USD"},
    },
    {
        "tool_name": "agent-contract-mcp",
        "description": "AI contract analysis, drafting, review, and comparison",
        "tags": ["legal", "contracts", "compliance"],
        "pricing": {"model": "per_call", "per_call": 0.005, "currency": "USD"},
    },
    {
        "tool_name": "agent-cost-tracker-mcp",
        "description": "Track AI agent usage costs, set budgets, and get spend alerts",
        "tags": ["budget", "cost", "monitoring"],
        "pricing": {"model": "per_call", "per_call": 0.001, "currency": "USD"},
    },
    {
        "tool_name": "agent-hire-mcp",
        "description": "Agent hiring marketplace — post tasks, search workers, manage escrow and payments",
        "tags": ["marketplace", "hiring", "payments"],
        "pricing": {"model": "per_call", "per_call": 0.003, "currency": "USD"},
    },
    {
        "tool_name": "agent-legal-counsel-mcp",
        "description": "AI legal counsel — generate contracts, review clauses, summarize legal documents",
        "tags": ["legal", "counsel", "contracts"],
        "pricing": {"model": "per_call", "per_call": 0.008, "currency": "USD"},
    },
    {
        "tool_name": "agent-memory-mcp",
        "description": "Persistent memory for AI agents — store, recall, and search structured knowledge",
        "tags": ["memory", "knowledge", "persistence"],
        "pricing": {"model": "per_call", "per_call": 0.001, "currency": "USD"},
    },
    {
        "tool_name": "agent-messaging-mcp",
        "description": "Agent-to-agent and agent-to-human messaging with thread management",
        "tags": ["messaging", "communication", "a2a"],
        "pricing": {"model": "per_call", "per_call": 0.001, "currency": "USD"},
    },
    {
        "tool_name": "agent-passport-mcp",
        "description": "Agent identity and reputation — create passports, verify identity, get reputation scores",
        "tags": ["identity", "reputation", "trust"],
        "pricing": {"model": "per_call", "per_call": 0.002, "currency": "USD"},
    },
    {
        "tool_name": "agent-proof-mcp",
        "description": "Cryptographic proof of work for AI agents — create and verify execution proofs",
        "tags": ["proof", "cryptography", "verification"],
        "pricing": {"model": "per_call", "per_call": 0.002, "currency": "USD"},
    },
    {
        "tool_name": "agent-team-mcp",
        "description": "Multi-agent team management — create teams, add members, coordinate agent groups",
        "tags": ["teams", "multi-agent", "coordination"],
        "pricing": {"model": "per_call", "per_call": 0.002, "currency": "USD"},
    },
    {
        "tool_name": "agent-wallet-mcp",
        "description": "AI agent wallet and budget management — balances, transfers, transaction history",
        "tags": ["wallet", "payments", "budget"],
        "pricing": {"model": "subscription", "monthly": 19, "currency": "USD"},
    },
    {
        "tool_name": "contract-analyzer-mcp",
        "description": "Deep contract risk analysis — scan for red flags, assess legal exposure",
        "tags": ["legal", "risk", "contracts"],
        "pricing": {"model": "per_call", "per_call": 0.005, "currency": "USD"},
    },
    {
        "tool_name": "court-records-mcp",
        "description": "Search and lookup public court records and legal case history",
        "tags": ["legal", "court", "records"],
        "pricing": {"model": "per_call", "per_call": 0.003, "currency": "USD"},
    },
    {
        "tool_name": "crypto-market-mcp",
        "description": "Real-time crypto prices, market data, and trade execution",
        "tags": ["crypto", "market", "trading"],
        "pricing": {"model": "per_call", "per_call": 0.002, "currency": "USD"},
    },
    {
        "tool_name": "currency-exchange-mcp",
        "description": "Live currency conversion and exchange rates for 170+ currencies",
        "tags": ["currency", "forex", "finance"],
        "pricing": {"model": "per_call", "per_call": 0.001, "currency": "USD"},
    },
    {
        "tool_name": "database-mcp",
        "description": "AI-powered database query and schema introspection",
        "tags": ["database", "sql", "data"],
        "pricing": {"model": "per_call", "per_call": 0.003, "currency": "USD"},
    },
    {
        "tool_name": "dns-lookup-mcp",
        "description": "DNS record lookup and bulk DNS resolution for any domain",
        "tags": ["dns", "networking", "infrastructure"],
        "pricing": {"model": "per_call", "per_call": 0.001, "currency": "USD"},
    },
    {
        "tool_name": "domain-data-mcp",
        "description": "WHOIS lookup and domain availability checking",
        "tags": ["domain", "whois", "infrastructure"],
        "pricing": {"model": "per_call", "per_call": 0.002, "currency": "USD"},
    },
    {
        "tool_name": "domain-intel-mcp",
        "description": "Domain intelligence — subdomains, threat data, registrant history",
        "tags": ["domain", "intelligence", "security"],
        "pricing": {"model": "per_call", "per_call": 0.003, "currency": "USD"},
    },
    {
        "tool_name": "email-agent-mcp",
        "description": "AI agent email — send, read inbox, manage threads programmatically",
        "tags": ["email", "communication", "automation"],
        "pricing": {"model": "per_call", "per_call": 0.002, "currency": "USD"},
    },
    {
        "tool_name": "email-verify-mcp",
        "description": "Email address validation and deliverability verification",
        "tags": ["email", "validation", "deliverability"],
        "pricing": {"model": "per_call", "per_call": 0.001, "currency": "USD"},
    },
    {
        "tool_name": "file-converter-mcp",
        "description": "Convert files between formats — PDF, Word, Excel, images, and more",
        "tags": ["files", "conversion", "documents"],
        "pricing": {"model": "per_call", "per_call": 0.003, "currency": "USD"},
    },
    {
        "tool_name": "hackernews-mcp",
        "description": "Hacker News top stories, search, and comment retrieval",
        "tags": ["news", "tech", "community"],
        "pricing": {"model": "free"},
    },
    {
        "tool_name": "hallucination-guard",
        "description": "Detect and score AI hallucinations in generated text",
        "tags": ["safety", "verification", "ai"],
        "pricing": {"model": "per_call", "per_call": 0.002, "currency": "USD"},
    },
    {
        "tool_name": "image-analyzer-mcp",
        "description": "AI image analysis and OCR — extract text, identify objects, describe scenes",
        "tags": ["vision", "ocr", "image"],
        "pricing": {"model": "per_call", "per_call": 0.003, "currency": "USD"},
    },
    {
        "tool_name": "ip-geolocation-mcp",
        "description": "IP address geolocation — country, city, ISP, coordinates",
        "tags": ["ip", "geolocation", "networking"],
        "pricing": {"model": "per_call", "per_call": 0.001, "currency": "USD"},
    },
    {
        "tool_name": "mcp-health-monitor",
        "description": "Health monitoring for MCP servers — uptime checks and history",
        "tags": ["monitoring", "health", "infrastructure"],
        "pricing": {"model": "per_call", "per_call": 0.001, "currency": "USD"},
    },
    {
        "tool_name": "notification-mcp",
        "description": "Multi-channel agent notifications — push, email, webhook delivery",
        "tags": ["notifications", "alerts", "communication"],
        "pricing": {"model": "per_call", "per_call": 0.001, "currency": "USD"},
    },
    {
        "tool_name": "patent-search-mcp",
        "description": "Patent search and lookup — USPTO, EPO, and global patent databases",
        "tags": ["patents", "ip", "legal"],
        "pricing": {"model": "per_call", "per_call": 0.003, "currency": "USD"},
    },
    {
        "tool_name": "pdf-generator-mcp",
        "description": "Generate, merge, and manipulate PDF documents programmatically",
        "tags": ["pdf", "documents", "generation"],
        "pricing": {"model": "per_call", "per_call": 0.003, "currency": "USD"},
    },
    {
        "tool_name": "qr-code-mcp",
        "description": "Generate and decode QR codes for any URL or data payload",
        "tags": ["qr", "encoding", "utility"],
        "pricing": {"model": "free"},
    },
    {
        "tool_name": "rental-agent-mcp",
        "description": "Property rental search and listing management",
        "tags": ["real-estate", "rental", "property"],
        "pricing": {"model": "per_call", "per_call": 0.003, "currency": "USD"},
    },
    {
        "tool_name": "screenshot-mcp",
        "description": "Full-page web screenshots and batch screenshot capture",
        "tags": ["screenshot", "browser", "web"],
        "pricing": {"model": "per_call", "per_call": 0.002, "currency": "USD"},
    },
    {
        "tool_name": "sec-financial-mcp",
        "description": "SEC filing search and company financial data lookup",
        "tags": ["finance", "sec", "filings"],
        "pricing": {"model": "per_call", "per_call": 0.003, "currency": "USD"},
    },
    {
        "tool_name": "secret-scanner-mcp",
        "description": "Scan code and text for leaked secrets, API keys, and credentials",
        "tags": ["security", "secrets", "scanning"],
        "pricing": {"model": "per_call", "per_call": 0.003, "currency": "USD"},
    },
    {
        "tool_name": "seo-audit-mcp",
        "description": "Comprehensive SEO audit — technical issues, content analysis, competitor data",
        "tags": ["seo", "marketing", "web"],
        "pricing": {"model": "per_call", "per_call": 0.005, "currency": "USD"},
    },
    {
        "tool_name": "ssl-check-mcp",
        "description": "SSL certificate validation and expiry monitoring",
        "tags": ["ssl", "security", "infrastructure"],
        "pricing": {"model": "per_call", "per_call": 0.002, "currency": "USD"},
    },
    {
        "tool_name": "text-to-speech-mcp",
        "description": "High-quality text-to-speech synthesis with voice selection",
        "tags": ["tts", "audio", "voice"],
        "pricing": {"model": "per_call", "per_call": 0.003, "currency": "USD"},
    },
    {
        "tool_name": "weather-mcp",
        "description": "Current weather and multi-day forecast for any location",
        "tags": ["weather", "forecast", "data"],
        "pricing": {"model": "free"},
    },
    {
        "tool_name": "web-scraper-mcp",
        "description": "Full-page web scraping with JavaScript rendering support",
        "tags": ["scraping", "web", "data"],
        "pricing": {"model": "per_call", "per_call": 0.002, "currency": "USD"},
    },
    {
        "tool_name": "wikipedia-mcp",
        "description": "Wikipedia article search and full-text retrieval",
        "tags": ["knowledge", "search", "reference"],
        "pricing": {"model": "free"},
    },
]

headers = {"Authorization": f"Bearer {PUBLISH_KEY}", "Content-Type": "application/json"}

published = 0
errors = 0
for srv in SERVERS:
    body = {
        "category": "tool_registration",
        "action": "register",
        "source": "agentpay-labs",
        "payload": {
            "tool_name": srv["tool_name"],
            "description": srv["description"],
            "endpoint": f"https://agentpay.so/mcp/{srv['tool_name']}",
            "install_command": f"npx @agentpay/{srv['tool_name']}",
            "pricing": srv.get("pricing", {"model": "free"}),
            "tags": srv.get("tags", []),
        },
    }
    try:
        r = httpx.post(f"{FEED_URL}/v1/feed/publish", json=body, headers=headers, timeout=15)
        r.raise_for_status()
        data = r.json()
        print(f"OK  {srv['tool_name']} → {data['event_id']}")
        published += 1
    except Exception as e:
        print(f"ERR {srv['tool_name']} → {e}")
        errors += 1
    time.sleep(0.2)

print(f"\nDone. {published} published, {errors} errors.")
