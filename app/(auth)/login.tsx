import { useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, View } from 'react-native';
import { Button, Field, Notice } from '@/components/ui';
import { authErrorMessage, useAuth } from '@/hooks/useAuth';

type Mode = 'signIn' | 'signUp';

export default function Login() {
  const { signIn, signUp, continueAsGuest } = useAuth();
  const [mode, setMode] = useState<Mode>('signIn');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState<'form' | 'guest' | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(action: () => Promise<void>, kind: 'form' | 'guest') {
    setError(null);
    setBusy(kind);
    try {
      await action();
      // Navigation is handled by the auth gate in app/_layout.tsx.
    } catch (caught) {
      setError(authErrorMessage(caught));
      setBusy(null);
    }
  }

  const submit = () =>
    run(
      () => (mode === 'signIn' ? signIn(email, password) : signUp(email, password, name)),
      'form'
    );

  return (
    <KeyboardAvoidingView
      className="flex-1 bg-paper"
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView contentContainerClassName="flex-grow items-center justify-center px-6 py-12">
        <View className="w-full max-w-sm gap-7">
          <View className="gap-2">
            <View className="mb-3 h-12 w-12 items-center justify-center rounded-2xl bg-ink">
              <Text className="text-xl font-bold text-paper">N</Text>
            </View>
            <Text className="text-[32px] font-bold leading-9 tracking-tight text-ink">Notomi</Text>
            <Text className="text-[15px] leading-6 text-muted">
              Upload your lectures, ask questions, and let your syllabus fill in your to-do list.
            </Text>
          </View>

          {error ? <Notice title="Could not sign in" body={error} /> : null}

          <View className="gap-3">
            {mode === 'signUp' ? (
              <Field
                label="Name"
                value={name}
                onChangeText={setName}
                placeholder="Alex Tan"
                autoCapitalize="words"
                textContentType="name"
              />
            ) : null}

            <Field
              label="Email"
              value={email}
              onChangeText={setEmail}
              placeholder="you@university.edu"
              autoCapitalize="none"
              autoComplete="email"
              keyboardType="email-address"
              textContentType="emailAddress"
            />

            <Field
              label="Password"
              value={password}
              onChangeText={setPassword}
              placeholder="••••••••"
              secureTextEntry
              autoCapitalize="none"
              textContentType={mode === 'signIn' ? 'password' : 'newPassword'}
              onSubmitEditing={submit}
              returnKeyType="go"
            />

            <Button
              label={mode === 'signIn' ? 'Sign in' : 'Create account'}
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

          <Button
            label="Continue as guest"
            variant="secondary"
            icon="user"
            onPress={() => run(continueAsGuest, 'guest')}
            loading={busy === 'guest'}
            disabled={busy !== null}
          />

          <Pressable
            accessibilityRole="button"
            onPress={() => {
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
          </Pressable>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
