# Sign-in service for the Tender Tracker

The tracker is a static page, so it has nowhere safe to keep a GitHub
credential — anything in the page is readable by anyone, and the repository is
public. This Worker holds the secret instead, and hands the page a signed
session that can **only** commit to this one repository.

Deploy it once and every device just clicks **Sign in with GitHub**.

## 1. Create a GitHub OAuth app

<https://github.com/settings/developers> → **OAuth Apps** → **New OAuth App**

| Field | Value |
|---|---|
| Application name | `Star Electric Tender Tracker` |
| Homepage URL | `https://jagdeepkular-spec.github.io/star-electric-tender-tracker/` |
| Authorization callback URL | `https://<your-worker>.workers.dev/callback` (fill in after step 2, then come back and edit it) |

Generate a **client secret** and keep both it and the Client ID to hand.

## 2. Deploy the Worker

```bash
npm install -g wrangler
wrangler login
cd worker
wrangler deploy
```

`wrangler deploy` prints the Worker URL. Put that URL + `/callback` into the
OAuth app's callback field from step 1.

## 3. Add the secrets

```bash
wrangler secret put GITHUB_CLIENT_ID       # from step 1
wrangler secret put GITHUB_CLIENT_SECRET   # from step 1
wrangler secret put SESSION_SECRET         # any long random string you invent
```

## 4. Point the tracker at it

Edit `config.json` in the repository root:

```json
{ "worker_url": "https://<your-worker>.workers.dev" }
```

Commit it. The tracker now shows **Sign in with GitHub** instead of asking for
a token.

## Who can edit

`ALLOWED_LOGINS` in `wrangler.toml` lists the GitHub accounts allowed to write.
Anyone else can sign in but is refused, and told so. Add a colleague by putting
their GitHub username in that list and running `wrangler deploy` again.

## What the session can and cannot do

- It is signed with `SESSION_SECRET` and expires after 30 days.
- The Worker only writes `data.json` and `pdfs/*.pdf` in this one repository —
  any other path is refused, so a stolen session cannot touch anything else.
- The GitHub client secret never leaves the Worker.
- The page keeps the session in its own browser storage, nowhere else.

To cut everyone off, change `SESSION_SECRET` and redeploy: every existing
session stops working immediately.
