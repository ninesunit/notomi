/**
 * Ambient soundscapes, synthesised rather than streamed.
 *
 * Every one of these is built from noise and oscillators in the browser, so
 * Notomi ships no audio files, downloads nothing when a student presses play,
 * and costs nothing to serve. A three-minute rain loop would be about four
 * megabytes — more than the entire app bundle — and would come out of the same
 * free hosting allowance as the app itself.
 *
 * The trade is honest: these are impressions of rain and fire, not recordings.
 * That turns out to be what a focus track wants anyway, because there is no
 * loop point to notice and no melody to follow.
 */

export type AmbientId = 'brown' | 'rain' | 'fire' | 'waves' | 'lofi' | 'cafe';

export const AMBIENT: { id: AmbientId; label: string; hint: string }[] = [
  { id: 'brown', label: 'Deep hum', hint: 'Soft brown noise. The quietest of these.' },
  { id: 'rain', label: 'Rain', hint: 'Steady rain with the gusts coming and going.' },
  { id: 'fire', label: 'Fireplace', hint: 'A low fire, crackling now and then.' },
  { id: 'waves', label: 'Ocean', hint: 'Slow waves, about eight a minute.' },
  { id: 'lofi', label: 'Lo-fi', hint: 'A warm four-chord loop under vinyl crackle.' },
  { id: 'cafe', label: 'Café', hint: 'Room tone and distant murmur.' },
];

export type AmbientHandle = { stop: () => void };

type Ctx = AudioContext;

function audioContext(): Ctx | null {
  if (typeof window === 'undefined') return null;
  const Context =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  return Context ? new Context() : null;
}

/**
 * Two seconds of noise, looped.
 *
 * `beta` is the integrator coefficient: zero is white, and the closer to one
 * the more the signal remembers, which is what turns hiss into rumble.
 */
function noiseBuffer(context: Ctx, beta: number, seconds = 8): AudioBuffer {
  const buffer = context.createBuffer(1, Math.floor(context.sampleRate * seconds), context.sampleRate);
  const data = buffer.getChannelData(0);
  let last = 0;
  let peak = 0.0001;
  for (let index = 0; index < data.length; index += 1) {
    const white = Math.random() * 2 - 1;
    // beta=0 is white noise; values near one retain the previous sample and
    // become progressively warmer. The old equation multiplied the *new*
    // sample by beta, so beta=0 produced a buffer of literal silence — which
    // is why rain, vinyl and the café bed sounded missing or thin.
    last = beta * last + (1 - beta) * white;
    data[index] = last;
    peak = Math.max(peak, Math.abs(last));
  }
  // Normalised, because the coefficient changes the amplitude by an order of
  // magnitude and every preset should arrive at the mixer the same size.
  for (let index = 0; index < data.length; index += 1) data[index] /= peak;
  return buffer;
}

function noiseSource(context: Ctx, beta: number): AudioBufferSourceNode {
  const source = context.createBufferSource();
  source.buffer = noiseBuffer(context, beta);
  source.loop = true;
  return source;
}

/** A slow sine that modulates something, rather than being heard itself. */
function lfo(context: Ctx, frequency: number, depth: number, offset: number) {
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.frequency.value = frequency;
  gain.gain.value = depth;
  oscillator.connect(gain);
  oscillator.start();
  return { oscillator, gain, offset };
}

