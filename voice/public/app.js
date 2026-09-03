/**
 * voice-desk browser client. See docs/voice-desk-spec.md.
 *
 * Talk → POST calls → open the constrained Gemini Live socket with the
 * one-use token → send the locked setup → stream 16 kHz PCM up, play 24 kHz
 * PCM down → answer tool calls through the server → reconnect on goAway /
 * close with the last resumable handle.
 */

import {
  audioChunkMessage,
  audioStreamEndMessage,
  base64ToInt16,
  classify,
  downsample,
  floatTo16BitPCM,
  frameText,
  int16ToBase64,
  pcm16ToFloat,
  rateOf,
  setupMessage,
  toolResponse,
} from './live.js';

const LIVE_WS = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained';
const RECONNECT_BACKOFF_MS = [1000, 2000, 4000];

const $ = (id) => document.getElementById(id);
const el = { signin: $('signin'), desk: $('desk'), who: $('who'), logout: $('logout'), channel: $('channel'), talk: $('talk'), hangup: $('hangup'), status: $('status'), transcript: $('transcript'), error: $('error') };

function say(kind, text) {
  const li = document.createElement('li');
  li.className = kind;
  li.textContent = text;            // never innerHTML: replies and errors are untrusted
  el.transcript.appendChild(li);
  el.transcript.scrollTop = el.transcript.scrollHeight;
}
function status(text) { el.status.textContent = text; }
function showError(err) { el.error.hidden = false; el.error.textContent = String(err?.message ?? err); }
function clearError() { el.error.hidden = true; el.error.textContent = ''; }

// Server long-polls last at most 25 s; anything past 40 s is a hung connection, not a slow answer.
const API_TIMEOUT_MS = 40000;

async function api(path, body) {
  const signal = AbortSignal.timeout(API_TIMEOUT_MS);
  const res = await fetch(path, body === undefined
    ? { credentials: 'same-origin', signal }
    : { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal });
  if (res.status === 401) { showSignedOut(); throw new Error('signed out; sign in again'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

function showSignedOut() {
  const wanted = new URLSearchParams(location.search).get('channel');
  if (wanted) sessionStorage.setItem('voice.channel', wanted);
  el.signin.hidden = false;
  el.desk.hidden = true;
}

// ---------------------------------------------------------------------------
// The call
// ---------------------------------------------------------------------------

let call = null; // { callId, setup, ws, audio: { ctx, worklet, stream, playhead }, handle, reconnecting, pendingWaits: Map, ended }

async function startCall() {
  clearError();
  const channel = el.channel.value;
  if (!channel) throw new Error('pick a channel first');
  el.talk.disabled = true;
  status('starting…');
  // The AudioContext is created inside the click, before any await, so the
  // browser's autoplay policy lets it run; resume() covers the suspended case.
  const ctx = new AudioContext();
  await ctx.resume().catch(() => undefined);
  const created = await api('calls', { channel });
  call = { callId: created.callId, setup: created.setup, ws: null, audio: null, handle: null, reconnecting: false, ended: false, ready: false, tries: 0 };
  try {
    await openMicrophone(ctx);
    await connect(created.token, created.setup);
  } catch (err) {
    // Nothing half-open: release the microphone, drop the server-side call, then report.
    const failed = call;
    call = null;
    try { failed.ws?.close(); } catch { /* not open */ }
    await closeMicrophone(failed);
    await api(`calls/${failed.callId}/end`, {}).catch(() => undefined);
    throw err;
  }
  el.hangup.hidden = false;
  say('note', `Connected to #${el.channel.options[el.channel.selectedIndex].textContent}. Speak.`);
}

async function connect(token, setup) {
  // The setup must be exactly what the token was constrained with; on a
  // reconnect that includes the resumption handle, so it always travels with the token.
  call.setup = setup;
  call.ready = false;
  const ws = new WebSocket(`${LIVE_WS}?access_token=${encodeURIComponent(token)}`);
  call.ws = ws;
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('could not reach Gemini Live')), { once: true });
  });
  ws.send(JSON.stringify(setupMessage(call.setup)));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Gemini did not complete setup')), 10000);
    const onMessage = async (event) => {
      const data = await frameText(event.data);
      if (JSON.parse(data).setupComplete) { clearTimeout(timer); ws.removeEventListener('message', onMessage); resolve(); }
    };
    ws.addEventListener('message', onMessage);
  });
  ws.addEventListener('message', (event) => void onServerMessage(event));
  ws.addEventListener('close', (event) => void onSocketClosed(ws, event));
  call.ready = true; // only now may audio flow (setupComplete seen)
  call.tries = 0;
  status('listening');
}

