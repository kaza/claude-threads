# This checkout is VVS's `vvs` branch

You are on the fork `kaza/claude-threads`, branch **`vvs`**: upstream
`anneschuth/claude-threads` plus every feature VVS runs. This file exists only on
this branch. It is not part of any pull request, and it must never be.

## The rule

`vvs` is an integration branch. **Do not commit to it directly.**

```
main  ── mirror of upstream, fast-forward only, never committed to
 ├─ pr/<feature>      upstream-shaped work, cut from main, offered to Anne as a PR
 └─ local/<feature>   VVS-only work, cut from main, never a PR
vvs   ── main ⊕ every pr/* ⊕ every local/*   ← the agent box runs this
```

- A fix goes to the branch it belongs to (`git log --merges` on `vvs` shows which
  branches are in), then `vvs` is re-merged: `git checkout vvs && git merge --no-ff pr/<x>`.
- A new feature starts as `pr/<name>` from `main` (or `local/<name>` if it is ours
  only). It reaches the box only through a merge into `vvs`.
- When upstream releases: fast-forward `main`, rebase each `pr/*` onto it, rebuild
  `vvs` by re-merging, run `bun test src/ && bun test voice/`, deploy.
- Merged PRs: delete the `pr/*` branch; its commits now come through `main`.

The reasoning and the deploy steps are in the VVS handbook,
`systems/CLAUDE-THREADS.md` § Branch model.

## What is in here beyond upstream

| Branch | What | Docs |
|---|---|---|
| `pr/dynamic-channels` | a Slack channel is a task, a session, a worktree | `docs/dynamic-channels-spec.md` |
| `pr/audio-transcription` | voice notes are transcribed before Claude sees them | `docs/audio-transcription-spec.md` |
| `pr/voice-replies` | the agent answers in audio on request or always per channel | `docs/voice-replies-spec.md` |
| `local/voice-desk` | a live voice conversation with the agent, via Slack | `docs/voice-desk-spec.md`, `voice/README.md` |
| `local/integration` | glue that only exists where two `pr/*` branches meet (e.g. task channels registered by `pr/dynamic-channels` must receive the `tools` / `lifecycle` dials added by `pr/quiet-tools` / `pr/quiet-lifecycle`). Small commits, each naming the branches it joins; never a PR | this file |
