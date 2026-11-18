# Beginner's guide: database, configuration and deployment

This guide takes you from "I have the code" to "my Worker is running on Cloudflare with its own database, storage and
secrets". It assumes you have never used Cloudflare Workers before. Read Parts 1–2 once, then follow Parts 3–10 in
order. Every command is meant to be run from the **`worker-api/`** folder unless it says otherwise.

> **What was tested, and what was not.** Part 3 (running locally) and the checks in Part 9 were rehearsed on this
> repository with real `wrangler` and the real Worker runtime. The commands that create things on **your Cloudflare
> account** (Parts 5–8) are standard `wrangler` commands but have **not** been run against your account by anyone yet.
> Run them one at a time, read what each prints, and stop if something looks different from this guide.

---

## Part 1 — The big picture

Your backend ("the Worker") is one small program that Cloudflare runs for you. It needs a few other things around it:

| Piece | What it is | In this project |
|---|---|---|
| **Worker** | The program itself (`src/`). Cloudflare runs it; you don't manage a server. | `zb-product-personalizer-api-<env>` |
| **D1 database** | A small SQL database (SQLite) that belongs to one Worker. Stores configurations, mappings, customizations, orders. | `zb-product-personalizer-db-<env>` |
| **Migration** | A `.sql` file that creates the tables inside the database. Run once per database. | `migrations/0001_baseline.sql` (the only one) |
| **R2 bucket** | File storage (like a folder in the cloud) for images customers upload. | `zb-personalization-assets-<env>` |
| **Vars** | Settings that are *not* secret (URLs, limits). Live in `wrangler.jsonc`. | e.g. `ZB_PLUGIN_ID`, `CORS_ALLOWED_ORIGINS` |
| **Secrets** | Settings that **must stay private** (passwords, keys). Stored encrypted by Cloudflare, never in files you commit. | `ZB_PLUGIN_SECRET`, `ASSET_SIGNING_SECRET`, storage keys |
| **Environment** | A complete separate copy of all of the above: `dev`, `staging`, `production`. | the `--env` flag |

The flow you will follow:

```
 your computer ──(1) test locally──▶ works?
        │
        ├─(2) create the D1 database ─▶ (3) create its tables with the migration
        ├─(4) create the R2 bucket   ─▶ (5) set vars + secrets
        └─(6) deploy the Worker ─────▶ (7) check it is healthy ─▶ (8) connect the apps
```

### How login works (so the secrets make sense)

ZenBasket (your main platform) and this Worker share **one secret**, `ZB_PLUGIN_SECRET`. ZenBasket uses it to sign
(a) the login token a merchant's browser sends and (b) the order notifications it sends to the Worker. The Worker uses
the same secret to check those signatures. There is **no** shortcut password, no test mode that skips this, and no
"default" secret: if the secret is not set, the Worker refuses everything. That is on purpose.

---

## Part 2 — Words and safety rules

**Rules that keep you out of trouble**

1. **Never put a secret in a file that goes to git.** Secrets go in `.dev.vars` (your computer only, git ignores it)
   or in `wrangler secret put` (Cloudflare). If you ever paste a secret into chat, an email or a commit, treat it as
   leaked and make a new one.
2. **Every remote command carries `--env <name>`.** Without it you may touch the wrong environment. `dev` is for
   experiments. Do not use `--env staging` or `--env production` until you are ready for them.
3. **A resource called "staging" is not a scratch copy.** Do not delete or reset it just because the project is still
   being built. Ask first.
4. **Deleting a D1 database is permanent.** Create the new one first, check it works, delete the old one last.
5. **Never edit `0001_baseline.sql` once a database you want to keep exists.** Add a new numbered file instead
   (Part 10).
6. **`--local` means "only on my computer"; `--remote` means "on Cloudflare, for real".** Read that flag every time.

**Glossary**