async function onServerMessage(event) {
  const data = await frameText(event.data);
  for (const ev of classify(JSON.parse(data))) {
    switch (ev.type) {
      case 'audio': playChunk(ev.data, rateOf(ev.mimeType)); break;
      case 'interrupted': flushPlayback(); break;
      case 'inputTranscript': say('you', ev.text); break;
      case 'outputTranscript': say('desk', ev.text); break;
      case 'toolCall': for (const c of ev.calls) void runTool(c); break;
      case 'toolCallCancellation': for (const id of ev.ids) call.cancelled?.add(id); break;
      case 'resumption': if (ev.resumable && ev.handle) call.handle = ev.handle; break;
      case 'goAway': status('reconnecting…'); void reconnect(); break;
      case 'turnComplete': if (call.goodbyePending) { call.goodbyePending = false; void hangUp(false); } break;
      default: break;
    }
  }
}

async function onSocketClosed(ws, event) {
  // A close of a socket we already replaced (goAway reconnect) is not news.
  if (!call || call.ended || call.reconnecting || ws !== call.ws) return;
  status(`reconnecting… (socket closed ${event.code})`);
  await reconnect();
}

async function reconnect() {
  if (!call || call.ended || call.reconnecting) return;
  call.reconnecting = true;
  try {
    while (call.tries < RECONNECT_BACKOFF_MS.length) {
      await new Promise((r) => setTimeout(r, RECONNECT_BACKOFF_MS[call.tries++]));
      try {
        const fresh = await api(`calls/${call.callId}/token`, { resume: call.handle ?? '' });
        try { call.ws?.close(); } catch { /* already closed */ }
        await connect(fresh.token, fresh.setup);
        say('note', call.handle ? 'Reconnected.' : 'Reconnected as a fresh session (no resumable handle).');
        return;
      } catch (err) {
        showError(err);
      }
    }
    say('note', 'Could not reconnect. Hang up and try again.');
    status('disconnected');
  } finally {
    if (call) call.reconnecting = false;
  }
}

async function runTool(c) {
  call.cancelled = call.cancelled ?? new Set();
  try {
    let result = await api(`calls/${call.callId}/tool`, { id: c.id, name: c.name, args: c.args });
    // wait_for_reply: keep the function open until something lands.
    while (result.ok && result.willContinue) {
      if (call.cancelled.has(c.id) || call.ended) return;
      send(toolResponse([{ id: c.id, name: c.name, response: result.result, scheduling: result.scheduling, willContinue: true }]));
      result = await api(`calls/${call.callId}/tool`, { id: c.id, name: c.name, args: c.args });
    }
    if (call.cancelled.has(c.id)) return;
    const response = result.ok ? result.result : { error: result.error };
    send(toolResponse([{ id: c.id, name: c.name, response, scheduling: result.scheduling, willContinue: false }]));
    if (c.name === 'end_call') {
      // Let the goodbye turn finish (turnComplete), with a ceiling so a silent model cannot keep the call open.
      call.goodbyePending = true;
      setTimeout(() => { if (call?.goodbyePending) { call.goodbyePending = false; void hangUp(false); } }, 8000);
    }
    if (c.name === 'post_to_channel' && result.ok) say('note', 'Posted to the channel.');
    if (c.name === 'wait_for_reply' && result.ok && result.result.replies) for (const r of result.result.replies) say('desk', `Claude${r.updated ? ' (updated)' : ''}: ${r.text}`);
  } catch (err) {
    showError(err);
    send(toolResponse([{ id: c.id, name: c.name, response: { error: String(err.message ?? err) }, scheduling: 'INTERRUPT', willContinue: false }]));
  }
}

function send(message) {
  if (call?.ws?.readyState === WebSocket.OPEN) call.ws.send(JSON.stringify(message));
}

