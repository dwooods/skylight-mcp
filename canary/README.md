# Breakage canary (container)

Skylight has no official API, so a changed response can break a tool without any error. This
container runs read-only checks once a day and tells you when one fails, or when it stops
running. It is separate from the MCP server and exposes nothing: it only makes outbound calls.

**What it checks** (through the library entry, so it sees what an importer sees): profiles,
meal categories (a "Dinner" category must exist), this week's meals (may be empty), this
week's calendar events (must not be empty), and the calendar sources. Each result is judged
on shape, not just on "no error".

**How it alerts.** Each run pings a [healthchecks.io](https://healthchecks.io) check. A pass
is a plain ping. A failure is a POST to `/fail` with one fixed-vocabulary line such as
`FAILED: calendar-week:empty` (never a title, a name or an error message from Skylight). A
missed ping, which covers the NAS being off, the folder being locked or the container being
stopped, is the service's own alert. An expired sign-in is a failure too.

**What it does not check.** It does not go through the hosted Worker, so it cannot see that
connection's sign-in expiring. It also cannot tell a real family from an empty frame beyond
the checks above.

## Set up

1. **healthchecks.io.** Create a check: period 1 day, grace time 3 hours, email to you. Copy
   its ping address (`https://hc-ping.com/<uuid>`). It is a secret: anyone holding it can fake
   a pass. Keep it out of this repository, chat and logs. In the check's email integration,
   look for an option to skip the "back up" email if you only want failure emails.
2. **A private folder** for the sign-in, ideally on an encrypted shared folder that you unlock
   by hand after a reboot. The sign-in is the full Skylight login (not read-only), stored as
   an unencrypted 0600 file, so anyone who can read the folder can use the account. Make it
   owned by the uid and gid the container runs as.
3. **Build and start** the stack from `canary/docker-compose.example.yml`. Put the frame id,
   timezone and ping address in the stack's environment variables, not in a file.
4. **Sign in once**, with its own sign-in (never copy another app's credential: refresh tokens
   rotate and a shared one breaks the other holder):

   ```
   docker exec -it skylight-canary node dist/index.js auth login
   # open the printed address in a browser, sign in, copy the address you land on, then:
   docker exec -it skylight-canary node dist/index.js auth complete
   ```
5. **Test a pass:** `docker exec skylight-canary node dist/canary/run.js --once`. Expect
   `PASS: all 5 checks passed; ping sent (200)` and a green check at healthchecks.io.
6. **Test a failure:** set `CANARY_DINNER_NAME` to a category you do not have, run `--once`,
   and confirm the failure email arrives. Then remove the override. A canary whose alert has
   never been seen firing is not a canary.

## After a NAS reboot

If the credential folder is on an encrypted shared folder, unlock it, then restart the
container. Until then the run fails with `sign-in needed` or the ping goes missing, and
healthchecks emails you, which is the point.

## Settings

| Variable | Meaning |
|---|---|
| `SKYLIGHT_FRAME_ID` | digits from your Skylight URLs (required) |
| `SKYLIGHT_TIMEZONE` | IANA zone (required) |
| `CANARY_PING_URL` | `https://hc-ping.com/<uuid>` only (required, secret) |
| `CANARY_TIME` | local `HH:MM` of the daily run, default `09:30` |
| `CANARY_DINNER_NAME` | meal category that must exist, default `Dinner` |

The container also runs once when it starts.