- **`wrangler`** — Cloudflare's command-line tool. You run it with `npx wrangler …` (no install needed).
- **`wrangler.jsonc`** — the project's configuration file: which database, which bucket, which vars, per environment.
- **`.dev.vars`** — a file on *your computer* holding secrets for local runs. Never committed.
- **`database_id`** — the unique ID Cloudflare gives a database. Not secret, but specific to one environment.
- **Binding** — the name the code uses to reach a resource (`DB` for the database, `PERSONALIZATION_ASSETS` for the bucket).

---

## Part 3 — Set up your computer and run everything locally first

Running locally costs nothing, touches nothing on Cloudflare, and proves the code works before you deploy it.

### 3.1 Install the tools

You need **Node.js 20 or newer** (the project is checked with Node 24) and **npm**. Check:

```bash
node --version      # v20.x or higher
npm --version
```

Then install the project's packages (once):

```bash
cd worker-api
npm install
```

### 3.2 Create your local settings file

```bash
cp .dev.vars.example .dev.vars
```

Open `.dev.vars` in an editor and fill in these three lines (the file explains each one):

```
ZB_PLUGIN_SECRET=<any random text, at least 32 characters>
ZB_PLUGIN_ID=160
ASSET_SIGNING_SECRET=<another random text>
```

A quick way to make random values (Linux/macOS/Git-Bash):

```bash
openssl rand -hex 32        # prints 64 random characters; run it twice, once per secret
```

`ZB_PLUGIN_ID` is just a number that must match the `pluginId` inside your test tokens. `160` is fine locally.
(Leave the `AWS_…` lines as placeholders; the local setup below does not use them.)

### 3.3 Create the local database tables

```bash
# If you have run this project on this computer before, clear the old local data ONCE.
# This deletes only local test data (a folder on your computer), nothing on Cloudflare:
rm -rf .wrangler/state

npx wrangler d1 migrations apply DB --env dev --local
```

You should see `0001_baseline.sql ✅`. If instead it says *"No migrations to apply"* right after a fresh start,
you skipped the `rm -rf` and an older local database is still there; run the `rm -rf` and apply again.

> **Why `--env dev --local`?** Each environment has its own database, and "local" has its own copy of each. Using the
> same `--env dev` for both the migration and the run (next step) makes sure they talk to the *same* local database.
> (Using the plain `npm run migrate` script fills a *different* local copy, which is the usual beginner trap.)

### 3.4 Start the Worker

```bash
npx wrangler dev --env dev
```

Leave it running; it listens on `http://localhost:8787`. Open a **second terminal** (also in `worker-api/`) for the
next steps.

### 3.5 Check it is alive

```bash
curl http://localhost:8787/api/v1/health
```

Expected: JSON containing `"status":"ok"` and `"database":"ok"`.

### 3.6 Make a login token and call the API as a merchant

The Worker has no shortcut login, so you make a *real* signed token with the helper script. It reads
`.dev.vars` and never prints your secret:

```bash
TOKEN=$(npm run -s dev:token -- --store 766)      # 766 = any store id you like

# Without a token: refused (401)
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8787/api/v1/plugins/personalization/configs
# With a token: allowed (200)
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $TOKEN" \
  http://localhost:8787/api/v1/plugins/personalization/configs
```

Expected: `401` then `200`. The token lasts one hour; run `dev:token` again when it expires.

### 3.7 (Optional) Send a signed order notification

This imitates ZenBasket telling the Worker "order confirmed". It needs a saved customization, so the complete
copy-paste sequence is in Part 9. You can skip it now and do it after deploying.

### 3.8 Run the automated tests

```bash
npm run typecheck
npm test            # takes about 3 minutes
```

All tests should pass. They use their own temporary databases and never touch Cloudflare.

---

## Part 4 — Know your environments before you create anything

Open `wrangler.jsonc`. It has one block per environment. **Wrangler does not copy settings from the top of the
file into an environment**, so each block lists everything that environment needs.

