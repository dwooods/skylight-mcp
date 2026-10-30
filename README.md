# Skylight MCP Server

An MCP (Model Context Protocol) server for the Skylight Calendar. Lets Claude
(including Claude Duet, via the hosted mode) read and plan against your family
calendar, chores, lists, meals and rewards.

> **Unofficial.** This project is not affiliated with or endorsed by Skylight.
> Skylight has no public API; this talks to the same private endpoints their
> own apps use, discovered by observing app traffic. It can stop working or be
> blocked at any time, without notice. Use it with your own account, at your
> own risk, and keep request volume modest.
>
> Forked from [TheEagleByte/skylight-mcp](https://github.com/TheEagleByte/skylight-mcp)
> (MIT). The sign-in and credential-store design follows
> [kamilio/skylight-calendar-agent](https://github.com/kamilio/skylight-calendar-agent)
> (MIT). See `THIRD_PARTY_NOTICES.md`.

## Features

- **Calendar**: read events and connected calendars; create, update and delete events
- **Planning**: one-call week overview, overlap detection, free-slot search, bulk meal planning
- **Meals** (Plus): see, add, rename, move and delete scheduled meals; browse and edit recipes
- **Messages**: sending to specific devices, scheduling, repeating, voice notes, editing a message that was sent to specific profiles (the app's edit form does not allow changing recipients), and read-aloud (the option exists on `send_message` but was not tested live).
- **Chores and tasks**: read, create, update and delete chores; add to the task box
- **Lists**: read, create, update and delete lists and items
- **Family**: read profiles, devices and household info
- **Rewards** (Plus): read points and rewards; create, update, redeem and delete

See [What is supported](#what-is-supported) for what is tested, what is not, and
what the hosted server leaves out.

## Quick Start

### 1. Install

```bash
git clone https://github.com/dwooods/skylight-mcp.git
cd skylight-mcp && npm install && npm run build
```

### 2. Sign in (once)

```bash
node dist/index.js auth login
```

This prints a Skylight sign-in URL. Open it in your browser and sign in. The
browser bounces through `https://ourskylight.com/welcome?code=...` and on to
the Skylight home page too fast to copy. Get it from your browser history:
`Cmd-Y` (Mac) / `Ctrl-H`, search `welcome?code`, right-click the newest
Skylight result, Copy link address. Then:

```bash
node dist/index.js auth complete
```

and paste it. Your password never touches this program; only the resulting
OAuth tokens are stored, encrypted with a key in the macOS Keychain (plain
`0600` file on Linux/Windows). `auth status` and `auth logout` do what they say.

### 3. Add to your MCP client

**mcp.json:**
```json
{
  "mcpServers": {
    "skylight": {
      "command": "node",
      "args": ["/path/to/skylight-mcp/dist/index.js"],
      "env": {
        "SKYLIGHT_FRAME_ID": "your_frame_id"
      }
    }
  }
}
```

**Claude Code:**
```bash
claude mcp add skylight node /path/to/skylight-mcp/dist/index.js \
  -e SKYLIGHT_FRAME_ID=your_frame_id
```

### Instructions for AI

Copy this into your AI's custom instructions or system prompt:

> You have access to the Skylight MCP server. Skylight is a smart family calendar display that shows calendars, chores, grocery lists, meals, and rewards. Use the Skylight tools to help manage family schedules and organization.
>
> Tips:
> - Call `get_family_members` before assigning chores to get member names
> - Grocery items default to the main grocery list if no list specified
> - Dates accept "today", "tomorrow", day names, or YYYY-MM-DD format
> - Some tools (rewards, meals, photos) require Skylight Plus subscription

## Prerequisites

- Node.js 20+
- A Skylight account with an active subscription
- Your Skylight Frame ID (see [Finding your Frame ID](#finding-your-frame-id))

## Authentication

Sources are tried in this order:

1. **`SKYLIGHT_TOKEN`** - an explicit token in the environment, if set.
2. **Stored OAuth credential** (recommended) - created by `skylight-mcp auth login`
   / `auth complete`. The access token is refreshed automatically; refresh tokens
   rotate and the rotated token is persisted.
3. **`SKYLIGHT_EMAIL` + `SKYLIGHT_PASSWORD`** (deprecated) - the server replays
   Skylight's web login form itself. This works but puts your password in your
   MCP client config in plaintext. Prefer the browser sign-in above.

If none is present the server fails with instructions rather than starting.

Where the credential lives:

| Platform | Location | Protection |
|----------|----------|------------|
| macOS | `~/Library/Application Support/skylight-mcp/credential.enc.json` | AES-256-GCM; key in Keychain (`skylight-mcp.encryption-key`) |
| Linux / other | `$XDG_CONFIG_HOME/skylight-mcp/credential.json` (default `~/.config/skylight-mcp/`) | `0600` file in a `0700` directory, no encryption |

If the Keychain is unavailable on macOS the server refuses to read or write the
credential; it never silently downgrades to plaintext.

### Finding your Frame ID

The frame ID is the household identifier. The easy way: after signing in, the
Skylight web app lands on `https://ourskylight.com/my-skylight/<number>`. That
number is your frame ID. Treat it as a secret.

The hard way, if that URL doesn't appear:

1. Use a proxy tool ([Proxyman](https://proxyman.io/), [Charles](https://www.charlesproxy.com/), or [mitmproxy](https://mitmproxy.org/))
2. Capture any API request from the Skylight app
3. Look at the URL path: `/api/frames/{frameId}/...`
4. Example: `/api/frames/abc123/chores` → frame ID is `abc123`

## Configuration

| Variable | Required | Description |
|----------|----------|-------------|
| `SKYLIGHT_TOKEN` | No | Explicit API token; overrides the stored credential |
| `SKYLIGHT_AUTH_TYPE` | No | `bearer` (default) or `basic` (only with `SKYLIGHT_TOKEN`) |
| `SKYLIGHT_EMAIL` | No (deprecated) | Fallback email/password login |
| `SKYLIGHT_PASSWORD` | No (deprecated) | Fallback email/password login |
| `SKYLIGHT_FRAME_ID` | Yes | Your household frame ID |
| `SKYLIGHT_TIMEZONE` | No | Default timezone (default: `America/New_York`) |

### Auth Notes

- The API host is pinned to `https://app.ourskylight.com`. No environment
  variable or `.env` file can redirect requests (and the bearer token) elsewhere.
- `auth logout` deletes the local credential only; Skylight has no public way to
  revoke a session, so change your password if a credential may have leaked.
- Skylight has no official API. This uses the same OAuth client the Skylight
  app uses, and it may break or be blocked at any time.

## Hosted server (Claude Duet, Claude on other devices)

The same code also runs as a remote MCP server on Cloudflare Workers, which is
how Claude Duet (and any Claude client that can't reach your Mac) connects.
One Worker is both the OAuth authorization server Claude talks to and the MCP
resource server. Signing in is the same browser-paste flow as the CLI; your
Skylight password never reaches the Worker, and the Skylight tokens are kept
encrypted in the OAuth grant, not in a database you manage.

### Which tools the hosted server exposes, and why

By default the hosted server registers **read and create/update tools only**:
no `delete_*` tools and no photo uploads. The local (stdio) server registers
everything. This is a deliberate choice, not a limitation of the Worker:

- The hosted server is what Claude Duet drives proactively, sometimes
  unattended. A misread instruction that *creates* a wrong chore is a
  nuisance; one that *deletes* a calendar event is data loss with no undo
  from Claude. Leaving deletes off the hosted path caps the worst outcome at
  "something extra to clean up".
- Photo tools are uploads the Worker has no reason to carry.

If you want full parity on the hosted server, change one line in
`src/worker/mcp.ts` and redeploy:

```ts
export const HOSTED_EFFECTS: readonly ToolEffect[] = ["read", "write", "destructive"];
```

and set `photos: true` in the same file if you also want photo uploads.
Every tool's classification lives in `src/tools/registry.ts`, so you can also
carve out a profile of your own (read-only, for example, is `["read"]`).

If you run both servers in the Claude desktop app, Claude sees two sets of
mostly duplicate tools and may use either for writes. Disable the local one
in Settings → Connectors when you do not need the delete or photo tools, or
say "use the local Skylight server" when you do.

### Deploy (once)

```bash
npm install
npx wrangler login
npx wrangler kv namespace create OAUTH_KV        # let it add the id to wrangler.jsonc
npx wrangler secret put SETUP_PASSPHRASE          # 12+ chars; required to link an account
npx wrangler deploy                               # prints the Worker's URL
npx wrangler secret put WORKER_URL                # paste that URL (origin only, no path)
npx wrangler deploy
```

`WORKER_URL` must be exactly the public origin of the Worker; every token is
bound to it. It is a secret rather than a `vars` entry so the server's
address is not published with the source.

### Connect from Claude

In Claude (or Duet) → Settings → Connectors → Add custom connector:

- Name: `Skylight`
- URL: `https://skylight-mcp.<your-subdomain>.workers.dev/mcp`

Claude opens the consent page. Enter the setup passphrase, your frame ID and
timezone, then follow the two-step Skylight sign-in and paste the redirect
URL. Connectors are shared across your Claude account, so Duet sees it too.

### What is stored where

| Thing | Where | Protection |
|---|---|---|
| Skylight access + refresh tokens | OAuth grant props in `OAUTH_KV` | Encrypted by workers-oauth-provider; the key is derived from the token Claude holds, so KV alone is not enough |
| PKCE verifier during sign-in | Upstream transaction in `OAUTH_KV` | Bound to your browser by a `__Host-` cookie; single use; 10-minute TTL |
| Setup passphrase | Worker secret | Never in the repo or `wrangler.jsonc` |
| Nothing else | | The Worker has no database and no logs of tokens |

To revoke: remove the connector in Claude (revokes the grant), or
`npx wrangler kv key list --binding OAUTH_KV` and delete, or change your
Skylight password.

## What is supported

Status vocabulary, used honestly:

- **Live-tested**: run against a real Skylight frame by this project, with the result checked by reading back.
- **Inherited**: came from the upstream project and works there, but this project has not re-run it live.
- **Mocked only**: covered by this project's mocked tests; not yet run against real data.

Skylight has no public API. Everything below can break when Skylight ships a
web release, which happens without notice. The web app version and API version
last captured are recorded in the repository's build log.

| Area | What works | Hosted server (Claude Duet) | Status |
|------|------------|------------------------------|--------|
| Calendar | Read events and source calendars; create (with profiles), update, delete events | Everything except delete | Read, create and delete live-tested; update inherited |
| Planning | Week overview, conflicts, free slots, bulk meal plan | All four | Week overview live-tested; the rest mocked only |
| Meals (Plus) | Read categories and meals; create, rename, move, delete one-off meals | Everything except delete | Live-tested |
| Recipes (Plus) | Read, create, update, delete recipes; push ingredients to the grocery list | Everything except delete | Inherited |
| Messages | Read; post to everyone or to named profiles (silent by default); edit text and sender (everyone-messages only); delete | All four, delete included | Live-tested |
| Chores | Read, create, update, delete | Everything except delete | Read live-tested; writes inherited |
| Task box | Add a task | Yes | Inherited |
| Lists | Read lists and items; create, update, delete lists and items | Everything except delete | Inherited |
| Family and devices | Profiles with IDs, avatars, colours, household info, devices | Yes | Profiles live-tested; the rest inherited |
| Rewards (Plus) | Read points and rewards; create, update, redeem, unredeem, delete | Everything except delete | Inherited |
| Photos (Plus) | List albums | No | Inherited |

### Not supported

Nothing here is hidden behind a flag. It is either unavailable from Skylight or not yet captured.

- **Messages**: deleting one (Skylight offers no way), sending to specific profiles or devices, scheduling, repeating, voice notes, and read-aloud (the option exists on `send_message` but was not tested live).
- **Meals**: editing or deleting a repeating meal (it is refused, because the behaviour of changing one occurrence of a series was not captured), saving a meal to the recipe box from the edit form, and Skylight's own "Plan Meals" feature.
- **Task box**: listing, editing or completing tasks. It is create-only.
- **Profiles**: creating or editing them. Read-only.
- **Settings, account, notifications, sleep schedule, device navigation**: none of these are exposed.
- **Photos**: uploads and anything beyond listing albums.
- **Accounts with more than one frame**: the server is pinned to one frame ID.
- **Credentials**: sign-in, sign-out and token access are CLI commands (`skylight-mcp auth ...`) and are deliberately not MCP tools.

### Keeping this honest

Every tool must appear in the tables below with the effect it really has, and a
test fails if one is missing or mislabelled. When you add, change or remove a
tool, update this section in the same change.

## Available Tools

Effects: **read** changes nothing; **write** creates or edits and can be edited
again; **destructive** cannot be undone from the API. The hosted server registers
read and write only, so destructive tools exist on the local server alone.

### Planning Tools

Built for "what does the week look like and what is for dinner" questions.
One call returns calendar, chores/tasks, meals and lists, merged per day.

| Tool | Effect | Description |
|------|--------|-------------|
| `get_week_overview` | read | Per-day events, chores/tasks (status, assignee, points), meals, overdue chores, conflicts and list summaries in one compact call. Omits owner emails and calendar IDs. |
| `find_conflicts` | read | Timed events that overlap in a date range. All-day events never conflict. |
| `find_free_slots` | read | Gaps of at least N minutes inside a daily window (default 08:00 to 21:00). |
| `plan_week_meals` | write | Fill several meal slots at once. `dryRun` previews; occupied slots are skipped, never overwritten; all entries are validated before anything is written; optional grocery push for recipes. |

Times are computed in the frame's time zone, including DST changes.

### Message Tools

Messages are the notes shown on the frame (Skylight's web app calls them "nudges").

| Tool | Effect | Description |
|------|--------|-------------|
| `get_messages` | read | Messages in a date range with time, text, recipients and sender. Never returns the presigned audio URLs. |
| `send_message` | write | Post a message to the frame now, on all devices. Previews by default and posts only with `confirm: true`. Read aloud is **off** unless asked for. `to` names the profiles to send to (see `get_family_members`); omit it for everyone. Optional sender profile. Up to 300 characters. The app has no delete button, but `delete_message` removes one. |
| `update_message` | write | Edit the text (and optionally the sender) of an existing message. Only messages sent to everyone on all devices that don't repeat; others must be edited in the app. |
| `delete_message` | destructive | Delete a message. The app has no delete button; this uses `DELETE /nudges/{id}`, documented by other Skylight clients and verified on a real frame. Available on both the local and hosted servers (the one destructive tool the hosted server offers). Previews unless `confirm: true`, then reads back and reports success only if the message is gone. |

### Calendar Tools

| Tool | Effect | Description |
|------|--------|-------------|
| `get_calendar_events` | read | Events for a date range |
| `get_source_calendars` | read | Connected calendar sources (Google, iCloud, etc.) |
| `create_calendar_event` | write | Add an event. `profiles` assigns it to named family members. Local times are sent with the frame's UTC offset. |
| `update_calendar_event` | write | Change an event, including who it is assigned to (`profiles`) |
| `delete_calendar_event` | destructive | Delete an event. Local server only. |

### Chore Tools

| Tool | Effect | Description |
|------|--------|-------------|
| `get_chores` | read | Chores with optional filters (date, assignee, status) |
| `create_chore` | write | Create a chore, optionally recurring |
| `update_chore` | write | Rename, reschedule, reassign, complete or reopen a chore |
| `delete_chore` | destructive | Delete a chore. Local server only. |

### Task Tools

| Tool | Effect | Description |
|------|--------|-------------|
| `create_task` | write | Add a task to the task box (create-only; there is no list tool) |

### List Tools

| Tool | Effect | Description |
|------|--------|-------------|
| `get_lists` | read | All lists |
| `get_list_items` | read | Items in one list |
| `create_list` | write | Create a list |
| `update_list` | write | Rename or change a list |
| `create_list_item` | write | Add an item |
| `update_list_item` | write | Edit or tick off an item |
| `delete_list` | destructive | Delete a list. Local server only. |
| `delete_list_item` | destructive | Delete an item. Local server only. |

### Family Tools

| Tool | Effect | Description |
|------|--------|-------------|
| `get_family_members` | read | Family member profiles, with the IDs and names that `to` and `profiles` use |
| `get_frame_info` | read | Household/frame information |
| `get_devices` | read | Skylight devices |
| `get_avatars` | read | Available profile avatars |
| `get_colors` | read | Available profile colours |

### Meal Tools

Meals and recipes need Skylight Plus.

| Tool | Effect | Description |
|------|--------|-------------|
| `get_meal_categories` | read | Breakfast, Lunch, Dinner, Snack and their IDs |
| `get_meal_sittings` | read | Scheduled meals in a date range, with sitting IDs |
| `create_meal_sitting` | write | Schedule a meal on a date (free text or a saved recipe) |
| `update_meal_sitting` | write | Rename, re-categorise, add a note to, or move a one-off meal, by sitting ID and its current date. Repeating meals are refused. |
| `delete_meal_sitting` | destructive | Delete a one-off meal. Local server only. Previews unless `confirm: true`; reports success only when Skylight confirms the removal. |
| `get_recipes` / `get_recipe` | read | Browse saved recipes |
| `create_recipe` / `update_recipe` | write | Add or change a recipe |
| `delete_recipe` | destructive | Delete a recipe. Local server only. |
| `add_recipe_to_grocery_list` | write | Push a recipe's ingredients to the grocery list |

### Reward Tools

Rewards need Skylight Plus.

| Tool | Effect | Description |
|------|--------|-------------|
| `get_rewards` | read | Available rewards |
| `get_reward_points` | read | Reward points balance |
| `create_reward` | write | Add a reward |
| `update_reward` | write | Change a reward |
| `redeem_reward` | write | Redeem a reward, spending points |
| `unredeem_reward` | write | Undo a redemption |
| `delete_reward` | destructive | Delete a reward. Local server only. |

### Photo Tools

Needs Skylight Plus. Local server only.

| Tool | Effect | Description |
|------|--------|-------------|
| `get_albums` | read | Photo albums |

## Skylight API calls used

All calls go to `https://app.ourskylight.com/api` (pinned in code). `{f}` is the frame ID. "Live" means run against a real frame by this project; everything else came from upstream and has not been re-run. Messages and meal edit/delete send `Skylight-Api-Version: 2026-10-15`, the version the web app sends; other calls use the client default.

| Function | Calls |
|----------|-------|
| Calendar | `GET/POST /frames/{f}/calendar_events` (live), `PUT /calendar_events/{id}`, `DELETE /calendar_events/{id}` (live), `GET /frames/{f}/source_calendars` (live) |
| Messages | `GET /frames/{f}/nudges?after&before`, `POST /nudges` (everyone or `category_ids`), `PATCH /nudges/{id}`, `DELETE /nudges/{id}` (all live) |
| Meals | `GET /meals/categories`, `GET/POST /meals/sittings`, `PATCH/DELETE /meals/sittings/{id}/instances/{date}` (all live) |
| Recipes | `GET/POST /meals/recipes`, `GET/PATCH/DELETE /meals/recipes/{id}`, `POST /meals/recipes/{id}/add_to_grocery_list` |
| Profiles and family | `GET /frames/{f}/categories` (live), `GET /frames/{f}`, `GET /frames/{f}/devices`, `GET /api/avatars`, `GET /api/colors` |
| Chores and tasks | `GET/POST /frames/{f}/chores`, `PUT/DELETE /chores/{id}`, `POST /frames/{f}/task_box/items` |
| Lists | `GET/POST /lists`, `GET/PUT/DELETE /lists/{id}`, `POST /lists/{id}/list_items`, `PUT/DELETE /lists/{id}/list_items/{itemId}` |
| Rewards | `GET/POST /rewards`, `PATCH/DELETE /rewards/{id}`, `POST /rewards/{id}/redeem`, `POST /rewards/{id}/unredeem`, `GET /reward_points` |
| Photos | `GET /frames/{f}/albums` (local only) |

The planning tools make no calls of their own; they combine the calendar, chore, meal and list calls above.

## Example Queries

Once configured, you can ask Claude things like:

- "What's on my calendar today?"
- "What chores do I need to do this week?"
- "Add 'take out trash' to my chores for tomorrow"
- "What's on the grocery list?"
- "Add milk to my task list"
- "Who are the family members on Skylight?"
- "How many reward points does each person have?"

## Development

```bash
# Run in development mode (with hot reload)
npm run dev

# Build
npm run build

# Run tests
npm test

# Type check
npm run typecheck
```

## API Documentation

This MCP server is built on top of the reverse-engineered Skylight API. The API endpoints were documented using the [skylight-api](https://github.com/TheEagleByte/skylight-api) project, which converts browser network traffic (HAR files) into an OpenAPI specification.

**API Resources:**
- [Interactive API Docs (Swagger UI)](https://theeaglebyte.github.io/skylight-api/swagger.html)
- [API Reference (ReDoc)](https://theeaglebyte.github.io/skylight-api/redoc.html)
- [OpenAPI Specification](https://theeaglebyte.github.io/skylight-api/openapi/openapi.yaml)

If you discover new API endpoints or find issues with the current documentation, please contribute to the [skylight-api](https://github.com/TheEagleByte/skylight-api) repository.

## Contributing

Contributions are welcome! Here's how you can help:

1. **Fork the repository** and create a feature branch
2. **Make your changes** with clear, descriptive commits
3. **Run tests** (`npm test`) and linting (`npm run lint`) before submitting
4. **Open a pull request** with a description of your changes

### Development Setup

```bash
git clone https://github.com/TheEagleByte/skylight-mcp.git
cd skylight-mcp
npm install
npm run dev  # Start with hot reload
```

### Areas for Contribution

- Adding support for new Skylight API endpoints
- Improving error handling and edge cases
- Enhancing documentation
- Writing additional tests

## Issues & Support

- **Bug reports**: [Open an issue](https://github.com/TheEagleByte/skylight-mcp/issues/new) with steps to reproduce
- **Feature requests**: [Open an issue](https://github.com/TheEagleByte/skylight-mcp/issues/new) describing the use case
- **Questions**: [Start a discussion](https://github.com/TheEagleByte/skylight-mcp/discussions) or open an issue

Please include relevant details like your Node.js version, error messages, and configuration (with sensitive values redacted).

## License

MIT

## Disclaimer

This is an unofficial integration. The Skylight API is reverse-engineered and may change without notice. Use at your own risk.
