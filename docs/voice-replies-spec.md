# Voice replies: the agent answers in audio when asked, or always

Companion to [audio-transcription-spec.md](audio-transcription-spec.md)
(voice in). This is voice out. Upstream discussion: #519.

## What it does

With a `speech:` block in config, the agent can answer with an mp3 posted
into the channel. Nothing in the daemon synthesises anything: the *model*
composes what is said, a shell script (`scripts/say`) turns it into audio,
and the existing `send_file` MCP tool posts it. The daemon's part is three
small things: tell the model the rules (appended system prompt), tell it the
"always speak" *state* on every follow-up turn, and hand each spawned session
its identity and paths through the environment so `say` never guesses.

Three user-facing behaviours, all interpreted by the model from natural
language, so exact wording does not matter:

1. **One-off:** "answer in audio", "say it", "speak" → this reply carries an
   mp3 as well as text.
2. **Always on:** "always speak" → the agent runs `say --on`, confirms in one
   line, and every following reply in this channel carries an mp3.
3. **Off:** "speak off", "stop speaking" → `say --off`, confirmed.

Rules the model is given:

- The spoken part is a **summary under ~150 words**, never a diff, log, code
  or a list of links. The details go in the text reply as usual. The mp3 is
  posted last, after the text.
- **The daemon tells the model the state.** On every follow-up turn the
  message manager checks the channel's marker file and, when it exists,
  prefixes the user turn with
  `[Voice: "always speak" is ON for this channel — …]` outside the `[@user]:`
  attribution. The model never has to remember the switch or shell out to
  check it. `say --status` remains as the fallback for the one turn the
  reminder cannot reach: the first message of a brand-new session.
- If `say` fails, the reply says so in one line with the error and continues
  as text. Never silent.

## `say` (scripts/say → `~/.local/bin/say` on the box)

| Invocation | Effect |
|---|---|
| `say "text"` | POST `/v1/text-to-speech/<voiceId>?output_format=mp3_44100_128`; writes `./say-<ts>-<pid>.mp3` **in the working directory** (`send_file` accepts nothing outside it); prints the path. Inside a git checkout it adds `say-*.mp3` to `.git/info/exclude` so a leftover can never be WIP-committed; the model deletes the file after posting |
| `say --on` / `--off` / `--status` | per-channel switch |

