/**
 * Star Electric Tender Tracker - sign-in and commit service.
 *
 * The tracker is a static page, so it has nowhere safe to keep a GitHub
 * credential. This Worker holds it instead:
 *
 *   /login     -> sends the person to GitHub to approve
 *   /callback  -> swaps the code for a GitHub token, checks the account is
 *                 allowed, and hands the page a signed session
 *   /commit    -> verifies the session and writes a file to the repository
 *   /me        -> who the session belongs to
 *
 * The GitHub client secret never leaves this Worker, and the session the page
 * holds is useless anywhere else: it only commits to the one repository below.
 *
 * Required secrets (wrangler secret put NAME):
 *   GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET
 *   SESSION_SECRET is optional: when it is not set, the session signing key
 *   is derived from GITHUB_CLIENT_SECRET, so only one secret has to be
 *   stored in Cloudflare.
 * Required vars (wrangler.toml):
 *   ALLOWED_LOGINS, ALLOWED_ORIGIN, REPO_OWNER, REPO_NAME, REPO_BRANCH
 */

const SESSION_DAYS = 30;

/* Non-secret configuration. These are plain settings, not credentials, so they
   live here rather than as dashboard variables - one less thing to configure,
   and the dashboard's variable editor has been unreliable. An environment
   variable of the same name still wins if one is set. */
const CONFIG = {
  ALLOWED_LOGINS: "jagdeepkular-spec",
  ALLOWED_ORIGIN: "https://jagdeepkular-spec.github.io",
  REPO_OWNER: "jagdeepkular-spec",
  REPO_NAME: "star-electric-tender-tracker",
  REPO_BRANCH: "main",
};
function cfg(env, name) {
  return (env && env[name]) || CONFIG[name];
}

/* ------------------------------------------------------------- utilities */

const enc = new TextEncoder();

function b64url(bytes) {
  let s = "";
  const u = new Uint8Array(bytes);
  for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlToBytes(str) {
  str = str.replace(/-/g, "+").replace(/_/g, "/");
  while (str.length % 4) str += "=";
  const bin = atob(str);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}

async function hmacKey(secret) {
  return crypto.subtle.importKey("raw", enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

// The sessions this Worker hands out are signed with their own key. If no
// SESSION_SECRET is configured, derive one from the OAuth client secret so
// that only a single secret has to be kept in Cloudflare. The prefix keeps
// the derived key distinct from the client secret itself.
function sessionSecret(env) {
  return env.SESSION_SECRET || ("star-tender-session|" + (env.GITHUB_CLIENT_SECRET || ""));
}

async function signSession(payload, secret) {
  const body = b64url(enc.encode(JSON.stringify(payload)));
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(body));
  return body + "." + b64url(sig);
}

async function readSession(token, secret) {
  if (!token || token.indexOf(".") < 0) return null;
  const [body, sig] = token.split(".");
  const key = await hmacKey(secret);
  const ok = await crypto.subtle.verify("HMAC", key, b64urlToBytes(sig), enc.encode(body));
  if (!ok) return null;
  let payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(body)));
  } catch (e) {
    return null;
  }
  if (!payload.exp || Date.now() > payload.exp) return null;
  return payload;
}

function cors(env, extra) {
  return Object.assign({
    "Access-Control-Allow-Origin": cfg(env, "ALLOWED_ORIGIN") || "*",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
  }, extra || {});
}
function json(env, obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: cors(env, { "Content-Type": "application/json" }),
  });
}

/* ------------------------------------------------------------------ routes */

async function handleLogin(url, env) {
  const back = url.searchParams.get("redirect") || cfg(env, "ALLOWED_ORIGIN");
  const origin = cfg(env, "ALLOWED_ORIGIN");
  if (origin && back.indexOf(origin) !== 0) {
    return new Response("Refusing to send the sign-in back to another site.", { status: 400 });
  }
  const state = b64url(enc.encode(JSON.stringify({ back: back, n: crypto.randomUUID() })));
  const auth = new URL("https://github.com/login/oauth/authorize");
  auth.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
  auth.searchParams.set("redirect_uri", url.origin + "/callback");
  auth.searchParams.set("scope", "public_repo");
  auth.searchParams.set("state", state);
  return Response.redirect(auth.toString(), 302);
}

function finish(back, hash) {
  return new Response(null, { status: 302, headers: { Location: back + hash } });
}

async function handleCallback(url, env) {
  const code = url.searchParams.get("code");
  const stateRaw = url.searchParams.get("state") || "";
  let back = cfg(env, "ALLOWED_ORIGIN");
  try {
    back = JSON.parse(new TextDecoder().decode(b64urlToBytes(stateRaw))).back || back;
  } catch (e) { /* fall back to the configured origin */ }
  const origin = cfg(env, "ALLOWED_ORIGIN");
  if (origin && back.indexOf(origin) !== 0) back = origin;
  if (!code) return finish(back, "#error=" + encodeURIComponent("GitHub sent no code"));

  const res = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { "Accept": "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code: code,
      redirect_uri: url.origin + "/callback",
    }),
  });
  const tok = await res.json();
  if (!tok.access_token) {
    return finish(back, "#error=" + encodeURIComponent(tok.error_description || "sign-in failed"));
  }

  const who = await fetch("https://api.github.com/user", {
    headers: {
      "Authorization": "Bearer " + tok.access_token,
      "Accept": "application/vnd.github+json",
      "User-Agent": "star-electric-tender-tracker",
    },
  });
  if (!who.ok) return finish(back, "#error=" + encodeURIComponent("could not read the GitHub account"));
  const user = await who.json();

  const allowed = String(cfg(env, "ALLOWED_LOGINS") || "")
    .split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
  if (allowed.length && allowed.indexOf(String(user.login).toLowerCase()) < 0) {
    return finish(back, "#error=" + encodeURIComponent(
      user.login + " is not allowed to edit this tracker"));
  }

  const session = await signSession({
    login: user.login,
    gh: tok.access_token,
    exp: Date.now() + SESSION_DAYS * 86400000,
  }, sessionSecret(env));
  return finish(back, "#session=" + encodeURIComponent(session) +
                      "&login=" + encodeURIComponent(user.login));
}

