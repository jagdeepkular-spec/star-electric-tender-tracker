/* Star Electric Tender Tracker - private storage Worker
 *
 * The tracker page is public (it is just code), but the tender register and
 * the tabulation PDFs live here, behind a key. The key travels in the
 * fragment of the bookmark link, never in a URL the server sees, and the
 * page sends it as a bearer token on every call.
 *
 * Bindings set in the Cloudflare dashboard:
 *   DB        D1 database - holds the register
 *   PDFS      KV namespace - holds the tabulation PDFs
 * Secret:
 *   APP_KEY   the key that unlocks reading and saving
 */

const CONFIG = {
  ALLOWED_ORIGIN: "https://jagdeepkular-spec.github.io",
};
function cfg(env, name) { return (env && env[name]) || CONFIG[name]; }

function cors(env, extra) {
  return Object.assign({
    "Access-Control-Allow-Origin": cfg(env, "ALLOWED_ORIGIN") || "*",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Allow-Methods": "GET, PUT, POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
  }, extra || {});
}
function json(env, obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: cors(env, { "Content-Type": "application/json" }),
  });
}

// Compare without leaking which character differed through timing.
function sameKey(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
function authorised(request, env) {
  const key = cfg(env, "APP_KEY");
  if (!key) return false;                       // nothing set: refuse everything
  const auth = request.headers.get("Authorization") || "";
  if (auth.indexOf("Bearer ") !== 0) return false;
  return sameKey(auth.slice(7), key);
}

async function ensureTable(env) {
  await env.DB.prepare(
    "CREATE TABLE IF NOT EXISTS store (k TEXT PRIMARY KEY, v TEXT NOT NULL, updated TEXT)"
  ).run();
}

async function readRegister(env) {
  await ensureTable(env);
  const row = await env.DB.prepare("SELECT v FROM store WHERE k = ?").bind("register").first();
  return row ? row.v : null;
}

async function writeRegister(env, text) {
  await ensureTable(env);
  await env.DB.prepare(
    "INSERT INTO store (k, v, updated) VALUES (?, ?, ?) " +
    "ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated = excluded.updated"
  ).bind("register", text, new Date().toISOString()).run();
}

function pdfName(pathname) {
  const m = /^\/pdf\/([A-Za-z0-9._-]+)$/.exec(pathname);
  return m ? m[1] : null;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors(env) });
    }

    // A health check that gives nothing away.
    if (url.pathname === "/") {
      return json(env, { service: "star-electric-tender-tracker", ok: true });
    }

    if (!authorised(request, env)) {
      return json(env, { error: "This link is missing its key." }, 401);
    }

    if (url.pathname === "/data" && request.method === "GET") {
      const v = await readRegister(env);
      return v === null ? json(env, { empty: true }) : json(env, { data: JSON.parse(v) });
    }

    if (url.pathname === "/data" && request.method === "PUT") {
      let text;
      try { text = JSON.stringify(await request.json()); }
      catch (e) { return json(env, { error: "Bad register" }, 400); }
      await writeRegister(env, text);
      return json(env, { ok: true, saved: text.length });
    }

    const name = pdfName(url.pathname);
    if (name && request.method === "GET") {
      const b = await env.PDFS.get(name, { type: "arrayBuffer" });
      if (!b) return json(env, { error: "No tabulation stored for " + name }, 404);
      return new Response(b, { headers: cors(env, { "Content-Type": "application/pdf" }) });
    }

    if (name && request.method === "PUT") {
      let body;
      try { body = await request.json(); }
      catch (e) { return json(env, { error: "Bad request body" }, 400); }
      if (typeof body.content !== "string" || !body.content) {
        return json(env, { error: "No content" }, 400);
      }
      const bin = atob(body.content.replace(/\s+/g, ""));
      const u = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
      await env.PDFS.put(name, u);
      return json(env, { ok: true, stored: u.length });
    }

    return json(env, { error: "Not found" }, 404);
  },
};