- **Identity comes from the daemon.** Every Claude session is spawned with
  `CLAUDE_THREADS_SPEAK_KEY` (the session's `platformId:threadId`, made
  filename-safe), `CLAUDE_THREADS_SPEAK_DIR` (the daemon's marker dir) and
  `CLAUDE_THREADS_CONFIG` (the daemon config path). So the switch is per
  *session*: a direct-channel session keeps it across restarts (its id is
  stable), two thread sessions sharing one working directory do not share
  it, `!cd` does not move it, and a pooled Claude account with its own
  `$HOME` still finds the daemon's config and markers. Run by hand outside
  a session, `say` falls back to the workspace basename (the `workon` rule)
  and the daemon user's home.
- **The switch is a marker file outside the workspace**:
  `<speak dir>/<key>`. Nothing in a worktree, so nothing to gitignore and
  nothing for the teardown WIP-commit to pick up.
- **Text on stdin.** The prompt tells the model to call
  `say - <<'EOF' … EOF`: a quoted heredoc, so a summary containing `$(…)`,
  backticks or quotes is never interpreted by the shell. `--file` and a
  plain argument exist for humans.
- **Credentials from the daemon config**, never arguments: `speech.apiKey`
  (falls back to `transcription.apiKey` — same ElevenLabs key), `speech.voiceId`
  (required), `speech.model` (default `eleven_multilingual_v2`). The key
  travels to curl in a config on a private fd and the JSON body on stdin;
  neither shows in the process list.
- Refuses text over 2 500 characters with a message telling the model to
  summarise. A 3-minute monologue is the ceiling, not the target.
- Fails loud: non-200 → status and body excerpt on stderr; a transport
  failure (timeout, DNS) → its own message. In both cases no file is left
  behind and the exit code is 1.

## Config (top-level)

```yaml
speech:
  voiceId: XrExE9yKIg1WjnnlVkGX   # required; ElevenLabs voice
  model: eleven_multilingual_v2   # optional
  apiKey: ...                     # optional; defaults to transcription.apiKey
```

The daemon reads only the block's presence: with it, the voice rules are
appended to the system prompt of every session; without it, nothing changes.
`voiceId` is validated at boot so a half-configured block fails the start,
not the first "speak".

## Wiring

- `Config.speech?: SpeechConfig` (`src/config/types.ts`, type in
  `src/transcription/types.ts`).
- `VOICE_REPLIES_PROMPT`, `alwaysSpeakReminder`, `speakKey` in
  `src/transcription/voice-prompt.ts`.
- `SessionManager.setSpeech(config)`; `getContext().ops.appendSystemPrompt()`
  is `CHAT_PLATFORM_PROMPT` plus the voice prompt when speech is set, and
  `ops.alwaysSpeakReminder(session)` is the per-turn line (empty unless
  speech is set and the marker exists). **Every place that (re)spawns Claude
  uses `ctx.ops.appendSystemPrompt()`**: session start and resume
  (`lifecycle.ts`), `!cd` and `!permissions` (`commands/handler.ts`), plugin
  install/uninstall (`plugin/handler.ts`), worktree switches (via the
  manager's worktree options). `--append-system-prompt` is per invocation,
  so a respawn built from the bare constant would silently drop the rules.
- `MessageManager` takes an `alwaysSpeakReminder` callback (wired by
  `lifecycle.ts` from `ctx.ops`) and prefixes every follow-up turn with its
  result, outside the `[@user]:` attribution.
- `ClaudeCli` exports the three `CLAUDE_THREADS_*` variables into the child
  env from its `sessionKey` option; every spawn site passes it.
- `index.ts`: validate `config.speech` at boot, `session.setSpeech(...)`, log.

## Tests

- `say` (bun test driving the script with a stub `curl` on `PATH` and a
  temporary config): writes the mp3 into the working directory and prints
  its path; git-excludes the pattern inside a checkout; sends voice id, key
  and model with neither key nor text in curl's argv; stdin text keeps shell
  metacharacters; `--on/--off/--status` keyed by `CLAUDE_THREADS_SPEAK_KEY`
  or, by hand, the workspace basename with the `--repo` rule; refuses
  over-long and empty text; non-200 and curl failures are errors with no
  file left; missing voice id is a config error.
- Prompt and state: with speech set the appended system prompt contains the
  voice rules and the follow-up reminder appears while the marker exists;
  without speech neither does, even with a stale marker.

## Decisions

| Decision | Why |
|---|---|
| Model composes the spoken text, script synthesises, `send_file` posts | the daemon would otherwise read raw replies (diffs, logs) aloud; the model is the only party that knows what deserves a voice |
| "Always speak" is a per-session marker file, not model memory | model memory does not survive context compaction; a file does. Per session (a direct-channel session *is* the channel) so nothing bleeds between threads that share a working directory |
| The daemon exports the session key, marker dir and config path into the child env | with an account pool `$HOME` is not the daemon's; with plain thread sessions `$PWD` is not the channel. The daemon is the only party that knows both (Codex review, 2026-09-02) |
| The reminder line is gated on `speech:` | a stale marker must not inject audio instructions into a daemon whose prompt no longer has the rules |
| Marker outside the workspace | inside a worktree it would be WIP-committed at teardown |
| Rules in the appended system prompt, not the scratch `CLAUDE.md` | repo-mapped channels never get the scratch `CLAUDE.md`; the system prompt reaches every session |
| Same ElevenLabs key as transcription by default | one key on the box, two consumers, one rotation |
