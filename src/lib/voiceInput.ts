import { Platform } from 'react-native';

/**
 * Voice input, using the recogniser already on the device.
 *
 * Nothing is uploaded to a transcription service: iOS, Android and desktop
 * browsers all ship speech recognition, and using theirs means no audio leaves
 * the phone by our doing, no key to hold, and no per-minute cost. Where the
 * browser has none, the microphone button simply does not appear — a button
 * that silently does nothing is worse than no button.
 */

type Recogniser = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((event: SpeechRecognitionLikeEvent) => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  onend: (() => void) | null;
};

type SpeechRecognitionLikeEvent = {
  results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }>;
  resultIndex: number;
};

function constructor(): (new () => Recogniser) | null {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return null;
  const scope = window as unknown as {
    SpeechRecognition?: new () => Recogniser;
    webkitSpeechRecognition?: new () => Recogniser;
  };
  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition ?? null;
}

export function supportsVoice(): boolean {
  return constructor() !== null;
}

export type VoiceSession = {
  /** Stop listening and keep whatever was heard. */
  stop: () => void;
  /** Stop listening and discard it. */
  cancel: () => void;
};

/**
 * Starts listening. `onText` fires with the running transcript — interim
 * results included, so the field fills in as the student speaks rather than
 * sitting empty until they stop.
 */
export function listen(handlers: {
  onText: (text: string, final: boolean) => void;
  onError?: (message: string) => void;
  onEnd?: () => void;
}): VoiceSession | null {
  const Recognition = constructor();
  if (!Recognition) return null;

  const recogniser = new Recognition();
  recogniser.lang = typeof navigator !== 'undefined' ? navigator.language || 'en-US' : 'en-US';
  recogniser.continuous = false;
  recogniser.interimResults = true;

  let cancelled = false;

  recogniser.onresult = (event) => {
    if (cancelled) return;
    let transcript = '';
    let final = false;

    for (let index = 0; index < event.results.length; index += 1) {
      const result = event.results[index];
      transcript += result[0]?.transcript ?? '';
      if (result.isFinal) final = true;
    }

    handlers.onText(transcript.trim(), final);
  };

  recogniser.onerror = (event) => {
    if (cancelled) return;
    // "no-speech" and "aborted" are what happens when someone taps the button
    // and changes their mind; neither is worth an error message.
    if (event.error === 'no-speech' || event.error === 'aborted') return;
    handlers.onError?.(
      event.error === 'not-allowed'
        ? 'Microphone access was refused.'
        : 'Could not hear that. Try again.'
    );
  };

  recogniser.onend = () => {
    if (!cancelled) handlers.onEnd?.();
  };

  try {
    recogniser.start();
  } catch {
    return null;
  }

  return {
    stop: () => recogniser.stop(),
    cancel: () => {
      cancelled = true;
      recogniser.abort();
    },
  };
}
