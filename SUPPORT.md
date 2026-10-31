# Support

This is an unofficial, reverse-engineered integration maintained by one person in spare time. There is no support contract and no guaranteed response time. Skylight can change its API without notice, and when it does, things break until someone fixes them.

## Before you file an issue

1. Run the checker and read what it says:
   ```bash
   SKYLIGHT_FRAME_ID=your_frame_id SKYLIGHT_TIMEZONE=America/New_York \
     npx -y @davidwoods/skylight-mcp doctor
   ```
   It checks Node, your frame ID, your time zone, your sign-in and one real call to Skylight, and does not print tokens or your frame ID.
2. Check the Troubleshooting table in the [README](README.md#troubleshooting).
3. Check the "What is supported" and "Not supported" lists in the README. Several things are deliberately missing, for example repeating meals and scheduled messages.
4. Search the existing issues.

Then [open an issue](https://github.com/dwooods/skylight-mcp/issues/new/choose) and fill in the template.

## What to include, and what never to include

Issues are public. Include: what you asked, what you expected, the `doctor` output, your OS, how you run it and which client you use.

Never post: tokens, your frame ID, email addresses, family member names, calendar IDs, your Worker URL or KV namespace ID, or browser captures (HAR files, DevTools screenshots with request headers). If you pasted any of these by accident, edit the issue right away. If it was a token or a password, treat it as exposed: run `skylight-mcp auth logout`, sign in again, and change your Skylight password.

## What is outside this project

- **Your Skylight account, billing, devices or the display itself:** contact Skylight. This project cannot help and is not affiliated with them.
- **Claude, Claude Duet or your MCP client misbehaving in general:** contact that product's support.
- **Cloudflare account or deploy problems:** Cloudflare's documentation and support. A clear error from `npm run worker:setup` is a reasonable issue here.

## Security

If you find a way to leak a token, send a token to a host other than `app.ourskylight.com`, or run a destructive action without confirmation, please do not open a public issue. Use the repository's private vulnerability reporting (the Security tab, then "Report a vulnerability"). See [SECURITY.md](SECURITY.md) for how credentials are handled.