async function sessionFrom(request, env) {
  const auth = request.headers.get("Authorization") || "";
  if (auth.indexOf("Bearer ") !== 0) return null;
  return await readSession(auth.slice(7), sessionSecret(env));
}

async function handleCommit(request, env) {
  const s = await sessionFrom(request, env);
  if (!s) return json(env, { error: "Not signed in" }, 401);

  let body;
  try { body = await request.json(); }
  catch (e) { return json(env, { error: "Bad request body" }, 400); }

  const path = String(body.path || "");
  // Only the register and the tabulation PDFs, nothing else in the repository.
  if (!(path === "data.json" || /^pdfs\/[A-Za-z0-9._-]+\.pdf$/.test(path))) {
    return json(env, { error: "That path cannot be written: " + path }, 400);
  }
  if (typeof body.content !== "string" || !body.content) {
    return json(env, { error: "No content" }, 400);
  }

  const api = "https://api.github.com/repos/" + cfg(env, "REPO_OWNER") + "/" +
              cfg(env, "REPO_NAME") + "/contents/" + path;
  const payload = {
    message: (body.message || "Update from the tracker") + "\n\nSigned in as " + s.login,
    content: body.content,
    branch: cfg(env, "REPO_BRANCH") || "main",
  };
  if (body.sha) payload.sha = body.sha;

  const res = await fetch(api, {
    method: "PUT",
    headers: {
      "Authorization": "Bearer " + s.gh,
      "Accept": "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": "star-electric-tender-tracker",
    },
    body: JSON.stringify(payload),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) {
    return json(env, { error: out.message || ("HTTP " + res.status), status: res.status }, res.status);
  }
  return json(env, { ok: true, commit: out.commit && out.commit.sha, content: out.content });
}

/* --------------------------------------------------------- the device flow
 * GitHub's device flow lets a browser sign in with nothing but the public
 * client id - no client secret anywhere. The browser cannot call GitHub's
 * device endpoints directly (they send no CORS headers), so this Worker
 * passes the two calls through. It holds no secret of its own.
 */
async function handleDeviceStart(env) {
  const res = await fetch("https://github.com/login/device/code", {
    method: "POST",
    headers: { "Accept": "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: cfg(env, "GITHUB_CLIENT_ID"), scope: "public_repo" }),
  });
  const d = await res.json();
  if (d.error) return json(env, { error: d.error_description || d.error }, 400);
  return json(env, {
    device_code: d.device_code,
    user_code: d.user_code,
    verification_uri: d.verification_uri,
    interval: d.interval || 5,
    expires_in: d.expires_in || 900,
  });
}

async function handleDevicePoll(request, env) {
  let body;
  try { body = await request.json(); }
  catch (e) { return json(env, { error: "Bad request body" }, 400); }
  if (!body.device_code) return json(env, { error: "No device code" }, 400);

  const res = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { "Accept": "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: cfg(env, "GITHUB_CLIENT_ID"),
      device_code: body.device_code,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }),
  });
  const d = await res.json();

  // Still waiting on the person to type the code - not an error.
  if (d.error === "authorization_pending") return json(env, { pending: true });
  if (d.error === "slow_down") return json(env, { pending: true, interval: d.interval || 10 });
  if (d.error) return json(env, { error: d.error_description || d.error }, 400);
  if (!d.access_token) return json(env, { error: "GitHub sent no token" }, 400);

  // Check the account before handing the token back to the page.
  const who = await fetch("https://api.github.com/user", {
    headers: {
      "Authorization": "Bearer " + d.access_token,
      "Accept": "application/vnd.github+json",
      "User-Agent": "star-electric-tender-tracker",
    },
  });
  if (!who.ok) return json(env, { error: "Could not read the GitHub account" }, 400);
  const user = await who.json();

  const allowed = String(cfg(env, "ALLOWED_LOGINS") || "")
    .split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
  if (allowed.length && allowed.indexOf(String(user.login).toLowerCase()) < 0) {
    return json(env, { error: user.login + " is not allowed to edit this tracker" }, 403);
  }
  return json(env, { access_token: d.access_token, login: user.login });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors(env) });
    }
    if (url.pathname === "/login")    return handleLogin(url, env);
    if (url.pathname === "/callback") return handleCallback(url, env);
    if (url.pathname === "/commit" && request.method === "POST") {
      return handleCommit(request, env);
    }
    if (url.pathname === "/me") {
      const s = await sessionFrom(request, env);
      return json(env, s ? { login: s.login, exp: s.exp } : { login: null },
                  s ? 200 : 401);
    }
    if (url.pathname === "/device/start" && request.method === "POST") {
      return handleDeviceStart(env);
    }
    if (url.pathname === "/device/poll" && request.method === "POST") {
      return handleDevicePoll(request, env);
    }
    if (url.pathname === "/") {
      return json(env, { service: "star-electric-tender-tracker", ok: true });
    }
    return json(env, { error: "Not found" }, 404);
  },
};
