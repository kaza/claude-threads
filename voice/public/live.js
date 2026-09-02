/**
 * voice-desk: pure helpers for the Gemini Live wire protocol and PCM audio.
 * Runs in the browser (ES module) and under bun test. No DOM, no sockets.
 * See docs/voice-desk-spec.md § Wire shapes.
 */

/** Turn one server message into a list of plain events the app can act on. */
export function classify(message) {
  const events = [];
  if (message.setupComplete) events.push({ type: 'setupComplete' });
  const content = message.serverContent;
  if (content) {
    for (const part of content.modelTurn?.parts ?? []) {
      if (part.inlineData?.data) events.push({ type: 'audio', data: part.inlineData.data, mimeType: part.inlineData.mimeType ?? '' });
    }
    if (content.inputTranscription?.text) events.push({ type: 'inputTranscript', text: content.inputTranscription.text });
    if (content.outputTranscription?.text) events.push({ type: 'outputTranscript', text: content.outputTranscription.text });
    if (content.interrupted) events.push({ type: 'interrupted' });
    if (content.turnComplete) events.push({ type: 'turnComplete' });
  }
  if (message.toolCall?.functionCalls?.length) {
    events.push({
      type: 'toolCall',
      calls: message.toolCall.functionCalls.map((c) => ({ id: c.id, name: c.name, args: c.args ?? {} })),
    });
  }
  if (message.toolCallCancellation?.ids?.length) events.push({ type: 'toolCallCancellation', ids: [...message.toolCallCancellation.ids] });
  if (message.goAway) events.push({ type: 'goAway', timeLeft: message.goAway.timeLeft ?? null });
  if (message.sessionResumptionUpdate) {
    events.push({
      type: 'resumption',
      handle: message.sessionResumptionUpdate.newHandle ?? null,
      resumable: message.sessionResumptionUpdate.resumable === true,
    });
  }
  if (events.length === 0) events.push({ type: 'other' });
  return events;
}

/**
 * The client → server envelope answering one or more function calls.
 * `scheduling` and `willContinue` are siblings of `response`, per the
 * FunctionResponse schema.
 */
export function toolResponse(entries) {
  return {
    toolResponse: {
      functionResponses: entries.map((e) => {
        const out = { id: e.id, name: e.name, response: e.response };
        if (e.scheduling) out.scheduling = e.scheduling;
        if (e.willContinue !== undefined) out.willContinue = e.willContinue;
        return out;
      }),
    },
  };
}

/** The first client message: the exact setup the token was constrained with. */
export function setupMessage(setup) {
  return { setup };
}

export function audioChunkMessage(base64Pcm16k) {
  return { realtimeInput: { audio: { data: base64Pcm16k, mimeType: 'audio/pcm;rate=16000' } } };
}

export function audioStreamEndMessage() {
  return { realtimeInput: { audioStreamEnd: true } };
}

/** A typed text turn (used by the smoke test and as a fallback input). */
export function textTurnMessage(text) {
  return { clientContent: { turns: [{ role: 'user', parts: [{ text }] }], turnComplete: true } };
}

// ---------------------------------------------------------------------------
// PCM
// ---------------------------------------------------------------------------

/** Float samples in [-1, 1] → signed 16-bit little-endian, clipped. */
export function floatTo16BitPCM(float32) {
  const out = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    out[i] = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
  }
  return out;
}

/** Signed 16-bit little-endian → float samples in [-1, 1]. */
export function pcm16ToFloat(int16) {
  const out = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) out[i] = int16[i] / (int16[i] < 0 ? 0x8000 : 0x7fff);
  return out;
}

/**
 * Downsample by averaging the input samples that map onto each output
 * sample. Good enough for speech at 48 kHz → 16 kHz; no aliasing filter
 * beyond the box average.
 */
export function downsample(float32, fromRate, toRate) {
  if (fromRate === toRate) return float32;
  if (fromRate < toRate) throw new Error('downsample cannot upsample');
  const ratio = fromRate / toRate;
  const length = Math.floor(float32.length / ratio);
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(float32.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end; j++) sum += float32[j];
    out[i] = end > start ? sum / (end - start) : 0;
  }
  return out;
}

export function int16ToBase64(int16) {
  const bytes = new Uint8Array(int16.buffer, int16.byteOffset, int16.byteLength);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export function base64ToInt16(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Int16Array(bytes.buffer, 0, Math.floor(bytes.length / 2));
}

/** Sample rate from a mimeType like `audio/pcm;rate=24000`, default 24000. */
export function rateOf(mimeType) {
  const m = /rate=(\d+)/.exec(mimeType ?? '');
  return m ? Number(m[1]) : 24000;
}