export function startAmbient(id: AmbientId, volume = 0.5): AmbientHandle | null {
  const context = audioContext();
  if (!context) return null;

  const master = context.createGain();
  master.gain.value = 0;
  master.connect(context.destination);

  const stops: (() => void)[] = [];
  const timers: ReturnType<typeof setInterval>[] = [];

  const build = BUILDERS[id] ?? BUILDERS.brown;
  const trim = build(context, master, stops, timers);

  // Faded in over a second and a half. An ambient track that starts at full
  // level is a jolt, which is the opposite of the point.
  const target = Math.max(0, Math.min(1, volume)) * trim;
  master.gain.setValueAtTime(0.0001, context.currentTime);
  master.gain.exponentialRampToValueAtTime(Math.max(0.0002, target), context.currentTime + 1.5);

  let stopped = false;
  return {
    stop() {
      if (stopped) return;
      stopped = true;
      for (const timer of timers) clearInterval(timer);
      try {
        master.gain.cancelScheduledValues(context.currentTime);
        master.gain.setValueAtTime(master.gain.value, context.currentTime);
        master.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.4);
      } catch {
        /* A context already closing cannot be ramped; it is going anyway. */
      }
      // Let the fade finish before tearing the graph down.
      setTimeout(() => {
        for (const halt of stops) {
          try {
            halt();
          } catch {
            /* Already stopped. */
          }
        }
        void context.close().catch(() => undefined);
      }, 500);
    },
  };
}

/** Each builder wires itself to `out` and returns its own level trim. */
type Builder = (
  context: Ctx,
  out: GainNode,
  stops: (() => void)[],
  timers: ReturnType<typeof setInterval>[]
) => number;

