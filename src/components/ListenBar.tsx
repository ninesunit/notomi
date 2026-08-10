import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import * as Speech from 'expo-speech';
import { Feather } from '@expo/vector-icons';
import { notesToSpeech, pickVoices } from '@/lib/speech';

/**
 * Reads notes aloud with the device's own speech engine.
 *
 * Nothing is generated or fetched: SpeechSynthesis is built into every browser
 * and OS Notomi runs on, so this costs nothing and works offline. Playback is
 * driven chunk by chunk from here rather than queued, because a queued
 * utterance cannot be stopped mid-document on the web.
 */
export function ListenBar({ markdown }: { markdown: string }) {
  const chunks = useMemo(() => notesToSpeech(markdown), [markdown]);

  const [playing, setPlaying] = useState(false);
  const [index, setIndex] = useState(0);
  const [rate, setRate] = useState(1);
  const [error, setError] = useState<string | null>(null);

  /**
   * Guards every callback. expo-speech has no way to cancel a pending onDone,
   * so a stopped utterance would otherwise advance the next playback.
   */
  const generation = useRef(0);
  const voice = useRef<string | undefined>(undefined);

  useEffect(() => {
    void pickVoices().then((pair) => {
      voice.current = pair.a;
    });
  }, []);

  // Stop on unmount: speech outlives the screen otherwise, and keeps reading a
  // document the student has navigated away from.
  useEffect(() => {
    return () => {
      generation.current += 1;
      void Speech.stop();
    };
  }, []);

  const speak = useCallback(
    (from: number, token: number) => {
      if (token !== generation.current) return;

      if (from >= chunks.length) {
        setPlaying(false);
        setIndex(0);
        return;
      }

      setIndex(from);
      Speech.speak(chunks[from], {
        voice: voice.current,
        rate,
        onDone: () => {
          if (token !== generation.current) return;
          speak(from + 1, token);
        },
        onStopped: () => {
          /* Deliberate stop; whoever stopped owns the next generation. */
        },
        onError: () => {
          if (token !== generation.current) return;
          // One bad chunk should not end the reading.
          speak(from + 1, token);
        },
      });
    },
    [chunks, rate]
  );

  const start = useCallback(
    (from: number) => {
      if (chunks.length === 0) {
        setError('There is nothing readable in these notes yet.');
        return;
      }
      setError(null);
      generation.current += 1;
      const token = generation.current;
      void Speech.stop();
      setPlaying(true);
      speak(from, token);
    },
    [chunks.length, speak]
  );

  const stop = useCallback(() => {
    generation.current += 1;
    void Speech.stop();
    setPlaying(false);
  }, []);

  const changeRate = useCallback(
    (next: number) => {
      setRate(next);
      // Rate is fixed per utterance, so a change only takes effect on restart —
      // restarting from the current chunk applies it without losing the place.
      if (playing) {
        generation.current += 1;
        const token = generation.current;
        void Speech.stop();
        // The new rate must be visible to speak(); a frame's delay is enough.
        setTimeout(() => {
          if (token !== generation.current) return;
          setPlaying(true);
        }, 0);
      }
    },
    [playing]
  );

  // Restart at the current chunk whenever the rate changes mid-playback.
  useEffect(() => {
    if (!playing) return;
    const token = generation.current;
    speak(index, token);
    // Only when rate changes; speak() and index are deliberately not deps or
    // this would restart on every chunk boundary.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rate]);

  if (chunks.length === 0) return null;

  const progress = chunks.length > 0 ? index / chunks.length : 0;

  return (
    <View className="gap-2.5 rounded-2xl border border-line bg-sand/60 p-4">
      <View className="flex-row items-center gap-3">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={playing ? 'Stop reading' : 'Read these notes aloud'}
          onPress={() => (playing ? stop() : start(index))}
          className="h-10 w-10 items-center justify-center rounded-full bg-ink"
        >
          <Feather name={playing ? 'square' : 'play'} size={15} color="#F7F5EE" />
        </Pressable>

        <View className="flex-1 gap-1">
          <Text className="text-[13px] font-semibold text-ink">
            {playing ? 'Reading aloud' : 'Listen to these notes'}
          </Text>
          <Text className="text-[11px] text-subtle">
            {playing
              ? `Part ${index + 1} of ${chunks.length} · device voice, no data used`
              : `${chunks.length} parts · uses your device's built-in voice`}
          </Text>
        </View>

        <View className="flex-row items-center gap-1">
          {[0.85, 1, 1.25, 1.5].map((option) => (
            <Pressable
              key={option}
              accessibilityRole="button"
              accessibilityLabel={`Speed ${option} times`}
              accessibilityState={{ selected: rate === option }}
              onPress={() => changeRate(option)}
              className={`rounded-lg px-2 py-1 ${rate === option ? 'bg-ink' : 'bg-surface'}`}
            >
              <Text
                className={`text-[11px] font-semibold ${
                  rate === option ? 'text-paper' : 'text-muted'
                }`}
              >
                {option}×
              </Text>
            </Pressable>
          ))}
        </View>
      </View>

      {playing ? (
        <View className="h-1 w-full overflow-hidden rounded-full bg-line">
          <View className="h-full rounded-full bg-accent" style={{ width: `${progress * 100}%` }} />
        </View>
      ) : null}

      {error ? <Text className="text-xs text-rose">{error}</Text> : null}
    </View>
  );
}
