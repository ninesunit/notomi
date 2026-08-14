import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Animated, Easing, Platform, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { Icon } from '@/components/Icon';
import { useUid } from '@/hooks/useAuth';
import type { CopilotTurn } from '@/lib/ai';
import { feedback } from '@/lib/sound';
import { listen, supportsVoice, type VoiceSession } from '@/lib/voiceInput';
import { askCopilot } from '@/services/copilot';
import { Markdown } from './Markdown';
import { Sheet } from './Sheet';
import { Notice } from './ui';

/**
 * The assistant, with hands.
 *
 * It is not a chat window bolted on the side: everything it says it did, it
 * did — through the same writes the screens use — and each of those shows as a
 * receipt under the reply rather than as a claim inside it. That distinction is
 * the whole design. A student walking between classes should be able to say
 * "ten-page essay for research methods due next Friday" and trust that the task
 * exists without opening the to-do list to check.
 */

const OPENERS = [
  'Where is my next class?',
  'I have an essay due next Friday',
  'What is due this week?',
  'Summarise my notes on…',
];

export function Copilot({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const uid = useUid();

  const [turns, setTurns] = useState<CopilotTurn[]>([]);
  const [actions, setActions] = useState<Record<number, { tool: string; summary: string }[]>>({});
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hearing, setHearing] = useState(false);

  const scroller = useRef<ScrollView>(null);
  const voice = useRef<VoiceSession | null>(null);

  useEffect(() => {
    if (!visible) {
      voice.current?.cancel();
      voice.current = null;
      setHearing(false);
    }
  }, [visible]);

  const send = useCallback(
    async (message: string) => {
      const text = message.trim();
      if (!text || busy) return;

      voice.current?.cancel();
      voice.current = null;
      setHearing(false);

      const history = turns;
      setTurns([...history, { role: 'user', text }]);
      setDraft('');
      setBusy(true);
      setError(null);
      feedback('sent');

      try {
        const outcome = await askCopilot(uid, text, history);
        setTurns((current) => {
          const next = [...current, { role: 'model' as const, text: outcome.reply }];
          if (outcome.actions.length) {
            setActions((previous) => ({ ...previous, [next.length - 1]: outcome.actions }));
          }
          return next;
        });
        feedback(outcome.actions.length ? 'success' : 'chime');
      } catch (caught) {
        // lib/ai logs the Firebase error code and HTTP status. Keep the UI edge
        // logged too so a failed turn can be correlated with what the student
        // saw without logging their message or account id.
        console.error('[copilot] Ask Notomi request failed.', caught);
        setError(caught instanceof Error ? caught.message : String(caught));
        feedback('error');
      } finally {
        setBusy(false);
      }
    },
    [busy, turns, uid]
  );

  const toggleVoice = useCallback(() => {
    if (voice.current) {
      voice.current.stop();
      voice.current = null;
      setHearing(false);
      return;
    }

    feedback('toggle');
    setError(null);
    const session = listen({
      onText: (text) => setDraft(text),
      onError: (message) => {
        setError(message);
        setHearing(false);
        voice.current = null;
      },
      onEnd: () => {
        setHearing(false);
        voice.current = null;
      },
    });

    if (!session) {
      setError('This device has no speech recognition.');
      return;
    }
    voice.current = session;
    setHearing(true);
  }, []);

  return (
    <Sheet visible={visible} onClose={onClose} title="Ask Notomi" icon="zap" maxHeight={460}>
      {turns.length === 0 ? (
        <View className="gap-3">
          <Text className="text-sm leading-5 text-muted">
            Ask about your week, or just say what you have to do — it will find the subject and
            make the task.
          </Text>
          <View className="gap-1.5">
            {OPENERS.map((opener) => (
              <Pressable
                key={opener}
                accessibilityRole="button"
                onPress={() => void send(opener)}
                className="flex-row items-center gap-2 rounded-xl border border-line bg-paper px-3.5 py-2.5"
              >
                <Icon name="corner-down-right" size={13} color="#9A9488" />
                <Text className="flex-1 text-sm text-ink">{opener}</Text>
              </Pressable>
            ))}
          </View>
        </View>
      ) : (
        <ScrollView
          ref={scroller}
          className="max-h-[280px]"
          onContentSizeChange={() => scroller.current?.scrollToEnd({ animated: true })}
          contentContainerStyle={{ gap: 12 }}
        >
          {turns.map((turn, index) => (
            <View key={`${index}-${turn.role}`} className="gap-1.5">
              {turn.role === 'user' ? (
                <View className="self-end rounded-2xl rounded-br-md bg-ink px-3.5 py-2">
                  <Text className="text-[15px] leading-5 text-paper">{turn.text}</Text>
                </View>
              ) : (
                <View className="gap-2">
                  <View className="self-start rounded-2xl rounded-bl-md bg-paper px-3.5 py-2">
                    <Markdown source={turn.text} />
                  </View>

                  {/* The receipt. What it did, not what it says it did. */}
                  {(actions[index] ?? []).map((action) => (
                    <View
                      key={action.summary}
                      className="flex-row items-center gap-2 self-start rounded-lg bg-pine-soft px-2.5 py-1.5"
                    >
                      <Icon name="check" size={12} color="#2E6F5E" />
                      <Text className="text-xs font-medium text-pine">{action.summary}</Text>
                    </View>
                  ))}
                </View>
              )}
            </View>
          ))}

          {busy ? (
            <View className="flex-row items-center gap-2 self-start px-1">
              <ActivityIndicator size="small" color="#B4552D" />
              <Text className="text-xs text-subtle">Thinking…</Text>
            </View>
          ) : null}
        </ScrollView>
      )}

      {error ? <Notice title="That did not work" body={error} /> : null}

      <View className="flex-row items-end gap-2">
        {supportsVoice() ? (
          <MicButton hearing={hearing} onPress={toggleVoice} />
        ) : null}

        <TextInput
          value={draft}
          onChangeText={setDraft}
          multiline
          editable={!busy}
          placeholder={hearing ? 'Listening…' : 'Ask, or say what you have to do'}
          placeholderTextColor="#9A9488"
          onSubmitEditing={() => void send(draft)}
          className="max-h-24 min-h-[44px] flex-1 rounded-2xl border border-line bg-paper px-4 py-2.5 text-[15px] leading-5 text-ink"
          style={{ textAlignVertical: 'top' }}
        />

        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Send"
          disabled={!draft.trim() || busy}
          onPress={() => void send(draft)}
          className={`h-11 w-11 items-center justify-center rounded-2xl ${
            draft.trim() && !busy ? 'bg-ink' : 'bg-line'
          }`}
        >
          <Icon name="arrow-up" size={18} color={draft.trim() && !busy ? '#F7F5EE' : '#9A9488'} />
        </Pressable>
      </View>
    </Sheet>
  );
}

/** Pulses while it is listening, so there is never a doubt that it is. */
function MicButton({ hearing, onPress }: { hearing: boolean; onPress: () => void }) {
  const pulse = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!hearing) {
      pulse.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 1,
          duration: 700,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: Platform.OS !== 'web',
        }),
        Animated.timing(pulse, {
          toValue: 0,
          duration: 700,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: Platform.OS !== 'web',
        }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [hearing, pulse]);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: hearing }}
      accessibilityLabel={hearing ? 'Stop listening' : 'Speak'}
      onPress={onPress}
    >
      <Animated.View style={{ opacity: pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 0.55] }) }}>
        <View
          className={`h-11 w-11 items-center justify-center rounded-2xl ${
            hearing ? 'bg-accent' : 'border border-line bg-surface'
          }`}
        >
          <Icon name="mic" size={18} color={hearing ? '#F7F5EE' : '#6F6A5F'} />
        </View>
      </Animated.View>
    </Pressable>
  );
}
