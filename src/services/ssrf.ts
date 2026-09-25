import { lookup } from "node:dns/promises";

/**
 * SSRF protection for server-side requests to operator-configured upstream URLs.
 *
 * Every fetch to a user-controlled `baseUrl` (proxy fan-out, model discovery,
 * connectivity tests) goes through `fetchUpstream`, which validates the target
 * before connecting and re-validates every redirect hop.
 *
 * Blocked destination classes:
 * - non-http(s) schemes, URLs with embedded credentials
 * - link-local (169.254/16 incl. cloud metadata endpoints, fe80::/10)
 * - multicast, unspecified (except loopback-class, see below), reserved,
 *   documentation, benchmarking and CGNAT ranges
 * - loopback (127/8, ::1, IPv4-mapped loopback, "localhost") — see opt-out below
 *
 * Deliberately ALLOWED: RFC1918 private addresses and IPv6 ULA. Container and
 * LAN upstreams (Ollama/VLLM on docker bridge or LAN addresses) are a
 * documented feature of this gateway; blocking them would break legitimate
 * deployments. Callers who configure upstreams already hold full management
 * access, so the hard boundary drawn here is the credential-theft primitives
 * (cloud metadata, same-host loopback services) plus non-routable space.
 *
 * Loopback opt-out: same-host upstreams (e.g. Ollama on `localhost:11434`
 * under host networking) are legitimate, so operators can set
 * `ALLOW_LOOPBACK_UPSTREAMS=1` to permit loopback targets explicitly.
 * Everything else stays blocked even then.
 *
 * Residual risk (documented, not solved here): DNS rebinding between the
 * validation lookup and connect (TOCTOU). Fully pinning connections would
 * require custom socket dialing with SNI/Host overrides.
 */

export class UpstreamUrlBlockedError extends Error {
  constructor(reason: string) {
    super(`Upstream request blocked: ${reason}`);
    this.name = "UpstreamUrlBlockedError";
  }
}

