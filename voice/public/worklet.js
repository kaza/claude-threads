/**
 * voice-desk capture processor: hands 50 ms of mono float samples at the
 * AudioContext's rate to the main thread, which downsamples to 16 kHz PCM.
 */
class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = [];
    this.buffered = 0;
    this.chunk = Math.round(sampleRate * 0.05);
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel) return true;
    this.buffer.push(new Float32Array(channel));
    this.buffered += channel.length;
    if (this.buffered >= this.chunk) {
      const out = new Float32Array(this.buffered);
      let offset = 0;
      for (const part of this.buffer) { out.set(part, offset); offset += part.length; }
      this.buffer = [];
      this.buffered = 0;
      this.port.postMessage(out, [out.buffer]);
    }
    return true;
  }
}

registerProcessor('voice-desk-capture', CaptureProcessor);
