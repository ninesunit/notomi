import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { doc, serverTimestamp, setDoc, updateDoc } from 'firebase/firestore';
import { Sheet } from './Sheet';
import { Icon, useTones } from './Icon';
import { Button, Field, Touchable } from './ui';
import { paths } from '@/lib/paths';
import {
  colorForSubject,
  DEFAULT_SUBJECT_ICON,
  SUBJECT_ICONS,
  SUBJECT_PALETTE,
  tidyName,
  type Subject,
} from '@/lib/schema';
import { getDb } from '@/services/firebase';
import { syncSubjectToClasses } from '@/services/timetable';

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
  // Remounting per open keeps the fields in step with the subject that was
  // clicked, without an effect syncing props into state.
  if (!visible) return null;

  return (
    <SubjectForm
      key={subject?.id ?? 'new'}
      uid={uid}
      subject={subject}
      onClose={onClose}
      onCreated={onCreated}
    />
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
  const tones = useTones();
  /**
   * A name captured from a screenshot arrives in block capitals. The editor
   * offers the calmed version pre-typed rather than rewriting it behind the
   * student's back — one tap on Save if they agree, ignore it if they do not.
   */
  const [name, setName] = useState(tidyName(subject?.name ?? ''));
  const [moduleCode, setModuleCode] = useState(subject?.moduleCode ?? '');
  const [tag, setTag] = useState(subject?.tag ?? '');
  const [color, setColor] = useState(subject?.color ?? SUBJECT_PALETTE[0].value);
  const [icon, setIcon] = useState<string>(subject?.icon ?? DEFAULT_SUBJECT_ICON);
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
      emoji: null,
      icon,
      color,
      updatedAt: serverTimestamp(),
    };

    try {
      if (subject) {
        await updateDoc(paths.subject(db, uid, subject.id), fields);
        // The timetable joins on subjectId and so is already correct; this is
        // for the readers that cannot join — reminders, search, the calendar.
        await syncSubjectToClasses(uid, {
          id: subject.id,
          name: fields.name,
          color: fields.color,
        });
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
    <Sheet
      visible
      onClose={onClose}
      title={subject ? 'Edit subject' : 'New subject'}
      icon="folder"
      footer={
        <>
          <View className="flex-1" />
          <Button label="Cancel" variant="ghost" size="sm" onPress={onClose} disabled={saving} />
          <Button
            label={subject ? 'Save' : 'Create subject'}
            size="sm"
            loading={saving}
            disabled={!valid || saving}
            onPress={() => void save()}
          />
        </>
      }
    >
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
          <View className="flex-row flex-wrap gap-2">
            {SUBJECT_ICONS.map((option) => {
              const selected = icon === option;
              return (
                <Touchable
                  key={option}
                  accessibilityRole="button"
                  accessibilityLabel={`Icon ${option.replace(/-/g, ' ')}`}
                  accessibilityState={{ selected }}
                  onPress={() => setIcon(option)}
                  className={`h-10 w-10 items-center justify-center rounded-xl border ${
                    selected ? 'border-ink bg-sand' : 'border-line bg-surface'
                  }`}
                >
                  {/* Tinted with the chosen colour so the two pickers read as
                      one decision rather than two unrelated grids. */}
                  <Icon name={option as never} size={18} color={selected ? color : tones.muted} />
                </Touchable>
              );
            })}
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

        {/* Live preview uses the same vector icon as every subject card. */}
        <View className="gap-2">
          <Text className="text-sm font-medium text-muted">Preview</Text>
          <View
            className="overflow-hidden rounded-xl border border-line"
            style={{ backgroundColor: `${color}14` }}
          >
            <View className="h-1.5 w-full" style={{ backgroundColor: color }} />
            <View className="flex-row items-center gap-3 p-3.5">
              <Icon name={icon as never} size={20} color={color} />
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
    </Sheet>
  );
}
