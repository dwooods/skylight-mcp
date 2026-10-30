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

- **Calendar**: Query calendar events ("What's on my calendar today?")
- **Chores**: View and create chores ("Add emptying dishwasher to chores")
- **Lists**: View grocery and to-do lists ("What's on the grocery list?")
- **Tasks**: Add items to the task box ("Add XYZ to my task list")
- **Family**: View family members and devices
- **Rewards**: Check reward points and available rewards

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

## Available Tools

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
| `send_message` | write | Post a message to everyone, on all devices, now. **Permanent: Skylight has no delete.** Previews by default and posts only with `confirm: true`. Read aloud is **off** unless asked for. Optional sender profile. Up to 300 characters. |
| `update_message` | write | Edit the text (and optionally the sender) of an existing message. Only messages sent to everyone on all devices that don't repeat; others must be edited in the app. |

Not supported yet: targeting specific profiles or devices, scheduling, repeats, voice notes.

### Calendar Tools

| Tool | Description |
|------|-------------|
| `get_calendar_events` | Get calendar events for a date range |
| `get_source_calendars` | List connected calendar sources (Google, iCloud, etc.) |

### Chore Tools

| Tool | Description |
|------|-------------|
| `get_chores` | Get chores with optional filters (date, assignee, status) |
| `create_chore` | Create a new chore with optional recurrence |

### List Tools

| Tool | Description |
|------|-------------|
| `get_lists` | Get all available lists |
| `get_list_items` | Get items from a specific list |

### Task Tools

| Tool | Description |
|------|-------------|
| `create_task` | Add a task to the task box |

### Family Tools

| Tool | Description |
|------|-------------|
| `get_family_members` | Get family member profiles |
| `get_frame_info` | Get household/frame information |
| `get_devices` | List Skylight devices |

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

| Tool | Description |
|------|-------------|
| `get_rewards` | Get available rewards |
| `get_reward_points` | Get reward points balance |

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
