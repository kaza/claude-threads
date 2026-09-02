/**
 * voice-desk: the browser-side protocol helpers, tested under bun.
 * See docs/voice-desk-spec.md test 13.
 */

import { describe, test, expect } from 'bun:test';
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
  textTurnMessage,
  toolResponse,
} from './public/live.js';

describe('classify: server messages become plain events', () => {
  test('setupComplete', () => {
    expect(classify({ setupComplete: {} })).toEqual([{ type: 'setupComplete' }]);
  });

  test('audio parts, transcriptions, interruption and turn end', () => {
    const events = classify({
      serverContent: {
        modelTurn: { parts: [{ inlineData: { data: 'AAAA', mimeType: 'audio/pcm;rate=24000' } }, { text: 'ignored' }] },
        outputTranscription: { text: 'Posted.' },
        inputTranscription: { text: 'rerun it' },
        interrupted: true,
        turnComplete: true,
      },
    });

    expect(events).toEqual([
      { type: 'audio', data: 'AAAA', mimeType: 'audio/pcm;rate=24000' },
      { type: 'inputTranscript', text: 'rerun it' },
      { type: 'outputTranscript', text: 'Posted.' },
      { type: 'interrupted' },
      { type: 'turnComplete' },
    ]);
  });

  test('several function calls in one toolCall, and a cancellation', () => {
    expect(classify({ toolCall: { functionCalls: [{ id: 'a', name: 'post_to_channel', args: { text: 'x' } }, { id: 'b', name: 'wait_for_reply' }] } })).toEqual([
      { type: 'toolCall', calls: [{ id: 'a', name: 'post_to_channel', args: { text: 'x' } }, { id: 'b', name: 'wait_for_reply', args: {} }] },
    ]);
    expect(classify({ toolCallCancellation: { ids: ['a'] } })).toEqual([{ type: 'toolCallCancellation', ids: ['a'] }]);
  });

  test('goAway and resumption updates, keeping only what matters', () => {
    expect(classify({ goAway: { timeLeft: '10s' } })).toEqual([{ type: 'goAway', timeLeft: '10s' }]);
    expect(classify({ sessionResumptionUpdate: { newHandle: 'h1', resumable: true } })).toEqual([{ type: 'resumption', handle: 'h1', resumable: true }]);
    expect(classify({ sessionResumptionUpdate: { newHandle: 'h2' } })).toEqual([{ type: 'resumption', handle: 'h2', resumable: false }]);
  });

  test('anything else is "other"', () => {
    expect(classify({ usageMetadata: {} })).toEqual([{ type: 'other' }]);
  });
});

describe('client messages', () => {
  test('toolResponse puts scheduling and willContinue beside response, not inside it', () => {
    const message = toolResponse([
      { id: 'a', name: 'post_to_channel', response: { posted: true }, scheduling: 'SILENT' },
      { id: 'b', name: 'wait_for_reply', response: { waiting: true }, scheduling: 'SILENT', willContinue: true },
      { id: 'c', name: 'end_call', response: { ended: true } },
    ]);

    expect(message).toEqual({
      toolResponse: {
        functionResponses: [
          { id: 'a', name: 'post_to_channel', response: { posted: true }, scheduling: 'SILENT' },
          { id: 'b', name: 'wait_for_reply', response: { waiting: true }, scheduling: 'SILENT', willContinue: true },
          { id: 'c', name: 'end_call', response: { ended: true } },
        ],
      },
    });
  });

  test('setup, audio chunk, stream end and text turn shapes', () => {
    expect(setupMessage({ model: 'models/m' })).toEqual({ setup: { model: 'models/m' } });
    expect(audioChunkMessage('QUJD')).toEqual({ realtimeInput: { audio: { data: 'QUJD', mimeType: 'audio/pcm;rate=16000' } } });
    expect(audioStreamEndMessage()).toEqual({ realtimeInput: { audioStreamEnd: true } });
    expect(textTurnMessage('hi')).toEqual({ clientContent: { turns: [{ role: 'user', parts: [{ text: 'hi' }] }], turnComplete: true } });
  });
});

describe('frameText', () => {
  test('reads a string, a Blob and a raw buffer alike', async () => {
    expect(await frameText('{"a":1}')).toBe('{"a":1}');
    expect(await frameText(new Blob(['{"b":2}']))).toBe('{"b":2}');
    expect(await frameText(new TextEncoder().encode('{"c":3}').buffer)).toBe('{"c":3}');
  });
});

describe('PCM helpers', () => {
  test('float → int16 clips and scales, and round-trips through base64', () => {
    const int16 = floatTo16BitPCM(new Float32Array([0, 0.5, -0.5, 1.5, -1.5]));

    expect(Array.from(int16)).toEqual([0, 16384, -16384, 32767, -32768]);
    expect(Array.from(base64ToInt16(int16ToBase64(int16)))).toEqual(Array.from(int16));
    const back = pcm16ToFloat(int16);
    expect(back[3]).toBeCloseTo(1, 4);
    expect(back[4]).toBeCloseTo(-1, 4);
  });

  test('downsampling 48 kHz → 16 kHz keeps a third of the samples and averages neighbours', () => {
    const input = new Float32Array([0, 0.3, 0.6, 0.9, 0.9, 0.9]);

    const out = downsample(input, 48000, 16000);

    expect(out.length).toBe(2);
    expect(out[0]).toBeCloseTo(0.3, 5);
    expect(out[1]).toBeCloseTo(0.9, 5);
  });

  test('downsampling refuses to upsample and passes equal rates through', () => {
    const input = new Float32Array([0.1, 0.2]);
    expect(downsample(input, 16000, 16000)).toBe(input);
    expect(() => downsample(input, 16000, 48000)).toThrow(/upsample/);
  });

  test('rateOf reads the sample rate from the mime type', () => {
    expect(rateOf('audio/pcm;rate=24000')).toBe(24000);
    expect(rateOf('audio/pcm')).toBe(24000);
    expect(rateOf(undefined)).toBe(24000);
  });
});