function parseIpv4(host: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  let n = 0;
  for (let i = 1; i <= 4; i++) {
    const v = Number(m[i]);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n >>> 0;
}

function inV4Range(ip: number, base: string, prefix: number): boolean {
  const baseInt = parseIpv4(base);
  if (baseInt === null) return false;
  if (prefix === 0) return true;
  const mask = prefix === 32 ? 0xffffffff : (~((1 << (32 - prefix)) - 1) >>> 0);
  return (ip & mask) === (baseInt & mask);
}

// Intentionally EXCLUDES RFC1918 private ranges (10/8, 172.16/12, 192.168/16)
// so container/LAN upstreams keep working, and EXCLUDES loopback, which is
// gated separately by allowLoopbackUpstreams(). See module docstring.
const BLOCKED_V4: Array<[string, number, string]> = [
  ["100.64.0.0", 10, "carrier-grade NAT address"],
  ["169.254.0.0", 16, "link-local address (incl. cloud metadata)"],
  ["192.0.0.0", 24, "reserved IETF address"],
  ["192.0.2.0", 24, "documentation address"],
  ["192.88.99.0", 24, "deprecated relay address"],
  ["198.18.0.0", 15, "benchmarking address"],
  ["198.51.100.0", 24, "documentation address"],
  ["203.0.113.0", 24, "documentation address"],
  ["224.0.0.0", 4, "multicast address"],
  ["240.0.0.0", 4, "reserved address"],
];

const LOOPBACK_HINT = "set ALLOW_LOOPBACK_UPSTREAMS=1 to permit same-host upstreams explicitly";

/** Explicit opt-in for same-host upstreams (e.g. Ollama on localhost:11434). */
export function allowLoopbackUpstreams(): boolean {
  const v = (process.env.ALLOW_LOOPBACK_UPSTREAMS || "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

function isLoopbackV4(ip: number): boolean {
  return inV4Range(ip, "127.0.0.0", 8) || inV4Range(ip, "0.0.0.0", 8);
}

function v4BlockReason(ip: number): string | null {
  if (isLoopbackV4(ip)) {
    return allowLoopbackUpstreams()
      ? null
      : `loopback address (${LOOPBACK_HINT})`;
  }
  for (const [base, prefix, label] of BLOCKED_V4) {
    if (inV4Range(ip, base, prefix)) return label;
  }
  return null;
}

function parseIpv6(host: string): number[] | null {
  let h = host.toLowerCase();
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  if (h.includes("%")) return null; // zone id: only relevant for link-local, which is blocked anyway
  if (!h.includes(":")) return null;

  const halves = h.split("::");
  if (halves.length > 2) return null;

  const parseGroup = (part: string): number[] | null => {
    if (part === "") return [];
    const out: number[] = [];
    for (const g of part.split(":")) {
      if (g.includes(".")) {
        // embedded IPv4: x:x:x:x:x:x:d.d.d.d
        const v4 = parseIpv4(g);
        if (v4 === null) return null;
        out.push((v4 >>> 16) & 0xffff, v4 & 0xffff);
      } else {
        if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
        out.push(parseInt(g, 16));
      }
    }
    return out;
  };

  const head = parseGroup(halves[0] ?? "");
  const tail = halves.length === 2 ? parseGroup(halves[1] ?? "") : null;
  if (!head || (halves.length === 2 && !tail)) return null;

  if (halves.length === 1) {
    return head.length === 8 ? head : null;
  }
  const missing = 8 - head.length - (tail?.length ?? 0);
  if (missing < 1) return null; // "::" must compress at least one group
  return [...head, ...new Array(missing).fill(0), ...(tail ?? [])];
}

function v6BlockReason(g: number[]): string | null {
  const [h0 = 0, h1 = 0, h2 = 0, , , h5 = 0, h6 = 0, h7 = 0] = g;

  const v4Embedded = (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && (h5 === 0xffff || h5 === 0x0000))
    ? ((h6 * 65536 + h7) >>> 0)
    : null;

  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d): judge the embedded v4,
  // including its loopback gating.
  if (v4Embedded !== null) {
    if (h5 === 0x0000 && h6 === 0 && (h7 === 0 || h7 === 1)) {
      if (h7 === 0) return "unspecified address";
      return allowLoopbackUpstreams() ? null : `loopback address (${LOOPBACK_HINT})`;
    }
    return v4BlockReason(v4Embedded);
  }

  if (g.every((x) => x === 0)) return "unspecified address";
  if (g[7] === 1 && g.slice(0, 7).every((x) => x === 0)) {
    return allowLoopbackUpstreams() ? null : `loopback address (${LOOPBACK_HINT})`;
  }
  if ((h0 & 0xffc0) === 0xfe80) return "link-local address";
  if ((h0 & 0xff00) === 0xff00) return "multicast address";
  if (h0 === 0x2001 && h1 === 0x0db8) return "documentation address";
  if (h0 === 0x2001 && h1 === 0x0000) return "tunneling address";
  if (h0 === 0x2002) return "deprecated transition address";
  if (h0 === 0x0064 && h1 === 0xff9b) return "translation-service address";

  // Allow global unicast and ULA (LAN IPv6 for self-hosted upstreams).
  if ((h0 & 0xe000) === 0x2000) return null;
  if ((h0 & 0xfe00) === 0xfc00) return null;
  void h2;

  return "non-global IPv6 address";
}

/** Returns a human-readable block reason, or null when the literal IP is allowed. */
export function ipBlockReason(ip: string): string | null {
  const v4 = parseIpv4(ip.trim());
  if (v4 !== null) return v4BlockReason(v4);
  if (ip.includes(":")) {
    const g = parseIpv6(ip.trim());
    if (g === null) return "unparseable IP literal";
    return v6BlockReason(g);
  }
  return null; // not an IP literal
}

function isIpLiteral(host: string): boolean {
  return parseIpv4(host) !== null || (host.includes(":") && parseIpv6(host) !== null);
}

async function hostnameBlockReason(hostname: string): Promise<string | null> {
  const host = hostname.toLowerCase();

  // Literal IP: classify directly, no DNS involved.
  const literalReason = ipBlockReason(host);
  if (isIpLiteral(host)) return literalReason;

  // DNS names: every resolved address must be allowed. A single blocked
  // address fails the whole name (fail closed on DNS errors too).
  let records: Array<{ address: string }>;
  try {
    records = await lookup(host, { all: true });
  } catch {
    return "hostname does not resolve";
  }
  if (records.length === 0) return "hostname does not resolve";
  for (const r of records) {
    const reason = ipBlockReason(r.address);
    if (reason) return `hostname resolves to ${reason} (${r.address})`;
  }
  return null;
}

export type UrlVerdict = { ok: true } | { ok: false; reason: string };

/** Full async validation: scheme, credentials, literal IP or DNS-resolved addresses. */
export async function checkUpstreamUrl(urlStr: string): Promise<UrlVerdict> {
  let url: URL;
  try {
    url = new URL(urlStr);
  } catch {
    return { ok: false, reason: "not a valid absolute URL" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: `URL scheme "${url.protocol.replace(":", "")}" is not allowed (http/https only)` };
  }
  if (url.username || url.password) {
    return { ok: false, reason: "URL must not contain credentials" };
  }
  const reason = await hostnameBlockReason(url.hostname);
  if (reason) return { ok: false, reason: `blocked upstream target: ${reason}` };
  return { ok: true };
}

/**
 * Synchronous write-time validation for operator-supplied baseUrl values.
 * Returns an error message, or null when the value is acceptable.
 *
 * Lexical checks only (no DNS — the authoritative enforcement happens in
 * fetchUpstream at request time). Rejects obvious loopback at save time for
 * fast feedback; DNS-resolved threats are still caught on fetch.
 */
export function validateBaseUrlInput(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  if (!s) return null;

  let url: URL;
  try {
    url = new URL(s);
  } catch {
    return "baseUrl must be an absolute http(s) URL";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return "baseUrl must use http or https";
  }
  if (url.username || url.password) {
    return "baseUrl must not contain credentials";
  }

  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) {
    if (!allowLoopbackUpstreams()) {
      return "baseUrl must not point to localhost (loopback targets are blocked; use a LAN address for self-hosted upstreams, or set ALLOW_LOOPBACK_UPSTREAMS=1)";
    }
    return null;
  }
  if (isIpLiteral(host)) {
    const reason = ipBlockReason(host);
    if (reason) return `baseUrl points to a restricted ${reason}`;
  }
  return null;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * fetch() wrapper for user-controlled upstream URLs. Validates the initial
 * URL and every redirect hop; throws UpstreamUrlBlockedError on violation.
 * Redirects are followed manually (max 3) with spec-style method rewriting.
 */
export async function fetchUpstream(
  urlStr: string,
  init?: RequestInit,
  opts?: { maxRedirects?: number }
): Promise<Response> {
  const maxRedirects = opts?.maxRedirects ?? 3;
  let current = urlStr;
  let method = (init?.method ?? "GET").toUpperCase();
  let body = init?.body;
  let hop = 0;

  for (;;) {
    const verdict: UrlVerdict = await checkUpstreamUrl(current);
    if (verdict.ok === false) {
      console.warn(`[SSRF] Blocked upstream fetch to ${redactUrl(current)}: ${verdict.reason}`);
      throw new UpstreamUrlBlockedError(verdict.reason);
    }

    const res = await fetch(current, { ...init, method, body, redirect: "manual" });
    const location = res.headers.get("location");

    if (REDIRECT_STATUSES.has(res.status) && location && hop < maxRedirects) {
      try {
        await res.body?.cancel();
      } catch {
        // ignore
      }
      try {
        current = new URL(location, current).toString();
      } catch {
        throw new UpstreamUrlBlockedError("invalid redirect location");
      }
      if ((res.status === 301 || res.status === 302 || res.status === 303) && method !== "GET" && method !== "HEAD") {
        method = "GET";
        body = undefined;
      }
      hop++;
      continue;
    }

    return res;
  }
}

function redactUrl(urlStr: string): string {
  try {
    const u = new URL(urlStr);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return "(unparseable url)";
  }
}