| `--env` | Worker name | Database | Bucket | Status in this repo |
|---|---|---|---|---|
| `dev` | `zb-product-personalizer-api-dev` | `zb-product-personalizer-db-dev` | `zb-personalization-assets-dev` | already exists on the account |
| `staging` | `zb-product-personalizer-api-staging` | `zb-product-personalizer-db-staging` | none (uses AWS S3) | database exists with an **old schema**; Worker never deployed |
| `production` | `zb-product-personalizer-api-production` | `…-db-production` | `zb-personalization-assets-production` | **nothing created**; ids are placeholders |

> **Starting point for you:** use **`dev`**. If the dev database and Worker already exist and you want a *clean* one,
> follow [fresh-dev-environment.md](fresh-dev-environment.md), which is the careful "replace it" version of Parts 5–9
> and is the safest order for deleting the old one. If you are creating a brand-new environment from nothing, continue
> here and use new names.

Log in to Cloudflare once, and confirm which account you are on:

```bash
npx wrangler login          # opens a browser; click Allow
npx wrangler whoami         # shows your account name and Account ID
```

Look at what already exists (these only **read**):

```bash
npx wrangler d1 list
npx wrangler r2 bucket list
```

---

## Part 5 — Create the database and its tables (remote)

### 5.1 Create the empty database

Pick a name. For a brand-new environment use the pattern `zb-product-personalizer-db-<env>`. (If that name is already
taken, D1 will say so; add a suffix like `-v2`.)

```bash
npx wrangler d1 create zb-product-personalizer-db-dev-v2
```

It prints a `database_id` (a long code with dashes). **Copy it.** If wrangler offers to add the binding to your config
automatically, answer **no**; you will do it by hand so you can see exactly what changes.

### 5.2 Tell the project to use it

In `wrangler.jsonc`, find the block for your environment (`env.dev`) and replace its `d1_databases` entry:

```jsonc
"d1_databases": [
  {
    "binding": "DB",                                   // keep this exactly: the code looks for "DB"
    "database_name": "zb-product-personalizer-db-dev-v2",
    "database_id": "PASTE-THE-ID-FROM-STEP-5.1"
  }
],
```

Change **only** your environment's block, not the others.

### 5.3 Create the tables (the migration)

```bash
npx wrangler d1 migrations apply DB --env dev --remote
```

Wrangler asks "continue? (y/N)": type `y`. You should see `0001_baseline.sql ✅`.

Check it worked (this only reads):

```bash
npx wrangler d1 execute DB --env dev --remote \
  --command "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
```

