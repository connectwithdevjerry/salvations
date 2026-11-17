/**
 * Raw speech played as it arrives.
 *
 * A browser given a streamed MP3 waits for a couple of seconds of it before
 * it makes a sound. Raw 16-bit samples need no such wait: each piece that
 * arrives is scheduled through Web Audio straight after the one before, so
 * Jarvis starts talking at the first piece.
 */

/** Little-endian 16-bit samples as floats, and the odd byte left for the next piece. */
export function pcm16ToFloat32(bytes: Uint8Array, carry: Uint8Array | undefined): { samples: Float32Array; carry: Uint8Array | undefined } {
  const all = carry === undefined ? bytes : concat(carry, bytes);
  const whole = all.length - (all.length % 2);
  const samples = new Float32Array(whole / 2);
  const view = new DataView(all.buffer, all.byteOffset, whole);
  for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true) / 32768;
  return { samples, carry: whole < all.length ? all.slice(whole) : undefined };
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

/** Enough to schedule without a node per network packet; well under a tenth of a second. */
const MIN_SAMPLES = 2_048;

export interface PcmPlayback {
  /** Resolves once the last sample has played, or the stream was stopped; false when nothing played at all. */
  readonly finished: Promise<boolean>;
  stop(): void;
}

/** Plays a stream of raw samples through `context` as it arrives. */
export function playPcmStream(context: AudioContext, body: ReadableStream<Uint8Array>, sampleRate: number): PcmPlayback {
  const sources: AudioBufferSourceNode[] = [];
  let stopped = false;
  const reader = body.getReader();

  const finished = (async () => {
    let carry: Uint8Array | undefined;
    let pending: Float32Array[] = [];
    let pendingLength = 0;
    let at = 0;
    let played = false;

    const flush = () => {
      if (pendingLength === 0 || stopped) return;
      const buffer = context.createBuffer(1, pendingLength, sampleRate);
      const channel = buffer.getChannelData(0);
      let offset = 0;
      for (const part of pending) { channel.set(part, offset); offset += part.length; }
      pending = [];
      pendingLength = 0;
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(context.destination);
      // A breath of lead on the first piece; each after starts where the last ends.
      at = Math.max(at, context.currentTime + 0.03);
      source.start(at);
      at += buffer.duration;
      sources.push(source);
      played = true;
    };

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done || stopped) break;
        const converted = pcm16ToFloat32(value, carry);
        carry = converted.carry;
        pending.push(converted.samples);
        pendingLength += converted.samples.length;
        if (pendingLength >= MIN_SAMPLES) flush();
      }
      flush();
    } catch {
      // The stream broke off: what arrived still plays.
    }
    if (!played || stopped) return played;
    const last = sources[sources.length - 1]!;
    await new Promise<void>((resolve) => {
      last.onended = () => resolve();
      // A stop() before the end resolves too.
      const poll = setInterval(() => { if (stopped) { clearInterval(poll); resolve(); } }, 200);
      last.addEventListener('ended', () => clearInterval(poll));
    });
    return true;
  })();

  return {
    finished,
    stop() {
      stopped = true;
      void reader.cancel().catch(() => undefined);
      for (const source of sources) { try { source.stop(); } catch { /* not started yet, or done */ } }
    },
  };
}
