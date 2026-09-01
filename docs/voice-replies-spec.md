# Voice replies: the agent answers in audio when asked, or always

Companion to [audio-transcription-spec.md](audio-transcription-spec.md)
(voice in). This is voice out. Upstream discussion: #519.

## What it does

With a `speech:` block in config, the agent can answer with an mp3 posted
into the channel. Nothing in the daemon synthesises anything: the *model*
composes what is said, a shell script (`scripts/say`) turns it into audio,
and the existing `send_file` MCP tool posts it. The daemon's only part is to
tell the model the rules through the appended system prompt.

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

- **Channel** = basename of `$PWD` with any `--<repo>` suffix removed — the
  same rule `workon` uses, so it is right in a scratch dir and in a worktree.
- **The switch is a marker file outside the workspace**:
  `~/.local/state/claude-threads/speak/<channel>`. Nothing in a worktree, so
  nothing to gitignore and nothing for the teardown WIP-commit to pick up.
- **Credentials from the daemon config**, never arguments: `speech.apiKey`
  (falls back to `transcription.apiKey` — same ElevenLabs key), `speech.voiceId`
  (required), `speech.model` (default `eleven_multilingual_v2`).
- Refuses text over 2 500 characters with a message telling the model to
  summarise. A 3-minute monologue is the ceiling, not the target.
- Fails loud: non-200 → status and body excerpt on stderr, no file left
  behind, exit 1.

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
- `generateVoiceRepliesPrompt()` in `src/commands/system-prompt-generator.ts`.
- `SessionManager.setSpeech(config)`; `getContext().ops.appendSystemPrompt`
  becomes `CHAT_PLATFORM_PROMPT` plus the voice prompt when speech is set.
  `lifecycle.ts` uses `ctx.ops.appendSystemPrompt` at both `buildAppendSystemPrompt`
  call sites instead of the bare constant.
- `index.ts`: validate `config.speech` at boot, `session.setSpeech(...)`, log.

## Tests

- `say` (bun test driving the script with a stub `curl` on `PATH` and a
  temporary config): writes the mp3 and prints its path; sends voice id, key
  header and model; `--on/--off/--status` per channel derived from `$PWD`
  including the `--repo` suffix rule; refuses over-long text; non-200 is an
  error with no file left; missing voice id is a config error.
- Prompt: with speech set the appended system prompt contains the voice
  rules; without it, it does not.

## Decisions

| Decision | Why |
|---|---|
| Model composes the spoken text, script synthesises, `send_file` posts | the daemon would otherwise read raw replies (diffs, logs) aloud; the model is the only party that knows what deserves a voice |
| "Always speak" is a per-channel marker file, not model memory | model memory does not survive context compaction; a file does. Per channel because a channel is a task with several people in it |
| Marker outside the workspace | inside a worktree it would be WIP-committed at teardown |
| Rules in the appended system prompt, not the scratch `CLAUDE.md` | repo-mapped channels never get the scratch `CLAUDE.md`; the system prompt reaches every session |
| Same ElevenLabs key as transcription by default | one key on the box, two consumers, one rotation |
