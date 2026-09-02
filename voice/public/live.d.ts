/** Types for live.js — the browser-side protocol helpers (see live.js for behaviour). */

export type LiveEvent =
  | { type: 'setupComplete' }
  | { type: 'audio'; data: string; mimeType: string }
  | { type: 'inputTranscript'; text: string }
  | { type: 'outputTranscript'; text: string }
  | { type: 'interrupted' }
  | { type: 'turnComplete' }
  | { type: 'toolCall'; calls: Array<{ id: string; name: string; args: Record<string, unknown> }> }
  | { type: 'toolCallCancellation'; ids: string[] }
  | { type: 'goAway'; timeLeft: string | null }
  | { type: 'resumption'; handle: string | null; resumable: boolean }
  | { type: 'other' };

export interface ToolResponseEntry {
  id: string;
  name: string;
  response: Record<string, unknown>;
  scheduling?: 'INTERRUPT' | 'WHEN_IDLE' | 'SILENT';
  willContinue?: boolean;
}

export function classify(message: unknown): LiveEvent[];
export function toolResponse(entries: ToolResponseEntry[]): { toolResponse: { functionResponses: Array<Record<string, unknown>> } };
export function setupMessage(setup: unknown): { setup: unknown };
export function audioChunkMessage(base64Pcm16k: string): { realtimeInput: { audio: { data: string; mimeType: string } } };
export function audioStreamEndMessage(): { realtimeInput: { audioStreamEnd: true } };
export function textTurnMessage(text: string): { clientContent: { turns: Array<{ role: string; parts: Array<{ text: string }> }>; turnComplete: true } };
export function floatTo16BitPCM(float32: Float32Array): Int16Array;
export function pcm16ToFloat(int16: Int16Array): Float32Array;
export function downsample(float32: Float32Array, fromRate: number, toRate: number): Float32Array;
export function int16ToBase64(int16: Int16Array): string;
export function base64ToInt16(base64: string): Int16Array;
export function rateOf(mimeType: string | undefined): number;
