# Samport Showroom ECR — WAN with Supabase state storage

React showroom register and Node/TypeScript Samport WAN service. Terminals initiate signed HTTPS long-poll connections to the WAN routes. **Operations, queued envelopes, terminal sessions, responses, and idempotency IDs are stored in Supabase PostgreSQL**, not Render's ephemeral filesystem.

## Important deployment limitations

- The Render Free filesystem (`/tmp`) remains temporary. It holds only terminal display metadata/settings; WAN operation state is in Supabase.
- Keep this Render service at **one instance**. Long polling is managed by that instance; don't enable autoscaling without redesigning the service around a shared distributed queue/notification mechanism.
- Render Free services can spin down, and free database tiers can pause, impose quotas, or change their terms. This is suitable for integration testing, **not dependable live-payment processing**. Do not treat durable storage alone as a production-readiness guarantee.
- State that was previously written to `/tmp/showroom-ecr/wan-state.json` is not migrated into Supabase. A previously displayed/active payment operation will not reappear after switching stores. Reconcile it with terminal transaction records before another attempt.

## Create and configure Supabase

1. Create a Supabase project and wait until its database is ready.
2. Open **SQL Editor → New query**, paste the complete contents of `supabase/schema.sql` (or `schema.sql` in this project root), and run it once. This creates the state tables and secured RPC functions. Check the SQL Editor reports success.
3. In Supabase **Project Settings → API**, copy the project URL and the **service_role** secret key (newer dashboards may label it a secret/service-role key). The service-role key bypasses Row Level Security. It must be configured only on the backend and must never be put in React/Vite variables, GitHub, or a terminal.
4. In Render → your Web Service → **Environment**, add:
   - `SUPABASE_URL` = project URL, e.g. `https://your-project-ref.supabase.co` (no `/rest/v1` suffix)
   - `SUPABASE_SERVICE_ROLE_KEY` = Supabase service-role secret key
5. Save and redeploy. Startup checks the database and logs `Supabase state store connected` when ready. If it fails, inspect the Render log for the RPC name/status; verify the schema script ran and the URL/key are correct.

`DATABASE_URL` alone is not used by this app. It calls Supabase's HTTPS PostgREST RPC API using Node's built-in `fetch`, so no database-driver package is required.

## Render Free deployment

The included `render.yaml` is configured for a Free Web Service, `/tmp/showroom-ecr`, no attached disk, and the Supabase variables. It is intended as a Blueprint starting point. If the service already exists, update its environment values directly in Render; update and push `render.yaml` too if you use Blueprint sync.

Build command: `npm ci && npm run build`  
Start command: `npm start`  
Health path: `/api/health`

Set these in Render Environment (all secrets are server-side):

- `TERMINALS`: comma-separated exact terminal IDs, e.g. `23AXMD884227,2453HU830838`
- `INTEGRATION_KEY` and `TERMINAL_SECRET` if the terminals intentionally share those credentials; otherwise use `TERMINAL_<NORMALIZED_ID>_INTEGRATION_KEY` and `TERMINAL_<NORMALIZED_ID>_SECRET` for each terminal
- `WEB_USERNAME` and `WEB_PASSWORD` for browser Basic Auth
- `ADMIN_PIN` for the terminal settings page
- `DATA_DIR=/tmp/showroom-ecr` for temporary local terminal metadata
- `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` as above
- `PUBLIC_BASE_URL=https://<your-render-service>.onrender.com` (optional; Render's external URL is used if omitted)

Never put credentials in GitHub or browser code. The earlier shared file-based WAN state cannot be safely assumed recovered merely because the same `DATA_DIR` name is configured.

## Terminal endpoints

Configure each terminal according to its WAN endpoint fields. The routes are:

```text
GET  /v2/terminals/<terminal-id>/requests
POST /v2/terminals/<terminal-id>/responses
POST /v2/terminals/<terminal-id>/events
```

For terminal ID `23AXMD884227`, for example:

```text
https://<service>.onrender.com/v2/terminals/23AXMD884227/requests
https://<service>.onrender.com/v2/terminals/23AXMD884227/responses
https://<service>.onrender.com/v2/terminals/23AXMD884227/events
```

If the terminal asks for one base URL and appends its routes, use the base format its setup screen specifies. Browser visits to `/requests` are not authentication tests because they lack Samport HMAC headers.

## Local development

Requirements: Node.js 20+ and npm. Create the Supabase project and apply the schema first; configure the variables below in `.env` (do not commit it):

```env
TERMINALS=23AXMD884227,2453HU830838
INTEGRATION_KEY=...
TERMINAL_SECRET=...
WEB_USERNAME=local-test
WEB_PASSWORD=...
ADMIN_PIN=...
DATA_DIR=/tmp/showroom-ecr
SUPABASE_URL=https://your-project-ref.supabase.co
SUPABASE_SERVICE_ROLE_KEY=...
```

Then run:

```sh
npm ci
npm run dev
```

Open <http://localhost:5173>. Do not expose the development server publicly.

## Behavior and testing

- `/api/operations/*` creates an operation and its request envelope in one PostgreSQL transaction. The terminal queue is durable through Render restarts.
- The request remains queued/delivered until its matching response is accepted. Completion events update the operation result. Message/event duplicate acknowledgements are tracked per terminal in PostgreSQL.
- `/api/config` reports terminal online only after an authenticated, valid-header poll within the last two minutes.
- A 45-second long poll checks Supabase once per second for queued requests. This is intentionally straightforward for the small showroom/one-instance setup; account for provider API/database quotas.
- Payment operation IDs, requests, responses, and events are retained in the database. Protect the Supabase service-role key and restrict access to the Supabase project.
- After deployment, test one terminal with a safe showroom/test transaction and verify its request, response, and completion event are reflected in the UI before any live use.
