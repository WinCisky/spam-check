const SPAMCHECK_URL = "https://spamcheck.postmarkapp.com/filter";
const DEFAULT_MAX_EMAIL_BYTES = 1_000_000;

export interface Env {
  ALLOWED_ORIGIN?: string;
  MAX_EMAIL_BYTES?: string;
}

interface SpamcheckResult {
  success: boolean;
  body: unknown;
  status: number;
}

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function getMaxEmailBytes(env: Env): number {
  const configured = env.MAX_EMAIL_BYTES;
  if (!configured) return DEFAULT_MAX_EMAIL_BYTES;

  const value = Number(configured);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_MAX_EMAIL_BYTES;
}

function getCorsHeaders(env: Env): Headers {
  return new Headers({
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Accept",
    "Access-Control-Max-Age": "86400",
  });
}

function jsonResponse(env: Env, body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  for (const [key, value] of getCorsHeaders(env)) {
    headers.set(key, value);
  }
  headers.set("Content-Type", "application/json; charset=utf-8");

  return new Response(JSON.stringify(body), { ...init, headers });
}

async function readJsonBody(request: Request): Promise<unknown> {
  const contentType = request.headers.get("Content-Type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    throw new SyntaxError("Content-Type must be application/json");
  }

  const text = await request.text();
  if (!text.trim()) {
    throw new SyntaxError("Request body must not be empty");
  }

  return JSON.parse(text);
}

function getEmail(payload: unknown): string {
  if (
    !payload ||
    typeof payload !== "object" ||
    !("email" in payload) ||
    typeof payload.email !== "string" ||
    payload.email.trim().length === 0
  ) {
    throw new TypeError("No email content provided");
  }

  return payload.email;
}

async function callSpamcheck(email: string, fetcher: Fetcher): Promise<SpamcheckResult> {
  const upstream = await fetcher(SPAMCHECK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ email, options: "long" }),
  });

  const contentType = upstream.headers.get("Content-Type") ?? "";
  const body = contentType.includes("application/json")
    ? await upstream.json()
    : await upstream.text();

  return { success: upstream.ok, body, status: upstream.status };
}

async function handleRequest(request: Request, env: Env, fetcher: Fetcher): Promise<Response> {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: getCorsHeaders(env) });
  }

  if (request.method !== "POST") {
    return jsonResponse(
      env,
      { error: "Only POST requests allowed" },
      { status: 405, headers: { Allow: "POST, OPTIONS" } },
    );
  }

  try {
    const maxEmailBytes = getMaxEmailBytes(env);
    const payload = await readJsonBody(request);
    const email = getEmail(payload);

    if (new TextEncoder().encode(email).byteLength > maxEmailBytes) {
      return jsonResponse(
        env,
        { error: `Email content exceeds ${maxEmailBytes} bytes` },
        { status: 413 },
      );
    }

    const spamcheck = await callSpamcheck(email, fetcher);
    if (!spamcheck.success) {
      return jsonResponse(
        env,
        {
          error: "Spamcheck service returned an error",
          upstreamStatus: spamcheck.status,
          upstreamResponse: spamcheck.body,
        },
        { status: 502 },
      );
    }

    return jsonResponse(env, spamcheck.body, { status: 200 });
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof TypeError) {
      return jsonResponse(env, { error: error.message }, { status: 400 });
    }

    const details = error instanceof Error ? error.message : "Unknown error";
    console.error("Failed to process spamcheck request", error);
    return jsonResponse(env, { error: "Failed to process request", details }, { status: 500 });
  }
}

export default {
  // Wrap global fetch: passing it around unbound throws "Illegal invocation" on Workers.
  fetch(request, env): Promise<Response> {
    return handleRequest(request, env, (input, init) => fetch(input, init));
  },
} satisfies ExportedHandler<Env>;
