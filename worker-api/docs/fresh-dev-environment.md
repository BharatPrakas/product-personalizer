# Recreating the development environment from scratch

Runbook for replacing the Product Personalization **development** database and secrets with a clean set built from the
consolidated `migrations/0001_baseline.sql` and the plugin-level-secret authentication
([docs/zenbasket-integration.md](zenbasket-integration.md) §3).

> **Nothing here has been run.** These are commands for you to review. Every step is labelled:
> `READ` (only reads), `LOCAL` (touches only files on your machine), `CREATES`, `MODIFIES`, or **`DELETES`**.
> The two `DELETES` steps need your explicit go-ahead and are last. Run everything from `worker-api/`.

## 0. What is in scope — and what is not

Inventory taken from read-only `wrangler` calls and `wrangler.jsonc` on 2026-11-18. **Re-run the `READ` commands in
step 1 before acting; accounts change.**

| Resource | Where | Verdict |
|---|---|---|
| D1 `zb-product-personalizer-db-dev` (`d05823df-1c3a-448f-bc93-2599fc7a42ec`, created 2026-11-09) | `wrangler.jsonc` → `env.dev` | **In scope: replaced.** The "old disposable development database". A read-only schema query showed it has the 14 current tables plus the obsolete `integration_credentials`. Deleted only in step 9, after the new one is verified. |
| Worker `zb-product-personalizer-api-dev` (exists) | `env.dev` | **In scope: redeployed** with the new code and the new D1 binding. Same name, so the same `workers.dev` URL. |
| Its obsolete secrets `INTEGRATION_ENCRYPTION_KEY`, `CUSTOMIZATION_TOKEN_SECRET`, `JWT_SIGNING_SECRET` | dev Worker | **In scope: deleted** in step 9a (nothing reads them any more). |
| Its other secrets `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_ACCOUNT_ID` | dev Worker | **Keep.** Still used for R2 direct uploads. |
| Its secrets `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN` | dev Worker | **Keep unless you decide otherwise.** The dev environment uses the `r2` driver, so they look unused; deleting them is your call, not part of this reset. |
| R2 bucket `zb-personalization-assets-dev` | `env.dev` | **Not touched.** Objects uploaded under the old database become orphans (nothing references them). Emptying the bucket is a separate decision and is not in this runbook. |
| D1 `zb-product-personalizer-db-staging` (`91437292-f0ff-4450-a17e-f63c469518da`) | `env.staging` | **OUT OF SCOPE. Do not touch.** It is not necessarily disposable (it was used for validation and holds the schema of 2026-11-06, which predates the current baseline). Any decision about it is yours, separately. |
| Worker `zb-product-personalizer-api-staging` | `env.staging` | Does not exist (never deployed). |
| `env.production` (Worker `…-production`, D1 `…-db-production`, bucket `…-production`) | `env.production` | Does not exist. Placeholder ids only. **Never run any step below with `--env production`.** |
| S3 bucket `zb-plugins` (`env.staging`, default env) | AWS | **Not touched.** |
| Local D1/R2 state under `worker-api/.wrangler/state` | your machine | Disposable; optional step 2. |

**Rules for this runbook:** every remote command carries `--env dev`; none carries `--env staging` or `production`;
no R2/S3 object is deleted.

## 1. `READ` — pre-flight

```bash
npx wrangler whoami
npx wrangler d1 list                          # confirm the dev database id above, and that no "-v2" database exists yet
npx wrangler r2 bucket list                   # confirm the dev bucket exists (it is not changed)
npx wrangler secret list --env dev            # names only; expect the nine names in the table above
npx wrangler deploy --env dev --dry-run       # LOCAL build: shows the bindings the dev Worker WOULD get. Does not deploy.
```

Optional safety net before anything is deleted (reads the old database, writes one local file containing whatever
development data was in it — so it goes outside the repository):

```bash
npx wrangler d1 export zb-product-personalizer-db-dev --env dev --remote --output "$HOME/dev-d1-backup-2026-11-18.sql"
```

## 2. `LOCAL` — reset your local database (optional)

Only if you also want a clean local `wrangler dev` database. This deletes local files only:

```bash
rm -rf .wrangler/state            # local SQLite + local R2 emulation used by `npm run dev`
npm run migrate                   # recreates the local database from 0001_baseline.sql
```

## 3. `CREATES` — the new development D1 database

