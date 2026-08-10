import { useState } from 'react';
import { Modal, Pressable, ScrollView, Text, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { doc, serverTimestamp, setDoc, updateDoc } from 'firebase/firestore';
import { Button, Field, IconButton } from './ui';
import { paths } from '@/lib/paths';
import { colorForSubject, SUBJECT_EMOJI, SUBJECT_PALETTE, type Subject } from '@/lib/schema';
import { getDb } from '@/services/firebase';

/**
 * Create or edit a subject folder.
 *
 * Ingestion creates subjects automatically from what it reads in a file; this
 * is how a student takes them over — renaming, giving them an icon, a colour
 * and a tag so the library reads like their own filing system.
 */
export function SubjectModal({
  uid,
  subject,
  visible,
  onClose,
  onCreated,
}: {
  uid: string;
  /** null opens the create flow. */
  subject: Subject | null;
  visible: boolean;
  onClose: () => void;
  onCreated?: (subjectId: string) => void;
}) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View className="flex-1 items-center justify-center bg-ink/40 px-5">
        {visible ? (
          // Remounting per open keeps the fields in step with the subject that
          // was clicked, without an effect syncing props into state.
          <SubjectForm
            key={subject?.id ?? 'new'}
            uid={uid}
            subject={subject}
            onClose={onClose}
            onCreated={onCreated}
          />
        ) : null}
      </View>
    </Modal>
  );
}

function SubjectForm({
  uid,
  subject,
  onClose,
  onCreated,
}: {
  uid: string;
  subject: Subject | null;
  onClose: () => void;
  onCreated?: (subjectId: string) => void;
}) {
  const [name, setName] = useState(subject?.name ?? '');
  const [moduleCode, setModuleCode] = useState(subject?.moduleCode ?? '');
  const [tag, setTag] = useState(subject?.tag ?? '');
  const [emoji, setEmoji] = useState<string | null>(subject?.emoji ?? null);
  const [color, setColor] = useState(subject?.color ?? SUBJECT_PALETTE[0].value);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const valid = name.trim().length > 0;

  async function save() {
    if (!valid) return;
    setSaving(true);
    setError(null);

    const db = getDb();
    const fields = {
      name: name.trim(),
      moduleCode: moduleCode.trim() || null,
      tag: tag.trim() || null,
      emoji,
      color,
      updatedAt: serverTimestamp(),
    };

    try {
      if (subject) {
        await updateDoc(paths.subject(db, uid, subject.id), fields);
        onClose();
      } else {
        const ref = doc(paths.subjects(db, uid));
        await setDoc(ref, {
          ...fields,
          // A hand-made folder starts empty and unfiled, exactly like one the
          // ingestion pipeline creates.
          color: color || colorForSubject(name),
          documentCount: 0,
          semesterId: null,
          creditHours: 0,
          grade: null,
          createdAt: serverTimestamp(),
        });
        onCreated?.(ref.id);
        onClose();
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setSaving(false);
    }
  }

  return (
    <View className="w-full max-w-md overflow-hidden rounded-2xl border border-line bg-surface">
      <View className="flex-row items-center gap-3 border-b border-line px-5 py-4">
        <View
          className="h-9 w-9 items-center justify-center rounded-lg"
          style={{ backgroundColor: `${color}24` }}
        >
          <Text className="text-base">{emoji ?? '📘'}</Text>
        </View>
        <Text className="flex-1 text-[15px] font-semibold text-ink">
          {subject ? 'Edit subject' : 'New subject'}
        </Text>
        <IconButton icon="x" label="Close" onPress={onClose} />
      </View>

      <ScrollView className="max-h-[440px]" contentContainerClassName="gap-4 p-5">
        <Field
          label="Name"
          value={name}
          onChangeText={setName}
          placeholder="Organic Chemistry"
          autoFocus
        />

        <View className="flex-row gap-3">
          <View className="flex-1">
            <Field
              label="Module code"
              value={moduleCode}
              onChangeText={setModuleCode}
              placeholder="CM2011"
              autoCapitalize="characters"
            />
          </View>
          <View className="flex-1">
            <Field label="Tag" value={tag} onChangeText={setTag} placeholder="Core" />
          </View>
        </View>

        <View className="gap-2">
          <Text className="text-sm font-medium text-muted">Icon</Text>
          <View className="flex-row flex-wrap gap-1.5">
            {SUBJECT_EMOJI.map((option) => (
              <Pressable
                key={option}
                accessibilityRole="button"
                accessibilityLabel={`Icon ${option}`}
                accessibilityState={{ selected: emoji === option }}
                onPress={() => setEmoji(emoji === option ? null : option)}
                className={`h-9 w-9 items-center justify-center rounded-lg border ${
                  emoji === option ? 'border-ink bg-sand' : 'border-line bg-paper'
                }`}
              >
                <Text className="text-base">{option}</Text>
              </Pressable>
            ))}
          </View>
        </View>

        <View className="gap-2">
          <Text className="text-sm font-medium text-muted">Colour</Text>
          <View className="flex-row flex-wrap gap-2">
            {SUBJECT_PALETTE.map((option) => (
              <Pressable
                key={option.value}
                accessibilityRole="button"
                accessibilityLabel={option.name}
                accessibilityState={{ selected: color === option.value }}
                onPress={() => setColor(option.value)}
                className={`h-8 w-8 items-center justify-center rounded-full border-2 ${
                  color === option.value ? 'border-ink' : 'border-transparent'
                }`}
              >
                <View
                  className="h-6 w-6 rounded-full"
                  style={{ backgroundColor: option.value }}
                />
              </Pressable>
            ))}
          </View>
        </View>

        {/* Live preview: colour and emoji only make sense together. */}
        <View className="gap-2">
          <Text className="text-sm font-medium text-muted">Preview</Text>
          <View
            className="overflow-hidden rounded-xl border border-line"
            style={{ backgroundColor: `${color}14` }}
          >
            <View className="h-1.5 w-full" style={{ backgroundColor: color }} />
            <View className="flex-row items-center gap-3 p-3.5">
              <Text className="text-xl">{emoji ?? '📘'}</Text>
              <View className="flex-1">
                <Text className="text-sm font-semibold text-ink" numberOfLines={1}>
                  {name.trim() || 'Subject name'}
                </Text>
                <Text className="text-xs text-subtle">
                  {[moduleCode.trim(), tag.trim()].filter(Boolean).join(' · ') || 'No module code'}
                </Text>
              </View>
            </View>
          </View>
        </View>

        {error ? <Text className="text-xs text-rose">{error}</Text> : null}
      </ScrollView>

      <View className="flex-row items-center justify-end gap-2 border-t border-line px-5 py-4">
        <Button label="Cancel" variant="ghost" size="sm" onPress={onClose} disabled={saving} />
        <Button
          label={subject ? 'Save' : 'Create subject'}
          size="sm"
          loading={saving}
          disabled={!valid || saving}
          onPress={() => void save()}
        />
      </View>
    </View>
  );
}
