/**
 * Converts a Float32Array (PCM audio) from the microphone to base64.
 */
export function pcmToBase64(pcmData: Float32Array): string {
  const buffer = new ArrayBuffer(pcmData.length * 2);
  const view = new DataView(buffer);
  
  for (let i = 0; i < pcmData.length; i++) {
    // Clamp between -1 and 1
    const s = Math.max(-1, Math.min(1, pcmData[i]));
    // Convert to 16-bit PCM
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
  }
  
  // Convert ArrayBuffer to binary string
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
  }
  
  return btoa(binary);
}

/**
 * Decodes base64 string back into Float32Array for playback or further processing.
 */
export function base64ToPcm(base64: string): Float32Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  
  const buffer = bytes.buffer;
  const view = new DataView(buffer);
  const pcmData = new Float32Array(buffer.byteLength / 2);
  
  for (let i = 0; i < pcmData.length; i++) {
    const int16 = view.getInt16(i * 2, true);
    pcmData[i] = int16 < 0 ? int16 / 0x8000 : int16 / 0x7FFF;
  }
  
  return pcmData;
}

/**
 * Creates an audio buffer from PCM data.
 */
export function createAudioBuffer(ctx: AudioContext, pcmData: Float32Array): AudioBuffer {
  const buffer = ctx.createBuffer(1, pcmData.length, ctx.sampleRate);
  buffer.getChannelData(0).set(pcmData);
  return buffer;
}