async function hangUp(tellServer = true) {
  if (!call) return;
  const current = call;
  call.ended = true;
  try { send(audioStreamEndMessage()); } catch { /* socket may be gone */ }
  try { current.ws?.close(); } catch { /* ignore */ }
  await closeMicrophone(current);
  if (tellServer) { try { await api(`calls/${current.callId}/end`, {}); } catch (err) { showError(err); } }
  call = null;
  el.hangup.hidden = true;
  el.talk.disabled = false;
  status('idle');
  say('note', 'Call ended.');
}

// ---------------------------------------------------------------------------
// Audio
// ---------------------------------------------------------------------------

async function openMicrophone(ctx) {
  await ctx.audioWorklet.addModule('static/worklet.js');
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
  const source = ctx.createMediaStreamSource(stream);
  const worklet = new AudioWorkletNode(ctx, 'voice-desk-capture');
  worklet.port.onmessage = (event) => {
    // No audio before setupComplete: Gemini requires setup first (review finding 3).
    if (!call || call.ended || !call.ready || call.ws?.readyState !== WebSocket.OPEN) return;
    if (call.ws.bufferedAmount > 256 * 1024) return; // backpressure: drop rather than queue seconds of audio
    const pcm = floatTo16BitPCM(downsample(event.data, ctx.sampleRate, 16000));
    send(audioChunkMessage(int16ToBase64(pcm)));
  };
  source.connect(worklet);
  worklet.connect(ctx.destination); // keeps the graph alive; the worklet outputs silence
  call.audio = { ctx, worklet, stream, source, playhead: 0, sources: new Set() };
}

async function closeMicrophone(c) {
  if (!c.audio) return;
  for (const t of c.audio.stream.getTracks()) t.stop();
  try { c.audio.source.disconnect(); c.audio.worklet.disconnect(); } catch { /* ignore */ }
  await c.audio.ctx.close();
}

function playChunk(base64, rate) {
  const a = call?.audio;
  if (!a) return;
  const samples = pcm16ToFloat(base64ToInt16(base64));
  const buffer = a.ctx.createBuffer(1, samples.length, rate);
  buffer.copyToChannel(samples, 0);
  // Bound the queue: more than six seconds ahead means the context was
  // throttled or suspended, and playing that backlog later would be stale.
  if (a.playhead - a.ctx.currentTime > 6) return;
  const node = a.ctx.createBufferSource();
  node.buffer = buffer;
  node.connect(a.ctx.destination);
  const startAt = Math.max(a.ctx.currentTime + 0.02, a.playhead);
  node.start(startAt);
  a.playhead = startAt + buffer.duration;
  a.sources.add(node);
  node.onended = () => a.sources.delete(node);
}

function flushPlayback() {
  const a = call?.audio;
  if (!a) return;
  for (const node of a.sources) { try { node.stop(); } catch { /* already stopped */ } }
  a.sources.clear();
  a.playhead = 0;
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

async function init() {
  el.talk.addEventListener('click', () => startCall().catch((err) => { showError(err); el.talk.disabled = false; status('idle'); }));
  el.hangup.addEventListener('click', () => void hangUp(true));
  el.logout.addEventListener('click', async () => {
    if (call) await hangUp(true);   // never leave the microphone or the Gemini session running
    api('logout', {}).then(showSignedOut).catch(showError);
  });
  window.addEventListener('pagehide', () => { if (call) navigator.sendBeacon?.(`calls/${call.callId}/end`, new Blob(['{}'], { type: 'application/json' })); });
  try {
    const me = await api('me');
    el.who.textContent = me.name;
    const { channels } = await api('channels');
    el.channel.replaceChildren(...channels.map((c) => { const o = document.createElement('option'); o.value = c.id; o.textContent = c.name; return o; }));
    // ?channel= from a !voice link or the Slack shortcut; the Slack sign-in
    // round trip drops the query, so it is parked in sessionStorage meanwhile.
    const wanted = new URLSearchParams(location.search).get('channel') ?? sessionStorage.getItem('voice.channel');
    sessionStorage.removeItem('voice.channel');
    if (wanted && channels.some((c) => c.id === wanted)) el.channel.value = wanted;
    if (channels.length === 0) say('note', 'No task channels yet: invite the Claude Code bot to a channel and @-mention it once.');
    el.desk.hidden = false;
    el.signin.hidden = true;
  } catch (err) {
    if (!/signed out/.test(String(err.message))) showError(err);
    showSignedOut();
  }
}

init();
