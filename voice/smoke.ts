/**
 * voice-desk live smoke, gated on GEMINI_API_KEY. Not part of `bun test`.
 *
 *   GEMINI_API_KEY=… bun voice/smoke.ts [model]
 *
 * Proves, against the real service: the model exists; a constrained one-use
 * token mints; the constrained socket accepts the locked setup and answers
 * setupComplete; a text turn asking to relay produces a post_to_channel
 * toolCall (NON_BLOCKING tools accepted); a toolResponse with scheduling is
 * accepted and audio comes back. Fails loudly on the first missing piece.
 */

import { DEFAULT_LIVE_MODEL, LIVE_WS_URL, mintEphemeralToken } from './gemini.js';
import { buildSetup } from './prompt.js';
import { classify, frameText, setupMessage, textTurnMessage, toolResponse } from './public/live.js';

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.error('smoke: GEMINI_API_KEY is required');
  process.exit(2);
}
const model = process.argv[2] ?? process.env.GEMINI_LIVE_MODEL ?? DEFAULT_LIVE_MODEL;
/** Hold the tool response this long: does the model keep talking meanwhile (NON_BLOCKING honoured) or go silent? */
const holdMs = Number(process.env.SMOKE_HOLD_TOOL_MS ?? '0');

function fail(step: string, detail: unknown): never {
  console.error(`smoke FAILED at ${step}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
  process.exit(1);
}

// 1. The model exists for this key.
const models = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}`, { headers: { 'x-goog-api-key': apiKey } });
if (!models.ok) fail('model lookup', `${models.status} ${await models.text()}`);
console.log(`ok  model ${model} exists`);

// 2. A constrained token mints.
const token = await mintEphemeralToken({ apiKey, fetch, now: () => new Date() }, { model, voiceName: 'Aoede' });
console.log(`ok  token minted, expires ${token.expireTime}`);

// 3. The constrained socket accepts the locked setup.
const setup = buildSetup({ model, voiceName: 'Aoede' });
const ws = new WebSocket(`${LIVE_WS_URL}?access_token=${encodeURIComponent(token.name)}`);
const timeout = setTimeout(() => fail('timeout', 'no answer within 30 s'), 30_000);
let sawSetup = false;
let sawToolCall = false;
let sawAudio = false;
let toolCallAt = 0;
let toolAnsweredAt = 0;
let audioWhileHolding = 0;
let extraCallsWhileHolding = 0;
let transcriptWhileHolding = '';

ws.addEventListener('open', () => ws.send(JSON.stringify(setupMessage(setup))));
ws.addEventListener('error', (e) => fail('socket', String((e as ErrorEvent).message ?? e)));
ws.addEventListener('close', (e) => {
  if (!(sawSetup && sawToolCall && sawAudio)) fail('close', `code=${e.code} reason=${e.reason} setup=${sawSetup} toolCall=${sawToolCall} audio=${sawAudio}`);
});
ws.addEventListener('message', async (event) => {
  const data = await frameText(event.data);
  for (const ev of classify(JSON.parse(data))) {
    if (ev.type === 'setupComplete') {
      sawSetup = true;
      console.log('ok  setupComplete (constraints accepted: audio, tools with NON_BLOCKING, compression, resumption, transcription)');
      ws.send(JSON.stringify(textTurnMessage('Please tell Claude: run the smoke test and report the result.')));
    } else if (ev.type === 'toolCall') {
      const post = ev.calls.find((c) => c.name === 'post_to_channel');
      const others = ev.calls.filter((c) => c.name !== 'post_to_channel');
      // Anything the model asks for while the first answer is held is evidence it did not block.
      if (toolCallAt && !toolAnsweredAt) extraCallsWhileHolding += ev.calls.length;
      for (const c of others) {
        ws.send(JSON.stringify(toolResponse([{ id: c.id, name: c.name, response: c.name === 'wait_for_reply' ? { waiting: true } : { ok: true }, scheduling: 'SILENT', willContinue: false }])));
      }
      if (!post) continue;
      if (sawToolCall) continue;
      sawToolCall = true;
      toolCallAt = Date.now();
      console.log(`ok  toolCall post_to_channel args=${JSON.stringify(post.args)}${holdMs ? ` (holding the answer ${holdMs} ms)` : ''}`);
      setTimeout(() => {
        toolAnsweredAt = Date.now();
        if (holdMs) {
          const busy = audioWhileHolding > 0 || extraCallsWhileHolding > 0;
          console.log(`    while holding: ${audioWhileHolding} audio chunks, ${extraCallsWhileHolding} further tool calls, said: ${JSON.stringify(transcriptWhileHolding.trim())} → ${busy ? 'NON_BLOCKING honoured (model carried on)' : 'model went silent (blocking)'}`);
        }
        ws.send(JSON.stringify(toolResponse([{ id: post.id, name: post.name, response: { posted: true }, scheduling: 'INTERRUPT' }])));
      }, holdMs);
    } else if (ev.type === 'audio') {
      if (toolCallAt && !toolAnsweredAt) audioWhileHolding++;
      if (!sawAudio && (toolAnsweredAt || !holdMs)) { sawAudio = true; console.log(`ok  audio back (${ev.mimeType})`); }
    } else if (ev.type === 'outputTranscript') {
      if (toolCallAt && !toolAnsweredAt) transcriptWhileHolding += ev.text;
      else console.log(`    desk says: ${ev.text}`);
    }
    if (sawSetup && sawToolCall && sawAudio) {
      clearTimeout(timeout);
      console.log('smoke PASSED');
      ws.close();
      process.exit(0);
    }
  }
});
