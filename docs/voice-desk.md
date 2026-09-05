# voice-desk moved

The live voice front desk now lives in its own repository:
**https://github.com/kaza/claude-threads-voice-desk** (spec in `docs/spec.md` there).
It is a sibling project, not upstream material — see anneschuth/claude-threads#528.

What stays in this fork, on `local/voice-desk`, is the daemon side only: the
`voiceDesk.url` config value, the `!voice` command and the Slack "Talk to this
channel" shortcut (`src/voice-desk/`), all of which only need the page's URL.
