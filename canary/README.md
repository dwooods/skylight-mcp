# Breakage canary (container)

Skylight has no official API, so a changed response can break a tool without any error. This
container holds a one-shot check you run from your host's scheduler. It exposes nothing and
sends nothing: it prints one line and exits 0 (pass) or 1 (fail). The scheduler emails you when
the exit code is not 0.

**What it checks** (through the library entry, so it sees what an importer sees): profiles,
meal categories (a "Dinner" category must exist), this week's meals (may be empty), this
week's calendar events (must not be empty), and the calendar sources. Each result is judged on
shape, not just on "no error". Only read calls are made (five GETs).

**Output** is a fixed vocabulary: `all 5 checks passed`, `FAILED: <check>:<reason>, ...` or
`FAILED: sign-in needed`. Nothing Skylight returns, and no credential, is ever printed.

**What it does not do.** It does not run through the hosted Worker, so it cannot see that
connection's sign-in expiring. It cannot tell you it did not run: if the host is off or the
scheduler task is broken, you hear nothing.

## Set up (Synology NAS, Portainer, DSM Task Scheduler)

1. **A private folder** for the sign-in, ideally on an encrypted shared folder. The sign-in is the
   full Skylight login (not read-only) stored as a 0600 file, so anyone who can read the folder
   can use the account. Make it owned by the uid:gid the container runs as.
2. **Build and start** the stack from `canary/docker-compose.example.yml` (Portainer: Stacks, Add
   stack, Repository). Put `SKYLIGHT_FRAME_ID` and `SKYLIGHT_TIMEZONE` in the stack's environment
   variables. The container idles; it does nothing until you exec into it.
3. **Sign in once**, with its own sign-in (never copy another app's credential: refresh tokens
   rotate and a shared one breaks the other holder):

   ```
   docker exec -it skylight-canary node dist/index.js auth login
   # open the printed address in a browser, sign in, copy the address you land on, then:
   docker exec -it skylight-canary node dist/index.js auth complete
   ```
4. **Test a pass:** `docker exec skylight-canary node dist/canary/run.js --once`. Expect
   `[canary] <date> PASS: all 5 checks passed` and exit code 0.
5. **Schedule it.** DSM Control Panel, Task Scheduler, Create, Scheduled Task, User-defined
   script. Run as root, schedule weekly (for example Friday 08:00), and under Task Settings tick
   "Send run details by email" and "Send run details only when the script terminates
   abnormally". Script:

   ```
   docker exec skylight-canary node dist/canary/run.js --once
   exit $?
   ```
6. **Test a failure (do not skip).** Set `CANARY_DINNER_NAME` to a category you do not have,
   redeploy, run the task by hand (select it, Run) and confirm the email arrives. Then remove
   the override. A canary whose alert has never been seen firing is not a canary.

DSM must already have email notification configured (Control Panel, Notification). If your other
scheduled tasks email you, this one will.

## Settings

| Variable | Meaning |
|---|---|
| `SKYLIGHT_FRAME_ID` | digits from your Skylight URLs (required) |
| `SKYLIGHT_TIMEZONE` | IANA zone (required) |
| `CANARY_DINNER_NAME` | meal category that must exist, default `Dinner` |

Exit codes: 0 pass, 1 fail, 78 bad settings.
