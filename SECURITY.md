# Security & credential handling

This server signs in to Skylight through your browser (`skylight-mcp auth
login`) and stores the resulting OAuth tokens locally, or, in the deprecated
fallback, logs in with your email and password. Treat all of the following as
secrets and never commit them:

- The credential store (`credential.enc.json` / `credential.json`) and the
  `pending-login.json` file; see README > Authentication for locations
- `SKYLIGHT_EMAIL`, `SKYLIGHT_PASSWORD`, `SKYLIGHT_TOKEN`
- Your Skylight **frame ID** (identifies your household)
- Anything captured from app traffic: HAR files, proxy dumps, bearer tokens,
  calendar IDs, or real family member names/emails

## Where credentials belong

- **Preferred:** nowhere in your config. `auth login` keeps tokens in the
  per-user credential store (macOS: AES-256-GCM, key in Keychain; elsewhere a
  `0600` file). The server refuses to fall back to plaintext if the Keychain is
  unavailable, and it only ever sends the token to `app.ourskylight.com`.
- **Local use (fallback):** in your MCP client config's `env` block, or an untracked `.env`
  file. `.env` and variants are git-ignored; only `.env.example` (placeholders
  only) is tracked.
- **Never** hard-code credentials in source, tests, docs, or commit messages.
- Use a **unique password** for your Skylight account so a leak can't reach
  anything else.

## Guardrails in this repo

1. `.gitignore` excludes `.env*` (except `.env.example`), HAR captures, key
   files, token/state files, and the generated API types file.
2. `.githooks/pre-commit` blocks commits containing secret-looking content.
   Enable it once per clone: `git config core.hooksPath .githooks`
   (also runs `gitleaks` automatically if it is installed).
3. `.github/workflows/secret-scan.yml` runs gitleaks on every push and PR.
4. Before making the repo public, enable GitHub **secret scanning** and
   **push protection** (Settings → Code security). Both are on by default
   for public repos.

## Generated API types

`src/api/generated-types.ts` is produced from an OpenAPI spec that was built
from real traffic captures, and the generator can embed real sample values
(emails, calendar IDs). It is not used at runtime, is git-ignored, and must
not be committed. If you regenerate it, keep it local.

## If a secret is committed

1. **Rotate it immediately** (change your Skylight password; tokens expire on
   re-login).
2. Remove it from history (`git filter-repo`) — deleting it in a new commit is
   not enough, especially once the repo is public.
3. Force-push and ask collaborators to re-clone.