const BUILDERS: Record<AmbientId, Builder> = {
  brown(context, out, stops) {
    const source = noiseSource(context, 0.985);
    const filter = context.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 800;
    source.connect(filter).connect(out);
    source.start();
    stops.push(() => source.stop());
    return 0.28;
  },

  rain(context, out, stops) {
    // The hiss of drops on a surface: white noise with the very top rolled off
    // so it reads as water rather than as static.
    const drops = noiseSource(context, 0.0);
    const dropFilter = context.createBiquadFilter();
    dropFilter.type = 'bandpass';
    dropFilter.frequency.value = 1400;
    dropFilter.Q.value = 0.5;
    const dropGain = context.createGain();
    dropGain.gain.value = 0.75;
    drops.connect(dropFilter).connect(dropGain).connect(out);
    drops.start();
    stops.push(() => drops.stop());

    // Rain is never even. A slow swell on the level is most of what makes it
    // sound like weather instead of a filter.
    const gust = lfo(context, 0.07, 0.22, 0);
    gust.gain.connect(dropGain.gain);
    stops.push(() => gust.oscillator.stop());

    // Distant body underneath, so it has a room rather than a speaker.
    const rumble = noiseSource(context, 0.96);
    const rumbleFilter = context.createBiquadFilter();
    rumbleFilter.type = 'lowpass';
    rumbleFilter.frequency.value = 400;
    const rumbleGain = context.createGain();
    rumbleGain.gain.value = 0.45;
    rumble.connect(rumbleFilter).connect(rumbleGain).connect(out);
    rumble.start();
    stops.push(() => rumble.stop());

    // Individual droplets keep the bed from reading as radio static.
    const drop = noiseBuffer(context, 0, 0.08);
    let cancelled = false;
    let dropTimer: ReturnType<typeof setTimeout> | null = null;
    const sprinkle = () => {
      if (cancelled) return;
      const source = context.createBufferSource();
      const filter = context.createBiquadFilter();
      const gain = context.createGain();
      const when = context.currentTime + 0.04;
      source.buffer = drop;
      filter.type = 'bandpass';
      filter.frequency.value = 1700 + Math.random() * 2600;
      filter.Q.value = 1.8;
      gain.gain.setValueAtTime(0.0001, when);
      gain.gain.exponentialRampToValueAtTime(0.035 + Math.random() * 0.055, when + 0.006);
      gain.gain.exponentialRampToValueAtTime(0.0001, when + 0.045);
      source.connect(filter).connect(gain).connect(out);
      source.start(when);
      source.stop(when + 0.08);
      dropTimer = setTimeout(sprinkle, 90 + Math.random() * 360);
    };
    sprinkle();
    stops.push(() => {
      cancelled = true;
      if (dropTimer) clearTimeout(dropTimer);
    });

    return 0.27;
  },

  fire(context, out, stops, timers) {
    const bed = noiseSource(context, 0.9);
    const bedFilter = context.createBiquadFilter();
    bedFilter.type = 'lowpass';
    bedFilter.frequency.value = 320;
    const bedGain = context.createGain();
    bedGain.gain.value = 0.8;
    bed.connect(bedFilter).connect(bedGain).connect(out);
    bed.start();
    stops.push(() => bed.stop());

    const flicker = lfo(context, 0.35, 0.25, 0);
    flicker.gain.connect(bedGain.gain);
    stops.push(() => flicker.oscillator.stop());

    /*
     * The crackles, scheduled a second ahead at a time.
     *
     * Each is a few milliseconds of bright noise with a hard decay. Random
     * spacing matters more than the sound itself — evenly spaced pops read as
     * a machine fault, not a fire.
     */
    const crackle = noiseBuffer(context, 0.0, 0.12);
    const schedule = () => {
      const until = context.currentTime + 1;
      let when = context.currentTime + Math.random() * 0.4;
      while (when < until) {
        const source = context.createBufferSource();
        const gain = context.createGain();
        const filter = context.createBiquadFilter();
        source.buffer = crackle;
        filter.type = 'highpass';
        filter.frequency.value = 1200 + Math.random() * 1800;
        const peak = 0.06 + Math.random() * 0.22;
        gain.gain.setValueAtTime(0.0001, when);
        gain.gain.exponentialRampToValueAtTime(peak, when + 0.004);
        gain.gain.exponentialRampToValueAtTime(0.0001, when + 0.03 + Math.random() * 0.06);
        source.connect(filter).connect(gain).connect(out);
        source.start(when);
        source.stop(when + 0.14);
        when += 0.08 + Math.random() * 0.5;
      }
    };
    schedule();
    timers.push(setInterval(schedule, 1000));

    return 0.34;
  },

  waves(context, out, stops) {
    const source = noiseSource(context, 0.35);
    const filter = context.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 600;
    const gain = context.createGain();
    gain.gain.value = 0.5;
    source.connect(filter).connect(gain).connect(out);
    source.start();
    stops.push(() => source.stop());

    // One swell every twelve seconds or so, on both level and brightness —
    // a wave gets louder and brighter as it breaks, then does neither.
    const swell = lfo(context, 0.085, 0.4, 0);
    swell.gain.connect(gain.gain);
    stops.push(() => swell.oscillator.stop());

    const brightness = lfo(context, 0.085, 900, 0);
    brightness.gain.connect(filter.frequency);
    stops.push(() => brightness.oscillator.stop());

    return 0.34;
  },

  lofi(context, out, stops, timers) {
    /*
     * Four chords, sixteen seconds each time round, played on detuned
     * triangles through a lowpass.
     *
     * Deliberately slow and deliberately unresolved: something that arrives
     * somewhere is something you listen to. Semitone offsets from a low A,
     * voiced as sevenths because a plain triad sounds like a test tone.
     */
    const CHORDS = [
      [0, 7, 11, 14], // Am9-ish
      [-4, 3, 7, 10], // Fmaj7
      [-2, 5, 9, 12], // Gm7
      [-5, 2, 7, 11], // Emin/add
    ];
    const ROOT = 110;
    const BAR = 4;

    const tone = context.createBiquadFilter();
    tone.type = 'lowpass';
    tone.frequency.value = 900;
    const padGain = context.createGain();
    padGain.gain.value = 0.5;
    tone.connect(padGain).connect(out);

    // Tape wobble: a few cents of drift, which is most of the character.
    const wobble = lfo(context, 0.23, 4, 0);

    const startedAt = context.currentTime + 0.1;
    let bar = 0;
    const voice = (semitones: number, when: number, length: number) => {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = 'triangle';
      oscillator.frequency.value = ROOT * 2 ** (semitones / 12);
      wobble.gain.connect(oscillator.detune);
      gain.gain.setValueAtTime(0.0001, when);
      gain.gain.exponentialRampToValueAtTime(0.11, when + 0.9);
      gain.gain.setValueAtTime(0.11, when + length - 1.2);
      gain.gain.exponentialRampToValueAtTime(0.0001, when + length);
      oscillator.connect(gain).connect(tone);
      oscillator.start(when);
      oscillator.stop(when + length + 0.1);
    };

    const schedule = () => {
      // Two bars queued ahead, so a throttled tab never runs dry mid-chord.
      const horizon = context.currentTime + 2 * BAR;
      while (bar * BAR + startedAt < horizon) {
        const when = startedAt + bar * BAR;
        for (const semitone of CHORDS[bar % CHORDS.length]) voice(semitone, when, BAR + 0.6);

        // A soft kick and brushed backbeat give the loop a pulse without
        // turning it into a song that competes with reading.
        for (const beat of [0, 2]) {
          const kick = context.createOscillator();
          const kickGain = context.createGain();
          const at = when + beat;
          kick.type = 'sine';
          kick.frequency.setValueAtTime(105, at);
          kick.frequency.exponentialRampToValueAtTime(48, at + 0.13);
          kickGain.gain.setValueAtTime(0.08, at);
          kickGain.gain.exponentialRampToValueAtTime(0.0001, at + 0.16);
          kick.connect(kickGain).connect(out);
          kick.start(at);
          kick.stop(at + 0.18);
        }
        bar += 1;
      }
    };
    schedule();
    timers.push(setInterval(schedule, BAR * 1000));
    stops.push(() => wobble.oscillator.stop());

    // Vinyl: quiet surface noise plus sparse ticks.
    const surface = noiseSource(context, 0.0);
    const surfaceFilter = context.createBiquadFilter();
    surfaceFilter.type = 'bandpass';
    surfaceFilter.frequency.value = 2600;
    surfaceFilter.Q.value = 0.4;
    const surfaceGain = context.createGain();
    surfaceGain.gain.value = 0.12;
    surface.connect(surfaceFilter).connect(surfaceGain).connect(out);
    surface.start();
    stops.push(() => surface.stop());

    return 0.5;
  },

  cafe(context, out, stops) {
    // Room tone: band-limited noise with no top and no bottom, which is what a
    // full room sounds like from a corner table.
    const room = noiseSource(context, 0.15);
    const high = context.createBiquadFilter();
    high.type = 'highpass';
    high.frequency.value = 180;
    const low = context.createBiquadFilter();
    low.type = 'lowpass';
    low.frequency.value = 1100;
    const gain = context.createGain();
    gain.gain.value = 0.6;
    room.connect(high).connect(low).connect(gain).connect(out);
    room.start();
    stops.push(() => room.stop());

    // Murmur: a slow, irregular rise and fall, so it is never quite steady.
    const murmur = lfo(context, 0.13, 0.18, 0);
    murmur.gain.connect(gain.gain);
    stops.push(() => murmur.oscillator.stop());

    const drift = lfo(context, 0.05, 260, 0);
    drift.gain.connect(low.frequency);
    stops.push(() => drift.oscillator.stop());

    // Occasional porcelain/glass clinks are recognisable café detail. Sparse
    // enough that they never become a metronome.
    let cancelled = false;
    let clinkTimer: ReturnType<typeof setTimeout> | null = null;
    const clink = () => {
      if (cancelled) return;
      const when = context.currentTime + 0.04;
      for (const [frequency, level] of [[1760, 0.018], [2380, 0.012]] as const) {
        const oscillator = context.createOscillator();
        const bellGain = context.createGain();
        oscillator.type = 'sine';
        oscillator.frequency.value = frequency * (0.94 + Math.random() * 0.12);
        bellGain.gain.setValueAtTime(level, when);
        bellGain.gain.exponentialRampToValueAtTime(0.0001, when + 0.24);
        oscillator.connect(bellGain).connect(out);
        oscillator.start(when);
        oscillator.stop(when + 0.26);
      }
      clinkTimer = setTimeout(clink, 6500 + Math.random() * 10500);
    };
    clinkTimer = setTimeout(clink, 3200 + Math.random() * 5000);
    stops.push(() => {
      cancelled = true;
      if (clinkTimer) clearTimeout(clinkTimer);
    });

    return 0.27;
  },
};
