# Dynamic Channels (Slack): channel = task = session = worktree

## What it does

A Slack platform entry may opt in with `dynamicChannels`. Then: inviting the bot
to any channel and **@-mentioning** it spawns a derived platform instance for
that channel *immediately, in the event handler* — no config edit, no restart.
The channel becomes one conversation (DCM) working in its own git worktree.

## Config (parent Slack entry)

```yaml
platforms:
  - id: slack-vvs
    type: slack
    # ... tokens, channelId (parent channel still works as before)
    dynamicChannels:
      reposDir: /home/herder/repos        # candidate repos (dirs)
      worktreesDir: /home/herder/worktrees
      scratchDir: /home/herder/scratch    # non-repo channels land here
```

Derived instances inherit `allowedUsers`, `permissionMode`, `botName` from the
parent; `directChannelMode: true`, `stickyMessage: hidden`, `sessionHeader:
minimal`.

## Channel-name → workspace mapping

- Longest prefix match of the channel name against directory names in
  `reposDir` → that repo; the remainder (sans leading `-`) is the task slug.
- Worktree: `<worktreesDir>/<channel-name>` on branch `slack/<slug>` (or
  `slack/<channel-name>` if the slug is empty), created from the repo's
  default branch. Reused if it already exists.
- No prefix match → `<scratchDir>/<channel-name>` (plain dir, no git).

## Trigger and identity

- Cold trigger: `message` event in an unknown channel whose text mentions the
  bot (`<@BOTID>`). Non-mention messages in unknown channels are ignored —
  membership is consent, the mention is the start signal.
- Derived platform id: `<parentId>--ch-<channelId>` (stable; rename-proof).
- Bindings (channel id → name, workspace dir, repo) persist in
  `dynamic-channels.json` next to the session store; boot reconstructs
  instances for persisted bindings so sessions resume after restart.

## Teardown (the backstop — the agent never deletes)

Preferred close is conversational: the user tells Claude to close the task;
the agent commits/pushes/PRs as ordinary session work. Deletion is only ever
mechanical:

On `channel_archive`, or the bot being removed from the channel:
1. scratch dir → deconfigure instance, keep dir.
2. worktree: uncommitted changes → commit `wip: archived from Slack <ISO date>`.
3. unpushed commits → push.
4. push verified clean (`status --porcelain` empty, `rev-list @{u}..HEAD` empty)
   → `git worktree remove` + delete local branch. Remote branch always kept.
5. push fails → keep everything, post ⚠️ to the parent channel.
6. Un-archive the channel and @-mention the bot again → the binding
   recreates the worktree from the remote branch. Archive is a two-way door.
   (No `channel_unarchive` handling — the re-mention IS the recovery path.)

Principle: remote branch = durable store; worktree = rebuildable cache.

## Slack app requirements

Bot events additionally needed: `channel_archive`, `member_left_channel`.
(`member_left_channel` pulls in `groups:read`.)

## Non-features (deliberate)

- No time-based expiry; disk pressure is an alarm, not a reaper.
- No remote-branch deletion, ever.
- No channel creation/archiving by the bot (no channels:manage).

## v2: agent-requested multi-repo workspaces (`workon`)

A task may span repos. The channel's *primary* workspace still comes from the
name (repo prefix → that repo's worktree; otherwise a scratch dir). Beyond
that, the AGENT decides — but never freelances:

- Pristine clones under `reposDir` are readable for exploration and
  **read-only by contract** (each workspace's CLAUDE.md states the rule; the
  permission mode makes edits visible).
- To write, the agent (or a human) runs `workon <repo> [branch]` — a small
  script shipped in `scripts/workon`. It validates the repo, fetches the
  default branch, creates `worktreesDir/<channel>--<repo>` on branch
  `slack/<channel>` (from `origin/<default>`), and records the workspace in a
  sidecar file (`dynamic-channels-extra.json`, flock-guarded) that ONLY the
  script writes and the daemon only reads. No write contention with the
  daemon's own bindings.
- The agent invoking the script through its Bash tool means the request shows
  up as a tool call in the channel under the normal permission flow: the
  "ask" is visible where the team lives.
- Discovery: every spawned workspace gets a CLAUDE.md explaining the layout,
  the read-only rule, and the `workon` command. Claude Code loads it
  automatically; no prompt plumbing.

Teardown iterates the primary workspace PLUS every sidecar workspace for the
channel: WIP-commit → push → verify clean-and-pushed → remove; the sidecar
entry is cleared only for workspaces actually handled. Fresh-base rule:
worktree branches are always created from `origin/<default>` after a fetch —
never from a stale local ref.

## Known limitations (v1)

- Messages posted in a *derived* channel while the parent socket is down are
  not replayed by reconnect recovery (which only covers the parent channel).
  Routing resumes for new messages; a missed instruction needs re-sending.
