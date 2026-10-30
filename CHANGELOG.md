# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Live test suite** (`npm run test:live`, development only). Real tools against a
  real frame, to catch drift in Skylight's undocumented API that mocked tests
  cannot see. Off unless `SKYLIGHT_LIVE=1`, never part of `npm test` or CI, and
  the harness refuses `send_message` and `update_message`. One suite per file in
  `tests/live/`, filterable by tag. First suites: read smoke checks,
  response-shape contract checks, write guards and a meal
  create/rename/move/delete round trip with guaranteed cleanup. A normal-suite
  test checks that every live file is gated.

## [1.5.0] - 2026-10-30

### Added

- **Meals**: `update_meal_sitting` (write) renames or moves a scheduled meal, or
  changes its note or category, and `delete_meal_sitting` (destructive, local
  server only) removes one. Both use the web app's own calls:
  `PATCH` and `DELETE` on `/meals/sittings/{id}/instances/{date}`, sent with the
  newer `Skylight-Api-Version` (`2026-10-15`). The edit sends the whole form, with
  unchanged fields read back first. A move keeps the current date in the path and
  puts the new date in the body. Only one-off meals are supported; repeating meals
  are refused and left to the Skylight app, because editing one occurrence of a
  series was not captured. `delete_meal_sitting` previews unless `confirm: true`
  and only reports success when Skylight lists the sitting in
  `meta.deleted_sitting_ids`. Sitting IDs and dates are format-checked before they
  reach a URL path.

## [1.4.1] - 2026-10-29

### Fixed

- **Messages**: `get_messages` showed every message as "selected devices" and listed
  profile names instead of "everyone", and `update_message` would have refused
  every message. Messages need the newer `Skylight-Api-Version` that the web app
  sends (`2026-10-15`); under the repo-wide older version the responses omit
  `all_profiles`, `all_devices` and `voice_kind`. The messages endpoints now send
  the newer version; every other endpoint is unchanged.

## [1.4.0] - 2026-10-29

### Added

- **Messages**: `get_messages` (read) and `send_message` (write) for the notes
  shown on the frame. Endpoint and payload were taken from the web app's own
  calls. Sends are silent unless `readAloud` is set, go to everyone on all
  devices, and are capped at 300 characters. Skylight offers no way to delete a
  message, so `send_message` previews by default and posts only with an explicit
  `confirm: true` after the user has approved the text. Presigned audio URLs, which carry
  temporary storage credentials, are never returned.

- `update_message` edits a message's text or sender (PATCH with the whole form, as
  the web app does) for messages sent to everyone on all devices that don't repeat.
  Message IDs are validated as numeric before they reach a URL path.

### Not yet supported

- Targeting specific profiles or devices, scheduling, repeats and voice notes.
  The request fields for these have not been captured.

## [1.3.0] - 2026-10-29

### Added

- **Planning tools**: `get_week_overview`, `find_conflicts`, `find_free_slots`
  (all read-only) and `plan_week_meals` (write, with dry run). Chores and
  tasks are first-class in the overview: status, assignee, points, and an
  overdue section.
- `src/utils/schedule.ts`: zone-aware interval math (Intl only, no library)
  with explicit handling of DST gaps/overlaps and all-day events.
- Tests for the schedule math and the four planning tools.

### Notes

- `plan_week_meals` registers without Plus and fails with a clear message there.
- The hosted Worker exposes the new tools automatically (read + write profile).
  Redeploy to pick them up.

## [1.2.0] - 2026-10-29

### Fixed

- **Meals**: `get_meal_categories` showed every category as "Unknown"; the
  API field is `label`, not `name`. `get_meal_sittings` now shows what is
  planned (summary or recipe), the category name, and each date in range.
  `create_meal_sitting` accepts a free-text `summary` so a meal can be
  scheduled without creating a recipe first, and reads the list-shaped
  create response correctly.

### Added

- **Browser-paste sign-in**: `skylight-mcp auth login` / `auth complete <url>` /
  `auth status` / `auth logout`. You sign in in your own browser and paste the
  redirect URL; the password never reaches the server. PKCE (S256) and a
  state check bound to a short-lived `0600` pending-login file.
- **Encrypted credential store**: AES-256-GCM with the key in macOS Keychain;
  `0600` file store elsewhere. Fails closed when the Keychain is unavailable.
- Automatic access-token refresh with rotation persisted; one in-flight
  refresh shared across concurrent requests; one retry on 401.
- Tests for the OAuth module, both credential stores, client auth order,
  API host pinning, the tool registry, request context and the hosted MCP
  handler (82 total).

- **Hosted server for Claude Duet** (`src/worker/`, `wrangler.jsonc`): a
  Cloudflare Worker that is both OAuth authorization server and MCP resource
  server (`@cloudflare/workers-oauth-provider` 1.x). Consent page gated by a
  setup passphrase; the same browser-paste Skylight sign-in, with the PKCE
  verifier held in a browser-bound upstream transaction; Skylight tokens kept
  in encrypted grant props and refreshed in `tokenExchangeCallback`. Exposes
  read + create/update tools only.
- `src/context.ts`: per-request AsyncLocalStorage context so one process can
  serve many grants; `src/tools/registry.ts`: effect classification and MCP
  annotations for every tool.

### Changed

- Package renamed to `@dwooods/skylight-mcp`; repository metadata points at
  this fork. README carries an explicit unofficial-status notice.
- Auth source order is now explicit token, stored credential, then the
  deprecated email/password login. Startup no longer requires email/password or
  token env vars.
- The client refuses absolute endpoint URLs whose origin is not the Skylight API
  host, so a bearer token can never be sent elsewhere.
- README, SECURITY.md and `.env.example` rewritten for the new flow.
- `THIRD_PARTY_NOTICES.md` credits kamilio/skylight-calendar-agent (MIT), whose
  design informed the sign-in flow and credential store.

### Security

- `npm audit`: 24 → 0. Runtime: `@modelcontextprotocol/sdk` 1.25 → 1.32
  (GHSA-345p-7cg4-v4c7, cross-client data leak via shared transport reuse;
  this server already creates one server+transport per request) and `zod`
  3 → 4 (GHSA-mrhx-c7xc-m3w5). Dev: `vitest` 1 → 5, `vite` 8, `@types/node`
  22.

### Removed

- Node 18 support (end-of-life April 2025; `wrangler` needs 20+). `engines` is now `>=20`.

### Deprecated

- `SKYLIGHT_EMAIL` / `SKYLIGHT_PASSWORD` login.

## [1.1.8] - 2026-04-14

### Fixed

- **Authentication**: Updated email/password authentication to match Skylight's current web OAuth flow. The server now follows the browser login sequence (`/oauth/authorize` -> `/auth/session` -> `/oauth/token`) and uses the returned bearer token for API requests.

### Changed

- Centralized shared API constants, including the Skylight API version header
- Updated auth-related docs and error guidance to reflect OAuth-based login
- Added automated tests for the OAuth login flow and kept live smoke validation against the real API

## [1.1.7] - 2025-12-30

### Fixed

- **Authentication**: Fixed email/password authentication to use correct `Basic base64(userId:token)` format instead of `Bearer token`. The Skylight API requires the user ID and token to be combined and base64-encoded for Basic auth.
- **Calendar Events**: Fixed `get_calendar_events` returning no events when querying a single day. The API treats `date_max` as exclusive, so we now add 1 day to ensure events on the end date are included.

### Changed

- Added debug logging for authentication flow to help troubleshoot login issues
- Added automatic retry on 401 errors for email/password auth (attempts re-login once before failing)

## [1.1.6] - 2025-12-29

- Initial public release
