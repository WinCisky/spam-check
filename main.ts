const SPAMCHECK_URL = "https://spamcheck.postmarkapp.com/filter";

const DEFAULT_MAX_EMAIL_BYTES = 1_000_000;



export interface SpamcheckResult {

  success: boolean;

  body: unknown;

  status: number;

}



export type Fetcher = (

  input: string | URL | Request,

  init?: RequestInit,

) => Promise<Response> | Response;



function getMaxEmailBytes(): number {

  const configured = Deno.env.get("MAX_EMAIL_BYTES");

  if (!configured) return DEFAULT_MAX_EMAIL_BYTES;



  const value = Number(configured);

  return Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_MAX_EMAIL_BYTES;

}



function getCorsHeaders(): Headers {

  return new Headers({

    "Access-Control-Allow-Origin": Deno.env.get("ALLOWED_ORIGIN") ?? "*",

    "Access-Control-Allow-Methods": "POST, OPTIONS",

    "Access-Control-Allow-Headers": "Content-Type",

    "Access-Control-Max-Age": "86400",

  });

}



function jsonResponse(body: unknown, init: ResponseInit = {}): Response {

  const headers = new Headers(init.headers);

  for (const [key, value] of getCorsHeaders()) {

    headers.set(key, value);

  }

  headers.set("Content-Type", "application/json; charset=utf-8");



  return new Response(JSON.stringify(body), {

    ...init,

    headers,

  });

}



function methodNotAllowed(): Response {

  return jsonResponse(

    { error: "Only POST requests allowed" },

    {

      status: 405,

      headers: { Allow: "POST, OPTIONS" },

    },

  );

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

  const forwardResponse = await fetcher(SPAMCHECK_URL, {

    method: "POST",

    headers: { "Content-Type": "application/json" },

    body: JSON.stringify({ email, options: "long" }),

  });



  const contentType = forwardResponse.headers.get("Content-Type") ?? "";

  const body = contentType.includes("application/json")

    ? await forwardResponse.json()

    : await forwardResponse.text();



  return {

    success: forwardResponse.ok,

    body,

    status: forwardResponse.status,

  };

}



export function createHandler(fetcher: Fetcher = fetch): (request: Request) => Promise<Response> {

  return async function handler(request: Request): Promise<Response> {

    if (request.method === "OPTIONS") {

      return new Response(null, { status: 204, headers: getCorsHeaders() });

    }



    if (request.method !== "POST") {

      return methodNotAllowed();

    }



    try {

      const maxEmailBytes = getMaxEmailBytes();

      const payload = await readJsonBody(request);

      const email = getEmail(payload);



      if (new TextEncoder().encode(email).byteLength > maxEmailBytes) {

        return jsonResponse(

          { error: `Email content exceeds ${maxEmailBytes} bytes` },

          { status: 413 },

        );

      }



      const spamcheck = await callSpamcheck(email, fetcher);

      if (!spamcheck.success) {

        return jsonResponse(

          {

            error: "Spamcheck service returned an error",

            upstreamStatus: spamcheck.status,

            upstreamResponse: spamcheck.body,

          },

          { status: 502 },

        );

      }



      return jsonResponse(spamcheck.body, { status: 200 });

    } catch (error) {

      if (error instanceof SyntaxError) {

        return jsonResponse({ error: error.message }, { status: 400 });

      }



      if (error instanceof TypeError) {

        return jsonResponse({ error: error.message }, { status: 400 });

      }



      const details = error instanceof Error ? error.message : "Unknown error";

      console.error("Failed to process spamcheck request", error);

      return jsonResponse(

        { error: "Failed to process request", details },

        { status: 500 },

      );

    }

  };

}



if (import.meta.main) {

  Deno.serve(createHandler());

}