You should see these 14 tables (plus wrangler's own `d1_migrations`):
`assets, audit_logs, cleanup_runs, config_versions, configs, customization_assets, customizations,
integration_events, mappings, markups, order_details, order_links, store_settings, uploads`.

There must be **no** table called `integration_credentials` (the old per-store-secret design is gone).

> **What a migration is, in one line:** a numbered SQL file that has been applied to a database once. Wrangler remembers
> which ones ran (in a table called `d1_migrations`), so running the command again does nothing harmful.

---

## Part 6 — Storage for customer files (R2)

Customers upload images; those files live in an R2 bucket (private by default). Skip this part if the bucket for your
environment already exists (`dev` does).

### 6.1 Create the bucket

```bash
npx wrangler r2 bucket create zb-personalization-assets-<env>
```

(If R2 is not enabled on the account, wrangler says so; enable it in the Cloudflare dashboard → R2 first.)

### 6.2 Bind it in `wrangler.jsonc`

Inside your environment block:

```jsonc
"r2_buckets": [
  { "binding": "PERSONALIZATION_ASSETS", "bucket_name": "zb-personalization-assets-<env>" }
],
```

### 6.3 Create access keys so browsers can upload directly

The browser uploads straight to R2 using short-lived signed links; the Worker needs R2 keys to make those links.

1. Cloudflare dashboard → **R2** → **Manage API tokens** → create a token with **Object Read & Write**, scoped to
   **only this bucket**.
2. Copy the **Access Key ID** and **Secret Access Key** (shown once).
3. Your **Account ID** is in `npx wrangler whoami`.

You will store these in Part 7.

### 6.4 Allow browsers to talk to the bucket (CORS), once per bucket

Create a file `r2-cors.json` **outside the repository** (it is not secret, but it is one-off):

```json
{ "rules": [{
    "allowed": { "origins": ["*"], "methods": ["PUT", "GET", "HEAD"], "headers": ["content-type"] },
    "exposeHeaders": ["ETag"],
    "maxAgeSeconds": 3600
}] }
```

```bash
npx wrangler r2 bucket cors set zb-personalization-assets-<env> --file r2-cors.json
```

A wildcard is acceptable here because the bucket stays **private**; the details are in
[direct-uploads.md](direct-uploads.md) ("Why a wildcard origin is acceptable").

---

## Part 7 — Configuration: vars (public) and secrets (private)

This is the part people get wrong, so take it slowly. There are exactly two places for settings:

| Kind | Where it goes | How it gets there |
|---|---|---|
| **Var** (not secret) | `wrangler.jsonc` → your environment → `"vars"` | edit the file, then **deploy** |
| **Secret** (private) | Cloudflare's encrypted store | `npx wrangler secret put NAME --env <env>` (takes effect without editing files) |

A setting lives in **one** place, never both. Never put a secret in `wrangler.jsonc`.

### 7.1 Vars: edit `wrangler.jsonc`

For `env.dev`, `"vars"` should contain (check what is already there; most are):

| Var | What to put | Why |
|---|---|---|
| `ENVIRONMENT` | `"development"` / `"staging"` / `"production"` | label used in logs and `/health` |
| `API_VERSION` | `"v1"` | part of the URL |
| **`ZB_PLUGIN_ID`** | **ZenBasket's id for this plugin** (a number as text, e.g. `"160"`) | merchant tokens must carry this id. **Empty = every merchant call is refused.** |
| `CORS_ALLOWED_ORIGINS` | comma-separated web addresses allowed to call the merchant API, e.g. `http://localhost:4200,https://admin.example.com` | browsers block other sites |
| `STORAGE_DRIVER` | `"r2"` (or `"s3"` for AWS) | where files go |
| `R2_BUCKET_NAME` | your bucket's name | needed to make upload links |
| `BUNDLED_ASSET_BASE_URL` | public address of the element's `assets/` folder, ending in `/assets/` | fonts and sample images that ship with the editor |
| `MAX_UPLOAD_BYTES`, `LOG_LEVEL`, … | leave the defaults | limits and logging |

Where does the real `ZB_PLUGIN_ID` come from? From ZenBasket, when this plugin is registered on its Plugin
Platform. Ask the ZenBasket team for the id **for the environment you are building** (dev, staging and production
each have their own).

`R2_ACCOUNT_ID` (your Account ID from step 6.3) must also be set, but in **one** place only. On the existing dev Worker
it is already stored as a *secret*, so leave it as a secret there. For a new environment you may instead add it as a var.

### 7.2 Secrets: store them in Cloudflare

Each command asks you to paste (or pipes in) the value. It never appears on the command line:

```bash
# 1. The plugin secret. Use the value ZenBasket generated for THIS environment's registration.
#    (If ZenBasket has none yet, make one and give it to the ZenBasket team through your password manager.)
SECRET="$(openssl rand -hex 32)"
printf '%s' "$SECRET" | npx wrangler secret put ZB_PLUGIN_SECRET --env dev

# 2. The key that signs asset (image) links saved in configurations. Any new random value.
openssl rand -hex 32 | npx wrangler secret put ASSET_SIGNING_SECRET --env dev

# 3. R2 upload keys from step 6.3 (it prompts; paste each one)
npx wrangler secret put R2_ACCESS_KEY_ID     --env dev
npx wrangler secret put R2_SECRET_ACCESS_KEY --env dev
```

Keep `$SECRET` in your terminal only until Part 9, then run `unset SECRET`. Do not print it.

See what is stored (names only, never values):

```bash
npx wrangler secret list --env dev
```

### 7.3 The complete checklist for one environment

| Setting | Kind | Required? | Missing means |
|---|---|---|---|
| `ZB_PLUGIN_SECRET` | secret | **yes** | merchant calls → 401, order notifications → 503 |
| `ZB_PLUGIN_ID` | var | **yes** | merchant calls → 401 |
| `ASSET_SIGNING_SECRET` | secret | yes, if configs are edited | image links are unsigned, so draft images don't load in the editor |
| `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_ACCOUNT_ID` | secret | yes for direct uploads on R2 | uploads fall back to the slower proxied route |
| `CORS_ALLOWED_ORIGINS` | var | yes | browser apps get blocked |
| `R2_BUCKET_NAME`, `STORAGE_DRIVER` | var | yes | files can't be stored |

**Do not create** `JWT_SIGNING_SECRET`, `INTEGRATION_ENCRYPTION_KEY`, `CUSTOMIZATION_TOKEN_SECRET`,
`ZB_PLUGIN_SECRET_PREVIOUS`, `ZB_JWT_KEY_MODE` or any `DEV_*` setting. They no longer exist; nothing reads them.

---

## Part 8 — Deploy

### 8.1 Preview first (changes nothing)

```bash
npx wrangler deploy --env dev --dry-run
```

It builds the Worker on your computer and lists the bindings it *would* get. Check that it shows your database
(`env.DB (zb-product-personalizer-db-dev-v2)`), your bucket, and `ZB_PLUGIN_ID` with the value you expect. A warning
about `S3_BUCKET` / `S3_REGION` not being in `env.dev.vars` is expected for `dev` (it uses R2, not S3).

### 8.2 Deploy for real

```bash
npm run deploy:dev            # same as: wrangler deploy --env dev
```

The first time on an account, wrangler may ask you to choose a `workers.dev` name; accept the suggestion. At the end it
prints your Worker's address:

```
https://zb-product-personalizer-api-dev.<your-name>.workers.dev
```

Save it; below it is called `$WORKER_URL`:

```bash
WORKER_URL=https://zb-product-personalizer-api-dev.<your-name>.workers.dev
```

(`deploy:staging` and `deploy:production` exist for the other environments; see Part 11 before using them.)

---

## Part 9 — Check that the deployed Worker really works

Run these in order. Each line says what a good answer looks like.

### 9.1 Is it alive, and can it reach its database?

```bash
curl -s $WORKER_URL/api/v1/health            # "status":"ok", "database":"ok"
```

### 9.2 Can a merchant log in?

The helper reads your `.dev.vars` by default; for a deployed Worker, give it the deployed environment's values
explicitly (they take priority over the file):

```bash
export ZB_PLUGIN_SECRET="$SECRET"            # the value you stored in step 7.2
export ZB_PLUGIN_ID=160                      # the SAME value as the ZB_PLUGIN_ID var you set
API=$WORKER_URL/api/v1
TOKEN=$(npm run -s dev:token -- --store 766)

curl -s -o /dev/null -w '%{http_code}\n' $API/plugins/personalization/configs                                   # 401 (no token)
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $TOKEN" $API/plugins/personalization/configs  # 200
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $(npm run -s dev:token -- --store 766 --plugin 999)" \
  $API/plugins/personalization/configs                                                                           # 401 (wrong plugin)
```

### 9.3 Create some real data (a product design, a mapping, a customer's saved design)

```bash
AUTH="Authorization: Bearer $TOKEN"
cat > /tmp/zb-draft.json <<'EOF'
{"clientConfigId":"cfg-fresh1","draft":{"schemaVersion":2,"id":"cfg-fresh1","version":1,"status":"draft",
 "product":{"id":"product-fresh1","name":"Fresh Tee"},"assetBaseUrl":"assets/",
 "variants":[{"id":"default","label":"Default","mockupIds":[],"printableAreaIds":[]}],
 "mockups":[{"id":"m1","name":"Front","src":"https://cdn.test/m1.png","placements":[]}],
 "printableAreas":[{"id":"a1","name":"Front","enabled":true,"canvas":{"width":100,"height":100},"shape":{"type":"rect"},"artworkId":"art1","artworkIds":["art1"]}],
 "artworks":[{"id":"art1","name":"Design","printableAreaId":"a1","layers":[]}],"fonts":[],"fields":[]}}
EOF
curl -s -X POST -H "$AUTH" -H 'Content-Type: application/json' --data @/tmp/zb-draft.json $API/plugins/personalization/configs                    # 201 created
curl -s -X POST -H "$AUTH" $API/plugins/personalization/configs/cfg-fresh1/publish                                                                # 200 published
curl -s -X POST -H "$AUTH" -H 'Content-Type: application/json' -d '{"configId":"cfg-fresh1","scope":"product","externalId":"p-1"}' $API/plugins/personalization/mappings   # 201 mapped

# A shopper (no login needed) saves a design for that product:
CFG=$(curl -s "$API/storefront/personalization/products/p-1/config?storeId=766")
CFGID=$(echo "$CFG" | python3 -c 'import sys,json; print(json.load(sys.stdin)["data"]["configId"])')
CFGVER=$(echo "$CFG" | python3 -c 'import sys,json; print(json.load(sys.stdin)["data"]["version"])')
CUST=$(curl -s -X POST -H 'Content-Type: application/json' \
  -d "{\"productId\":\"p-1\",\"configId\":\"$CFGID\",\"configVersion\":$CFGVER,\"data\":{},\"assets\":[]}" \
  "$API/storefront/personalization/customizations?storeId=766" | python3 -c 'import sys,json; print(json.load(sys.stdin)["data"]["customizationId"])')
echo "customization id: $CUST"
```

### 9.4 Does an order notification from "ZenBasket" work?

`dev:event` signs a real `order.confirmed` message and sends it:

```bash
npm run -s dev:event -- --url $WORKER_URL --store 766 --customization $CUST --product p-1 \
  --event-id evt-1 --order ORD-1 --occurred-at 2026-11-18T10:00:00.000Z
# HTTP 200 ... "duplicate":false ... "status":"applied"      ← the design is now linked to the order

# Sending the IDENTICAL message again is safe (a retry, not a second order):
npm run -s dev:event -- --url $WORKER_URL --store 766 --customization $CUST --product p-1 \
  --event-id evt-1 --order ORD-1 --occurred-at 2026-11-18T10:00:00.000Z
# HTTP 200 ... "duplicate":true

# A store the Worker has never seen is refused:
npm run -s dev:event -- --url $WORKER_URL --store 999 --customization $CUST --product p-1
# HTTP 403 ... "store_not_authorized"
```

When you are done, clear the secret from your terminal: `unset SECRET ZB_PLUGIN_SECRET`.

If all of 9.1–9.4 behave as shown, your database, secrets, storage binding and deployment are working.

---

## Part 10 — Everyday tasks after the first deployment

| I want to… | Do this |
|---|---|
| **Change code** and publish it | `npm run typecheck && npm test`, then `npm run deploy:dev` |
| **Change a var** (e.g. `CORS_ALLOWED_ORIGINS`) | edit `wrangler.jsonc`, then `npm run deploy:dev` |
| **Change a secret** | `npx wrangler secret put NAME --env dev` (no file edit; takes effect on the next request) |
| **Watch live logs** | `npx wrangler tail --env dev` |
| **Undo a bad deploy** | `npx wrangler rollback --env dev` (code only; the database is not rolled back) |
| **Change the database structure** | add a **new** migration file, see below |
| **Rotate `ZB_PLUGIN_SECRET`** | pause ZenBasket's order notifications, `secret put` the new value, switch ZenBasket to it, resume. There is no overlap period: anything signed with the old secret after the swap is refused. |

### Changing the database structure (adding a migration)

Once a database you want to keep exists, **do not edit `0001_baseline.sql`**. Wrangler would not re-apply it and your
database would silently differ from the code. Instead:

1. Create `migrations/0002_describe_the_change.sql` (the next number) containing only the change, e.g.
   `ALTER TABLE configs ADD COLUMN note TEXT;`.
2. Test it locally on a copy: `rm -rf .wrangler/state`, then `npx wrangler d1 migrations apply DB --env dev --local`.
3. Update the tests (`test/schema.test.ts` lists the expected tables and indexes).
4. **Apply the migration before deploying code that needs it:**
   `npx wrangler d1 migrations apply DB --env dev --remote`, then `npm run deploy:dev`.
5. To undo a change, write another migration that reverses it. Don't edit the old one.

---

## Part 11 — Staging and production (later, deliberately)

Do these only after `dev` works and you have the ZenBasket values for each environment.

1. **Each environment is created separately**: its own D1 database, bucket, secrets and `ZB_PLUGIN_ID`. Repeat Parts
   5–8 with `--env staging` / `--env production` and fresh names. **Never** reuse dev's database, bucket or secrets.
2. **Production has placeholders today.** In `wrangler.jsonc`, `env.production.d1_databases[0].database_id` is
   `00000000-0000-0000-0000-000000000000` and `ZB_PLUGIN_ID` is empty. Replace both before any production command.
3. **The existing staging database has an old schema** (created before the baseline was rebuilt). Don't deploy to it:
   either create a new staging database (Part 5) or ask for a decision on that one first.
4. Copy **every** var from the `dev` block into the new block and change what differs (origins, bucket, plugin id,
   `ENVIRONMENT`, `LOG_LEVEL`). Remember: nothing is inherited.
5. Order every time: **database → migration → storage → secrets → `--dry-run` → deploy → Part 9 checks.**
6. Production extras: set Cloudflare rate-limiting rules (the in-Worker limiter is best-effort), and point
   `BUNDLED_ASSET_BASE_URL` at a real public address.

---

## Part 12 — Connecting the apps to the Worker

- **Angular admin / storefront elements** need the Worker address: set `apiBaseUrl` to `$WORKER_URL`
  (`window.__ZB_PERSONALIZER__ = { apiBaseUrl: '…', authToken: '…', persistence: 'cloud' }`, see the main README).
- **The merchant token (`authToken`)** is issued by **ZenBasket** (signed with the plugin secret, containing
  `storeId`, `pluginId`, `iat`, `exp`). On your own computer you can paste one from `npm run dev:token`.
- **The website's address must be in `CORS_ALLOWED_ORIGINS`**, or the browser blocks the calls (Part 7.1).
- **ZenBasket's order notifications** go to
  `$WORKER_URL/api/v1/integrations/personalization/events`, signed as described in
  [zenbasket-integration.md](zenbasket-integration.md) §4 (there is a ready Node.js signing example). Give the ZenBasket
  team that document.

---

## Part 13 — When something goes wrong

| What you see | Most likely cause | Fix |
|---|---|---|
| Merchant call → **401** `Authentication is not configured on this environment` | `ZB_PLUGIN_SECRET` missing/too short (needs ≥ 32 chars) **or** `ZB_PLUGIN_ID` empty | `npx wrangler secret list --env <env>`; set the secret; fill `ZB_PLUGIN_ID` in `wrangler.jsonc` and redeploy |
| **401** `Token was not issued for this plugin` | the token's `pluginId` ≠ the Worker's `ZB_PLUGIN_ID` | use the same id on both sides |
| **401** `Invalid token: bad signature` | token signed with a different secret than the Worker has | sign with the environment's real `ZB_PLUGIN_SECRET` |
| **401** `token expired` / `has no expiry` / `has no issue time` | tokens must carry `iat` and `exp` and last a short time | make a fresh token (`npm run dev:token`) |
| Order notification → **503** `integrations_not_configured` | `ZB_PLUGIN_SECRET` not set on that Worker | `secret put ZB_PLUGIN_SECRET --env <env>` |
| Order notification → **401** `invalid_timestamp` | clock skew over 5 minutes, or the message is old | fix the sender's clock; sign again on each attempt |
| Order notification → **401** `signature is not valid` | wrong secret, or the sender didn't derive the webhook key | follow zenbasket-integration.md §3.3–§4.1 exactly |
| Order notification → **403** `store_not_authorized` | the store has never used the app on this Worker | the store's merchant must open the app once; a store is registered by its first authenticated request |
| Order notification → **409** `event_id_reused` | same `eventId` sent with a *different* body | retries must be byte-identical; use a new `eventId` for a corrected event |
| `no such table: …` | migration not applied to **that** database (wrong `--env`, or `--local` vs `--remote`) | re-run the `migrations apply` command with the right flags |
| `wrangler d1 migrations apply` says *No migrations to apply* on a database you expect to be empty | the database already has migration 0001 recorded (e.g. an old local copy) | locally: `rm -rf .wrangler/state` and retry; remote: check you used the new database's name/id |
| `Worker "…" not found` from `secret list` | that environment's Worker was never deployed | deploy it once, or set secrets after the first deploy |
| Browser error "blocked by CORS" | the website's address isn't in `CORS_ALLOWED_ORIGINS` (merchant API) or the bucket CORS is missing (uploads) | add the origin and redeploy; apply Part 6.4 |
| Draft images don't load in the editor | `ASSET_SIGNING_SECRET` not set | set it (existing stored image links signed with another key stop working when it changes) |
| Upload fails with `direct_upload_not_configured` | R2 keys or `R2_ACCOUNT_ID`/`R2_BUCKET_NAME` missing | Part 6.3 and 7 |
| Deploy error mentioning a binding name already in use | the same name exists as both a var and a secret | keep it in one place only |
| `/health` answers but `"database"` isn't `ok` | wrong `database_id` in `wrangler.jsonc` or migration not applied | re-check Part 5.2–5.3 |

---

## Part 14 — Command cheat sheet

```bash
# --- local (safe) ---
npm install
cp .dev.vars.example .dev.vars                                # then fill it in
rm -rf .wrangler/state                                        # reset ONLY local test data
npx wrangler d1 migrations apply DB --env dev --local         # create local tables
npx wrangler dev --env dev                                    # run at http://localhost:8787
npm run -s dev:token -- --store 766                           # real signed merchant token
npm run -s dev:event -- --store 766 --customization <uuid> --product <id>   # signed order notification
npm run typecheck && npm test

# --- Cloudflare: read-only ---
npx wrangler whoami
npx wrangler d1 list
npx wrangler r2 bucket list
npx wrangler secret list --env dev                            # names only
npx wrangler deploy --env dev --dry-run                       # preview, deploys nothing
npx wrangler tail --env dev                                   # live logs

# --- Cloudflare: creates or changes things (read the output first) ---
npx wrangler d1 create <name>
npx wrangler d1 migrations apply DB --env dev --remote
npx wrangler r2 bucket create <name>
npx wrangler secret put <NAME> --env dev
npm run deploy:dev
npx wrangler rollback --env dev

# --- permanent: ask before running ---
npx wrangler d1 delete <name>
npx wrangler secret delete <NAME> --env dev
```

## Final checklist

- [ ] Local run works (Part 3) and tests pass
- [ ] Database created, `database_id` in `wrangler.jsonc` under the right environment, 14 tables present, no `integration_credentials`
- [ ] Bucket created, bound, CORS applied, R2 keys stored
- [ ] `ZB_PLUGIN_SECRET` and `ASSET_SIGNING_SECRET` stored; `ZB_PLUGIN_ID` filled in; no obsolete settings created
- [ ] `--dry-run` showed the bindings you expected
- [ ] Deployed; Part 9 checks all behave as described
- [ ] ZenBasket has the plugin secret, the plugin id, the Worker address, and `zenbasket-integration.md`
- [ ] Nothing was run with `--env staging` or `--env production` by accident
