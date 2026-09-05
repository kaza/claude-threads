/**
 * Transcription entry point: one factory from config to a Transcriber.
 * Config errors throw here so a bad `transcription:` block fails the boot,
 * not the first voice note.
 */

import { ElevenLabsTranscriber } from './elevenlabs.js';
import type { SpeechConfig, Transcriber, TranscriptionConfig } from './types.js';

export type { SpeechConfig, Transcriber, TranscribeInput, Transcript, TranscriptionConfig } from './types.js';
export { isTranscribable } from './types.js';

/** Validate the `speech:` block at boot: a half-configured block fails the start, not the first "speak". */
export function validateSpeechConfig(config: SpeechConfig): SpeechConfig {
  if (!config.voiceId || typeof config.voiceId !== 'string') {
    throw new Error('speech.voiceId is required (an ElevenLabs voice id)');
  }
  return config;
}

export function createTranscriber(config: TranscriptionConfig): Transcriber {
  if (config.provider !== 'elevenlabs') {
    throw new Error(`transcription.provider must be "elevenlabs", got "${String(config.provider)}"`);
  }
  // Whitespace counts as missing: a key that is `" "` fails the boot here
  // rather than at the first voice note, which is the whole point of
  // validating in a factory.
  if (typeof config.apiKey !== 'string' || config.apiKey.trim() === '') {
    throw new Error('transcription.apiKey is required');
  }
  return new ElevenLabsTranscriber(config);
}
