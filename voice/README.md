# voice-desk

A live voice conversation with the agent, through Slack. Spec and reviews:
[`docs/voice-desk-spec.md`](../docs/voice-desk-spec.md). This directory is
VVS-only (branch `feat/voice-desk`), never part of an upstream PR.

## Run the tests

```bash
bun run test:voice          # everything in voice/, fake Slack and Gemini
bun run lint && bun run typecheck
```

## Live smoke (needs a key)

```bash
GEMINI_API_KEY=… bun voice/smoke.ts            # default model
GEMINI_API_KEY=… bun voice/smoke.ts some-model # try another id
```

## Install on the box (as `herder`, once)

1. `~/.config/voice-desk/env` (0600), from the table in the spec:
   `GEMINI_API_KEY`, `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_TEAM_ID`,
   `SLACK_BOT_USER_ID`, `SESSION_SECRET` (`openssl rand -base64 32`),
   `PUBLIC_URL=https://agents.vvs-capital.com/voice`,
   `DYNAMIC_CHANNELS_FILE=/home/herder/.config/claude-threads/dynamic-channels-slack-vvs.json`,
   `HOST=172.17.0.1`, `PORT=8787`.
2. Slack app (admin, once): add the user token scopes listed in the spec, add the
   redirect URL `PUBLIC_URL/oauth/callback`, reinstall.
3. `sudo cp voice/voice-desk.service /etc/systemd/system/ && sudo systemctl enable --now voice-desk`
   (from `ec2-user`).
4. Caddy: inside the `agents.vvs-capital.com` block add
   `redir /voice /voice/` and `handle_path /voice/* { reverse_proxy 172.17.0.1:8787 }`,
   then `docker exec caddy caddy reload --config /etc/caddy/Caddyfile`.
5. `journalctl -u voice-desk -f` while you open `PUBLIC_URL/`.

## Update

Sync the changed files, then `sudo systemctl restart voice-desk`. No build step:
Bun runs the TypeScript directly and the browser loads `public/` as-is.

## Starting a call from Slack

`!voice` in a task channel, or the message shortcut **Talk to this channel**, answers with
`<voiceDesk.url>/?channel=<id>`. Daemon config:

```yaml
voiceDesk:
  url: https://agents.vvs-capital.com/voice
```

Slack app: Interactivity on, a message shortcut with callback ID `voice_call`. Details and
the phone caveats: `docs/voice-desk-spec.md` § Starting a call from Slack.
