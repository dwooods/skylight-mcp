# Skylight MCP Server

An MCP (Model Context Protocol) server for the Skylight Calendar API. Enables AI assistants like Claude to interact with your Skylight family calendar, chores, lists, and more.

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
browser ends up on `https://ourskylight.com/welcome?code=...` (the page may look
blank). Copy that full URL from the address bar, then:

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

- Node.js 18+
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

You still need to find your frame ID (the household identifier):

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

## Available Tools

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