Create the new database **first** and delete the old one last (step 9): until step 9 you can abandon the whole
attempt and the dev Worker is still pointed at the old database. (This reorders your list — delete / create / update id
— purely for that rollback path. If you prefer delete-first, do step 9 here and reuse the name
`zb-product-personalizer-db-dev`; then only `database_id` changes in step 4.)

```bash
npx wrangler d1 create zb-product-personalizer-db-dev-v2        # add --location <apac|weur|eeur|enam|wnam|oc> to choose a region
# Copy the printed database_id. If wrangler asks to add the binding to your config, answer NO: step 4 does it explicitly.
```

## 4. `LOCAL` — point the dev environment at it

Edit **only** `env.dev` in `wrangler.jsonc` (never the top level, `staging` or `production`):

```jsonc
"d1_databases": [
  {
    "binding": "DB",
    "database_name": "zb-product-personalizer-db-dev-v2",
    "database_id": "<the id printed by step 3>"
  }
],
```

and set ZenBasket's plugin id for the dev platform under `env.dev.vars`:

```jsonc
"ZB_PLUGIN_ID": "<ZenBasket's id for this plugin on the dev platform>",
```

Then check what the dev Worker would now be bound to (local, nothing is deployed):

```bash
npx wrangler deploy --env dev --dry-run
```

## 5. `MODIFIES` — create the schema in the new database

```bash
npx wrangler d1 migrations apply DB --env dev --remote           # answers y/N: applies 0001_baseline.sql only
npx wrangler d1 migrations list  DB --env dev --remote           # expect: no migrations to apply
npx wrangler d1 execute DB --env dev --remote \
  --command "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
```

