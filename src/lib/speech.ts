import * as Speech from 'expo-speech';
import type { PodcastLine } from './schema';

export type VoicePair = {
  /** Voice identifiers, or undefined to let the platform pick its default. */
  a: string | undefined;
  b: string | undefined;
  labels: [string, string];
};

const DEFAULT_PAIR: VoicePair = { a: undefined, b: undefined, labels: ['Voice 1', 'Voice 2'] };

/** Voices that read text badly (novelty/eloquence voices on macOS and iOS). */
const NOVELTY = /albert|bad news|bahh|bells|boing|bubbles|cellos|good news|jester|organ|superstar|trinoids|whisper|wobble|zarvox|junior|ralph|fred|kathy|princess|deranged|hysterical|bruce|agnes|victoria/i;

/**
 * Picks two distinct device voices so the "podcast" actually sounds like two
 * people. Falls back to a pitch offset when the device only exposes one voice.
 */
export async function pickVoices(): Promise<VoicePair> {
  let voices: Speech.Voice[] = [];
  try {
    voices = await Speech.getAvailableVoicesAsync();
  } catch {
    return DEFAULT_PAIR;
  }

  if (!voices || voices.length === 0) return DEFAULT_PAIR;

  const language = (
    typeof navigator !== 'undefined' && navigator.language ? navigator.language : 'en-US'
  ).toLowerCase();
  const base = language.split('-')[0];

  const usable = voices.filter((voice) => !NOVELTY.test(voice.name ?? ''));
  const pool = usable.length >= 2 ? usable : voices;

  const ranked = [...pool].sort((x, y) => score(y) - score(x));

  function score(voice: Speech.Voice): number {
    const voiceLanguage = (voice.language ?? '').toLowerCase();
    let value = 0;
    if (voiceLanguage === language) value += 4;
    else if (voiceLanguage.startsWith(base)) value += 3;
    if (voice.quality === Speech.VoiceQuality.Enhanced) value += 2;
    // Prefer local voices: network voices stall between lines.
    if (/google|microsoft|siri|samantha|daniel|karen|moira|alex/i.test(voice.name ?? '')) value += 1;
    return value;
  }

  const first = ranked[0];
  const second = ranked.find((voice) => voice.identifier !== first?.identifier) ?? first;

  return {
    a: first?.identifier,
    b: second?.identifier,
    labels: [shortName(first), shortName(second)],
  };
}

function shortName(voice: Speech.Voice | undefined): string {
  if (!voice?.name) return 'Default';
  // Web voice names are often "Google UK English Female" — keep the tail.
  return voice.name.replace(/^(Microsoft|Google|Apple)\s+/i, '').split(/[()]/)[0].trim();
}

/**
 * Splits Markdown notes into speakable chunks.
 *
 * Handing a whole document to the speech engine in one call is unreliable —
 * browsers cap utterance length and drop the tail — and it also makes pausing
 * meaningless. Chunking at sentence boundaries gives progress and a place to
 * stop.
 */
export function notesToSpeech(markdown: string): string[] {
  const spoken = markdown
    .replace(/```[\s\S]*?```/g, ' Code block omitted. ')
    // Read a heading as a spoken heading rather than a run of hashes.
    .replace(/^#{1,6}\s+(.*)$/gm, '$1.')
    .replace(/^\s*>\s?/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+[.)]\s+/gm, '')
    // Tables read as noise; keep the cell text, drop the pipes and rules.
    .replace(/^\s*\|?[\s:|-]*-{2,}[\s:|-]*\|?\s*$/gm, '')
    .replace(/\|/g, ', ')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\$([^$]+)\$/g, '$1')
    .replace(/\[(.*?)\]\(.*?\)/g, '$1')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();

  const chunks: string[] = [];
  for (const paragraph of spoken.split('\n')) {
    const trimmed = paragraph.trim();
    if (!trimmed) continue;

    // Sentences, then merged up to a length the engine handles comfortably.
    const sentences = trimmed.match(/[^.!?]+[.!?]*/g) ?? [trimmed];
    let buffer = '';
    for (const sentence of sentences) {
      if ((buffer + sentence).length > 220 && buffer) {
        chunks.push(buffer.trim());
        buffer = '';
      }
      buffer += sentence;
    }
    if (buffer.trim()) chunks.push(buffer.trim());
  }

  return chunks.filter((chunk) => /[a-z0-9]/i.test(chunk));
}

export type PlaybackHandlers = {
  onLine: (index: number) => void;
  onDone: () => void;
  onError: (message: string) => void;
};

/**
 * Sequential two-voice playback.
 *
 * expo-speech has no queue callback that survives a stop, so the player drives
 * the sequence itself and guards every callback with a generation token —
 * otherwise a stopped utterance's onDone would advance the new playback.
 */
export class PodcastPlayer {
  private generation = 0;
  private lines: PodcastLine[] = [];
  private voices: VoicePair = DEFAULT_PAIR;
  private handlers: PlaybackHandlers | null = null;

  configure(lines: PodcastLine[], voices: VoicePair, handlers: PlaybackHandlers): void {
    this.lines = lines;
    this.voices = voices;
    this.handlers = handlers;
  }

  /** Speaker A is whoever opens the transcript; everyone else alternates. */
  private voiceFor(line: PodcastLine): { voice: string | undefined; pitch: number } {
    const isFirstSpeaker = line.speaker === this.lines[0]?.speaker;
    if (this.voices.a === this.voices.b) {
      // One usable voice on this device — separate the speakers by pitch.
      return { voice: this.voices.a, pitch: isFirstSpeaker ? 1.08 : 0.9 };
    }
    return { voice: isFirstSpeaker ? this.voices.a : this.voices.b, pitch: 1 };
  }

  play(from = 0): void {
    this.generation += 1;
    void Speech.stop();
    this.speak(from, this.generation);
  }

  private speak(index: number, generation: number): void {
    if (generation !== this.generation) return;

    if (index >= this.lines.length) {
      this.handlers?.onDone();
      return;
    }

    const line = this.lines[index];
    this.handlers?.onLine(index);
    const { voice, pitch } = this.voiceFor(line);

    Speech.speak(line.text, {
      voice,
      pitch,
      rate: 1.0,
      onDone: () => {
        if (generation !== this.generation) return;
        this.speak(index + 1, generation);
      },
      onStopped: () => {
        /* Deliberate stop; play() owns the next generation. */
      },
      onError: () => {
        if (generation !== this.generation) return;
        // A single bad utterance should not end the episode.
        this.speak(index + 1, generation);
      },
    });
  }

  pause(): void {
    void Speech.pause().catch(() => undefined);
  }

  resume(): void {
    void Speech.resume().catch(() => undefined);
  }

  stop(): void {
    this.generation += 1;
    void Speech.stop();
  }
}
