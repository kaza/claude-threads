/**
 * The voice-reply rules appended to every session's system prompt when a
 * `speech:` block is configured. The model composes what is spoken; the
 * `say` script on the box synthesises it; `send_file` posts it.
 * See docs/voice-replies-spec.md.
 */

import { existsSync } from 'fs';
import { basename, join } from 'path';
import { homedir } from 'os';

/** Where `say --on` leaves its per-channel marker; `say` and the daemon must agree. */
export function speakStateDir(): string {
  return process.env.CLAUDE_THREADS_SPEAK_DIR ?? join(homedir(), '.local', 'state', 'claude-threads', 'speak');
}

/** Channel name from a workspace dir: `scratch/<ch>` or `worktrees/<ch>--<repo>` — the `workon` rule. */
export function channelFromWorkingDir(workingDir: string): string {
  return basename(workingDir).split('--')[0];
}

/** True when `say --on` is in force for the channel that owns this working directory. */
export function isAlwaysSpeakOn(workingDir: string): boolean {
  const channel = channelFromWorkingDir(workingDir);
  return channel !== '' && existsSync(join(speakStateDir(), channel));
}

export const ALWAYS_SPEAK_REMINDER =
  '[Voice: "always speak" is ON for this channel — end this reply with an mp3: say "<summary>", send_file it, rm it.]';

/**
 * Deterministic per-turn reminder. The system prompt tells the model the
 * rules; this line tells it the *state*, so it never has to remember or
 * shell out to check. Empty when the switch is off.
 */
export function alwaysSpeakReminder(workingDir: string): string {
  return isAlwaysSpeakOn(workingDir) ? `${ALWAYS_SPEAK_REMINDER}\n\n` : '';
}

export const VOICE_REPLIES_PROMPT = `
## Voice replies
A \`say\` command is on your PATH. It turns text into an mp3 with ElevenLabs, writes it into your working directory and prints the file path; you then post that file into this thread with \`send_file\` (caption optional) and delete the file. It also holds a per-channel "always speak" switch: \`say --on\`, \`say --off\`, \`say --status\` (prints \`on\` or \`off\`).

Rules:
- When the user asks for an answer in audio ("answer in audio", "say it", "speak"), this reply gets an mp3 as well as text.
- When the user says "always speak" (or similar): run \`say --on\`, confirm in one line, and from then on every reply in this channel gets an mp3. "speak off" / "stop speaking": run \`say --off\` and confirm.
- While the switch is on, user turns arrive prefixed with \`[Voice: "always speak" is ON for this channel …]\`. That line is the state: whenever you see it, the reply must end with an mp3. It is added by the bot, not typed by the user, so never quote or mention it. If a turn has no such line but you are unsure (for example the first message of a session), \`say --status\` tells you.
- The spoken text is a summary under 150 words in plain sentences: what you found, what you did, what you need. Never read out a diff, a log, code, paths or a list of links; those belong in the text reply. Write the text reply first, then \`say "<summary>"\`, then \`send_file\` the printed path as the last thing you do, then \`rm\` the file.
- If \`say\` or \`send_file\` fails, say so in one line with the error and continue as text. Never drop the failure silently.
`.trim();