Expect these 14 tables (plus wrangler's own `d1_migrations`, and possibly an internal `_cf_*` table), and **no**
`integration_credentials`:
`assets, audit_logs, cleanup_runs, config_versions, configs, customization_assets, customizations, integration_events,
mappings, markups, order_details, order_links, store_settings, uploads`.

## 6. `MODIFIES` — set the new secrets on the dev Worker

`ZB_PLUGIN_SECRET` must be the value **ZenBasket's dev platform** holds for this plugin. If the dev platform has no
registration yet, generate one and hand it to the ZenBasket dev team through your secret manager (never in chat or git):

```bash
SECRET="$(openssl rand -hex 32)"                                  # or: the value ZenBasket generated
printf '%s' "$SECRET" | npx wrangler secret put ZB_PLUGIN_SECRET --env dev
openssl rand -hex 32   | npx wrangler secret put ASSET_SIGNING_SECRET --env dev
```

(`wrangler secret put` reads the value from stdin when piped, so it never appears on a command line.) Keep `$SECRET` in
your shell for step 8 only; do not echo it. ZenBasket's dev platform must now **sign merchant tokens with this secret**
and include `storeId`, `pluginId`, `iat` and `exp`, and sign order callbacks per
[zenbasket-integration.md](zenbasket-integration.md) §4.1 — until it does, only tokens you mint yourself will work.

## 7. `MODIFIES` — deploy the Worker

```bash
npm run deploy:dev            # wrangler deploy --env dev  → binds the NEW database together with the new code
```

The output prints the Worker URL (`https://zb-product-personalizer-api-dev.<your-subdomain>.workers.dev`). Use it below as
`$WORKER_URL`.

## 8. Verify

Startup and database connectivity (`READ`):

```bash
curl -s $WORKER_URL/api/v1/health            # {"data":{"status":"ok", ... "checks":{"database":"ok"}}}
```

Authenticated merchant requests. The signer is `npm run dev:token`; the environment variables below take precedence over
`.dev.vars`, and the secret is never printed:

```bash
export ZB_PLUGIN_SECRET="$SECRET" ZB_PLUGIN_ID=<the ZB_PLUGIN_ID from step 4>
API=$WORKER_URL/api/v1
TOKEN=$(npm run -s dev:token -- --store 766)

curl -s -o /dev/null -w '%{http_code}\n' $API/plugins/personalization/configs                              # 401  (no token)
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $TOKEN" $API/plugins/personalization/configs   # 200
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $(npm run -s dev:token -- --store 766 --plugin 999)" \
  $API/plugins/personalization/configs                                                                      # 401  (another plugin's token)
```

A merchant publishes and maps a product; a shopper saves a customization (creates a little data in the new database):

```bash
AUTH="Authorization: Bearer $TOKEN"
cat > /tmp/zb-fresh-draft.json <<'EOF'
{"clientConfigId":"cfg-fresh1","draft":{"schemaVersion":2,"id":"cfg-fresh1","version":1,"status":"draft",
 "product":{"id":"product-fresh1","name":"Fresh Tee"},"assetBaseUrl":"assets/",
 "variants":[{"id":"default","label":"Default","mockupIds":[],"printableAreaIds":[]}],
 "mockups":[{"id":"m1","name":"Front","src":"https://cdn.test/m1.png","placements":[]}],
 "printableAreas":[{"id":"a1","name":"Front","enabled":true,"canvas":{"width":100,"height":100},"shape":{"type":"rect"},"artworkId":"art1","artworkIds":["art1"]}],
 "artworks":[{"id":"art1","name":"Design","printableAreaId":"a1","layers":[]}],"fonts":[],"fields":[]}}
EOF
curl -s -X POST -H "$AUTH" -H 'Content-Type: application/json' --data @/tmp/zb-fresh-draft.json $API/plugins/personalization/configs      # 201
curl -s -X POST -H "$AUTH" $API/plugins/personalization/configs/cfg-fresh1/publish                                                         # 200
curl -s -X POST -H "$AUTH" -H 'Content-Type: application/json' -d '{"configId":"cfg-fresh1","scope":"product","externalId":"p-1"}' $API/plugins/personalization/mappings   # 201

CFG=$(curl -s "$API/storefront/personalization/products/p-1/config?storeId=766")
CFGID=$(echo "$CFG" | python3 -c 'import sys,json; print(json.load(sys.stdin)["data"]["configId"])')
CFGVER=$(echo "$CFG" | python3 -c 'import sys,json; print(json.load(sys.stdin)["data"]["version"])')
CUST=$(curl -s -X POST -H 'Content-Type: application/json' \
  -d "{\"productId\":\"p-1\",\"configId\":\"$CFGID\",\"configVersion\":$CFGVER,\"data\":{},\"assets\":[]}" \
  "$API/storefront/personalization/customizations?storeId=766" | python3 -c 'import sys,json; print(json.load(sys.stdin)["data"]["customizationId"])')
```

A signed `order.confirmed` callback (the same endpoint and event name ZenBasket uses):

```bash
npm run -s dev:event -- --url $WORKER_URL --store 766 --customization $CUST --product p-1 \
  --event-id evt-fresh-1 --order ORD-F1 --occurred-at 2026-11-18T10:00:00.000Z
# HTTP 200 … "duplicate":false … "status":"applied"

# The identical retry is a replay, not a second link:
npm run -s dev:event -- --url $WORKER_URL --store 766 --customization $CUST --product p-1 \
  --event-id evt-fresh-1 --order ORD-F1 --occurred-at 2026-11-18T10:00:00.000Z
# HTTP 200 … "duplicate":true

# An unknown store is refused (nothing is written):
npm run -s dev:event -- --url $WORKER_URL --store 999 --customization $CUST --product p-1
# HTTP 403 … "store_not_authorized"
```

Then remove the secret from your shell: `unset SECRET ZB_PLUGIN_SECRET`.

If any check fails, stop: the old database and the old secrets are still in place, so nothing is lost. To go back, put
the old name and id back in `env.dev.d1_databases` and `npm run deploy:dev` — the new code runs on the old database
too (its schema is a superset of the new one: it only carries the unused `integration_credentials` table and
`integration_events.credential_id` column).

## 9. Clean up — **`DELETES`** (needs your explicit approval; do not run until the checks in step 8 pass)

9a. Obsolete secrets on the **dev** Worker (nothing reads them; each command asks you to confirm):

```bash
npx wrangler secret delete INTEGRATION_ENCRYPTION_KEY --env dev
npx wrangler secret delete CUSTOMIZATION_TOKEN_SECRET --env dev
npx wrangler secret delete JWT_SIGNING_SECRET --env dev
```

9b. The old development database (irreversible; take the optional export in step 1 first if you want one):

```bash
npx wrangler d1 delete zb-product-personalizer-db-dev
```

Nothing else is deleted by this runbook: no R2 or S3 object or bucket, no staging or production resource.

## Afterwards

* Commit the `wrangler.jsonc` change (new database name/id, `ZB_PLUGIN_ID`) together with the code when you are ready —
  the database id is environment-specific but not a secret.
* The R2 bucket still holds files uploaded under the old database. They are unreferenced; remove them only if you decide to.
* `AGENTS.md` still says the baseline had a single one-time reset; this is a second one. Say if you want that line updated.
