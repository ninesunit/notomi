import { useEffect, useRef, useState } from 'react';
import {
  Animated,
  Easing,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { GoogleButton } from '@/components/GoogleButton';
import { Icon, type IconName } from '@/components/Icon';
import { Logo } from '@/components/Logo';
import { Sheet } from '@/components/Sheet';
import { FadeIn } from '@/components/motion';
import { Button, Field, Notice, Touchable } from '@/components/ui';
import { authErrorMessage, useAuth } from '@/hooks/useAuth';
import { feedback } from '@/lib/sound';
import { useSafeArea } from '@/hooks/useSafeArea';

type Mode = 'signIn' | 'signUp';

/**
 * What Notomi does, in the three claims worth making before someone signs up.
 *
 * Deliberately the same promises the marketing site leads with. A visitor who
 * clicks through from there and lands on a bare email box has to take it on
 * faith that they arrived at the right product; seeing the same three things
 * restated is what makes the door feel like part of the building.
 */
const PROMISES: { icon: IconName; title: string; body: string }[] = [
  {
    icon: 'upload-cloud',
    title: 'Drop in anything academic',
    body: 'Slides, syllabuses, timetables, recordings. Notomi reads each one and files it where it belongs.',
  },
  {
    icon: 'calendar-days',
    title: 'Your syllabus becomes your schedule',
    body: 'Every deadline it finds turns into a task and a countdown, before you have read the document yourself.',
  },
  {
    icon: 'zap',
    title: 'Ask your own material',
    body: 'Quizzes, flashcards and answers drawn from your lectures — not from the internet.',
  },
];

export default function Login() {
  const { signIn, signUp, signInWithGoogle, continueAsGuest } = useAuth();
  const [mode, setMode] = useState<Mode>('signIn');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState<'form' | 'guest' | 'google' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [guestNoticeOpen, setGuestNoticeOpen] = useState(false);

  const { width } = useWindowDimensions();
  const insets = useSafeArea();
  /** Two columns only where there is genuinely room for the pitch beside the form. */
  const wide = width >= 900;

  /**
   * A slow drift behind the mark.
   *
   * The one piece of motion that is not tied to an interaction, and the reason
   * the page reads as alive rather than as a form on a background. Kept to a
   * long, shallow cycle: anything faster competes with the typing.
   */
  const drift = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(drift, {
          toValue: 1,
          duration: 9000,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: Platform.OS !== 'web',
        }),
        Animated.timing(drift, {
          toValue: 0,
          duration: 9000,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: Platform.OS !== 'web',
        }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [drift]);

  async function run(action: () => Promise<void>, kind: 'form' | 'guest' | 'google') {
    setError(null);
    setBusy(kind);
    try {
      await action();
      feedback('success');
      // Navigation is handled by the auth gate in app/_layout.tsx.
    } catch (caught) {
      feedback('error');
      setError(authErrorMessage(caught));
      setBusy(null);
    }
  }

  const submit = () =>
    run(
      () => (mode === 'signIn' ? signIn(email, password) : signUp(email, password, name)),
      'form'
    );

  const pitch = (
    <View className="gap-6">
      <FadeIn index={0}>
        <View className="gap-4">
          <Animated.View
            style={{
              transform: [
                {
                  translateY: drift.interpolate({ inputRange: [0, 1], outputRange: [0, -6] }),
                },
              ],
            }}
          >
            <Logo size={wide ? 56 : 44} />
          </Animated.View>

          <View className="gap-3">
            <Text
              className={`font-bold tracking-tight text-ink ${
                wide ? 'text-[44px] leading-[50px]' : 'text-[34px] leading-10'
              }`}
            >
              Your degree,{'\n'}
              <Text className="text-accent">organised by itself.</Text>
            </Text>
            <Text className={`leading-7 text-muted ${wide ? 'text-[17px]' : 'text-[15px]'}`}>
              Notomi turns the pile of slides, syllabuses and timetables every semester hands you
              into one workspace that keeps track of itself.
            </Text>
          </View>
        </View>
      </FadeIn>

      <View className="gap-3">
        {PROMISES.map((promise, index) => (
          <FadeIn key={promise.title} index={index + 1}>
            <View className="flex-row items-start gap-3">
              <View className="mt-0.5 h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-accent-soft">
                <Icon name={promise.icon} size={17} tone="accent" />
              </View>
              <View className="min-w-0 flex-1 gap-0.5">
                <Text className="text-[15px] font-semibold text-ink">{promise.title}</Text>
                <Text className="text-[13px] leading-5 text-muted">{promise.body}</Text>
              </View>
            </View>
          </FadeIn>
        ))}
      </View>

      <FadeIn index={4}>
        <Text className="text-xs leading-5 text-subtle">
          Free while you study. Your files stay in your own Google Drive.
        </Text>
      </FadeIn>
    </View>
  );

  const form = (
    <FadeIn index={wide ? 0 : 5}>
      <View className="gap-5 rounded-3xl border border-line bg-surface p-6 shadow-sm">
        <View className="gap-1">
          <Text className="text-[22px] font-bold tracking-tight text-ink">
            {mode === 'signIn' ? 'Welcome back' : 'Start your semester'}
          </Text>
          <Text className="text-[13px] text-muted">
            {mode === 'signIn'
              ? 'Pick up where you left off.'
              : 'It takes about thirty seconds.'}
          </Text>
        </View>

        {error ? <Notice title="Could not sign in" body={error} /> : null}

        <View className="gap-3">
          {mode === 'signUp' ? (
            <Field
              label="Name"
              value={name}
              onChangeText={setName}
              placeholder="Mika"
              autoCapitalize="words"
              textContentType="name"
            />
          ) : null}

          <Field
            label="Email"
            value={email}
            onChangeText={setEmail}
            placeholder="you@university.edu"
            keyboardType="email-address"
            autoCapitalize="none"
            autoCorrect={false}
            textContentType="emailAddress"
          />

          <Field
            label="Password"
            value={password}
            onChangeText={setPassword}
            placeholder="••••••••"
            secureTextEntry
            textContentType={mode === 'signIn' ? 'password' : 'newPassword'}
            onSubmitEditing={submit}
            returnKeyType="go"
          />

          <Button
            label={mode === 'signIn' ? 'Sign in' : 'Create account'}
            icon="arrow-right"
            onPress={submit}
            loading={busy === 'form'}
            disabled={busy !== null}
            className="mt-1"
          />
        </View>

        <View className="flex-row items-center gap-3">
          <View className="h-px flex-1 bg-line" />
          <Text className="text-xs uppercase tracking-wider text-subtle">or</Text>
          <View className="h-px flex-1 bg-line" />
        </View>

        <View className="gap-3">
          <GoogleButton
            onPress={() => run(signInWithGoogle, 'google')}
            loading={busy === 'google'}
            disabled={busy !== null}
          />

          <Button
            label="Continue as guest"
            variant="secondary"
            icon="user"
            onPress={() => setGuestNoticeOpen(true)}
            loading={busy === 'guest'}
            disabled={busy !== null}
          />
        </View>

        <Touchable
          accessibilityRole="button"
          cue="none"
          onPress={() => {
            feedback('toggle');
            setMode(mode === 'signIn' ? 'signUp' : 'signIn');
            setError(null);
          }}
          className="items-center py-1"
        >
          <Text className="text-sm text-muted">
            {mode === 'signIn' ? "Don't have an account? " : 'Already have an account? '}
            <Text className="font-semibold text-accent">
              {mode === 'signIn' ? 'Sign up' : 'Sign in'}
            </Text>
          </Text>
        </Touchable>
      </View>
    </FadeIn>
  );

  return (
    <KeyboardAvoidingView
      className="flex-1 bg-paper"
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        contentContainerClassName="flex-grow justify-center px-6"
        contentContainerStyle={{
          paddingTop: insets.top + 32,
          paddingBottom: insets.bottom + 32,
        }}
      >
        <View
          className={`w-full self-center ${
            wide ? 'max-w-5xl flex-row items-center gap-14' : 'max-w-sm gap-8'
          }`}
        >
          <View className={wide ? 'flex-1' : undefined}>{pitch}</View>
          <View className={wide ? 'w-[400px]' : undefined}>{form}</View>
        </View>
      </ScrollView>

      <Sheet
        visible={guestNoticeOpen}
        onClose={() => setGuestNoticeOpen(false)}
        title="Temporary guest session"
        icon="user"
        maxHeight={390}
        footer={
          <>
            <Button
              label="Cancel"
              variant="ghost"
              onPress={() => setGuestNoticeOpen(false)}
              disabled={busy !== null}
            />
            <View className="flex-1" />
            <Button
              label="Enter as guest"
              icon="arrow-right"
              loading={busy === 'guest'}
              disabled={busy !== null}
              onPress={() =>
                void run(continueAsGuest, 'guest').then(() => setGuestNoticeOpen(false))
              }
            />
          </>
        }
      >
        <View className="gap-3">
          <Text className="text-sm leading-6 text-ink">
            Guest mode is for a temporary trial on this device.
          </Text>
          <Text className="text-sm leading-6 text-muted">
            When you sign out, Notomi permanently deletes the guest workspace, uploaded originals,
            notes, schedules, tasks and the anonymous account. Guest data cannot be recovered or
            transferred after sign-out.
          </Text>
          <Text className="text-xs leading-5 text-subtle">
            Create a regular account if you want your work to remain available later or on another
            device.
          </Text>
        </View>
      </Sheet>
    </KeyboardAvoidingView>
  );
}
