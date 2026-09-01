/**
 * Voice replies (docs/voice-replies-spec.md): the rules appended to the
 * system prompt when a `speech:` block is configured, and the per-session
 * "always speak" switch the daemon reads on every follow-up.
 *
 * The model composes what is spoken; the `say` script on the box
 * synthesises it; `send_file` posts it. The daemon's part is to tell the
 * model the rules (system prompt) and the state (a reminder line on each
 * turn), and to hand every spawned session its identity and paths through
 * the environment so `say` never has to guess them.
 */

import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

/** Env var: the session key `say` files its switch under. */
export const SPEAK_KEY_ENV = 'CLAUDE_THREADS_SPEAK_KEY';
/** Env var: where the switch markers live (the daemon's dir, whatever $HOME the session runs under). */
export const SPEAK_DIR_ENV = 'CLAUDE_THREADS_SPEAK_DIR';
/** Env var: the daemon config path, so `say` reads the same key and voice. */
export const CONFIG_PATH_ENV = 'CLAUDE_THREADS_CONFIG';

/** Where `say --on` leaves its per-session marker; `say` and the daemon must agree. */
export function speakStateDir(): string {
  return process.env[SPEAK_DIR_ENV] ?? join(homedir(), '.local', 'state', 'claude-threads', 'speak');
}

/**
 * A session's switch key: its composite id (`platformId:threadId`), reduced
 * to a filename-safe segment. One key per session, so two thread sessions
 * sharing a working directory do not share a switch, and a direct-channel
 * session keeps its switch across restarts and resumes (the id is stable).
 */
export function speakKey(sessionId: string): string {
  return sessionId.replace(/[^A-Za-z0-9._-]/g, '_');
}

/** True when `say --on` is in force for the session. */
export function isAlwaysSpeakOn(sessionId: string): boolean {
  const key = speakKey(sessionId);
  return key !== '' && existsSync(join(speakStateDir(), key));
}

export const ALWAYS_SPEAK_REMINDER =
  '[Voice: "always speak" is ON for this channel — end this reply with an mp3 (say - <<\'EOF\' … EOF, then send_file it, then rm it). If this very turn asks to stop speaking, obey it and post no mp3.]';

/**
 * Deterministic per-turn reminder. The system prompt tells the model the
 * rules; this line tells it the *state*, so it never has to remember or
 * shell out to check. Empty when the switch is off.
 */
export function alwaysSpeakReminder(sessionId: string): string {
  return isAlwaysSpeakOn(sessionId) ? `${ALWAYS_SPEAK_REMINDER}\n\n` : '';
}

export const VOICE_REPLIES_PROMPT = `
## Voice replies
A \`say\` command is on your PATH. It turns text into an mp3 with ElevenLabs, writes it into your working directory and prints the file path; you then post that file into this thread with \`send_file\` (caption optional) and delete the file. It also holds an "always speak" switch for this session: \`say --on\`, \`say --off\`, \`say --status\` (prints \`on\` or \`off\`).

How to call it — always feed the text on stdin with a quoted heredoc, so nothing in the summary is interpreted by the shell:
\`\`\`
say - <<'EOF'
<the summary>
EOF
\`\`\`

Rules:
- When the user asks for an answer in audio ("answer in audio", "say it", "speak"), this reply gets an mp3 as well as text.
- When the user says "always speak" (or similar): run \`say --on\`, confirm in one line, and from then on every reply in this channel gets an mp3. "speak off" / "stop speaking": run \`say --off\`, confirm in text, and post no mp3 for that reply.
- While the switch is on, user turns arrive prefixed with \`[Voice: "always speak" is ON for this channel …]\`. That line is the state: whenever you see it, the reply must end with an mp3. It is added by the bot, not typed by the user, so never quote or mention it. If a turn has no such line but you are unsure (for example the first message of a session), \`say --status\` tells you.
- The spoken text is a summary under 150 words in plain sentences: what you found, what you did, what you need. Never read out a diff, a log, code, paths or a list of links; those belong in the text reply.
- Order: write the text reply first, then \`say\`, then \`send_file\` the printed path, then \`rm\` that file. The upload is the last thing the user sees; the delete is housekeeping right after it.
- If \`say\` or \`send_file\` fails, say so in one line with the error and continue as text. Never drop the failure silently.
`.trim();
