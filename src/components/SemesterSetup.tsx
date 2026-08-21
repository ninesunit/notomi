import { useMemo, useState } from 'react';
import { Text, View } from 'react-native';
import { router } from 'expo-router';

import { Icon, type IconName } from '@/components/Icon';
import { Button, Card, Notice, Touchable } from '@/components/ui';
import { usePWAInstall } from '@/hooks/usePWAInstall';
import { useReminders } from '@/hooks/useReminders';
import type { Subject, Todo } from '@/lib/schema';
import { clearDemoSemester, DEMO_IDS, loadDemoSemester } from '@/services/demoData';
import type { MaterialFile } from '@/services/ingestion';

type Step = {
  id: string;
  title: string;
  detail: string;
  icon: IconName;
  done: boolean;
  action: () => void;
};

/** A setup guide that is fed entirely by collections the Dashboard already reads. */
export function SemesterSetup({
  uid,
  classCount,
  subjects,
  todos,
  busy,
  onUpload,
}: {
  uid: string;
  classCount: number;
  subjects: Subject[];
  todos: Todo[];
  busy: boolean;
  onUpload: (files: MaterialFile[]) => Promise<void>;
}) {
  const reminders = useReminders();
  const install = usePWAInstall();
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [installHelp, setInstallHelp] = useState(false);

  const demoLoaded = subjects.some((subject) => subject.id === DEMO_IDS.subject);

  const chooseFiles = () => {
    setError(null);
    void import('@/services/ingestion')
      .then(({ pickMaterials }) => pickMaterials())
      .then((files) => (files.length ? onUpload(files) : undefined))
      .catch((caught: unknown) =>
        setError(caught instanceof Error ? caught.message : String(caught))
      );
  };

  const reminderDone = reminders.prefs.enabled && reminders.permission === 'granted';
  const steps = useMemo<Step[]>(
    () => [
      {
        id: 'schedule',
        title: 'Upload your weekly timetable',
        detail: 'Builds the schedule and subject folders.',
        icon: 'calendar',
        done: classCount > 0,
        action: () => router.push('/schedule?tab=timetable'),
      },
      {
        id: 'syllabus',
        title: 'Add a course syllabus',
        detail: 'Pulls deadlines into the Task Board.',
        icon: 'file-text',
        done: todos.some((todo) => todo.source === 'syllabus'),
        action: chooseFiles,
      },
      {
        id: 'material',
        title: 'Add your first lecture deck',
        detail: 'Unlocks grounded reading, review and quizzes.',
        icon: 'book-open',
        done: subjects.some((subject) => (subject.documentCount ?? 0) > 0),
        action: chooseFiles,
      },
      {
        id: 'alerts',
        title: 'Enable mobile reminders',
        detail: install.installed
          ? 'Receive class and deadline alerts on this device.'
          : 'Install Notomi first for reliable phone alerts.',
        icon: 'bell',
        done: reminderDone,
        action: () => {
          if (!install.installed && install.canPrompt) {
            void install.install();
            return;
          }
          if (!install.installed && install.isIOS) {
            setInstallHelp(true);
            return;
          }
          void reminders.enable();
        },
      },
    ],
    [classCount, install, onUpload, reminderDone, reminders, subjects, todos]
  );

  const complete = steps.filter((step) => step.done).length;
  if (complete === steps.length && !demoLoaded) return null;

  async function toggleDemo() {
    setWorking(true);
    setError(null);
    try {
      if (demoLoaded) await clearDemoSemester(uid);
      else await loadDemoSemester(uid);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setWorking(false);
    }
  }

  return (
    <Card className="mb-5 gap-4 bg-accent-soft/35">
      <View className="flex-row items-start gap-3">
        <View className="h-10 w-10 items-center justify-center rounded-xl bg-surface">
          <Icon name="sparkles" size={17} tone="accent" />
        </View>
        <View className="min-w-0 flex-1 gap-1">
          <Text className="text-[15px] font-semibold text-ink">Set up your semester</Text>
          <Text className="text-xs leading-5 text-muted">{complete} of {steps.length} ready</Text>
          <View className="mt-1 h-1.5 overflow-hidden rounded-full bg-line/60">
            <View className="h-full rounded-full bg-accent" style={{ width: `${(complete / steps.length) * 100}%` }} />
          </View>
        </View>
      </View>

      <View className="gap-1.5">
        {steps.map((step) => (
          <Touchable
            key={step.id}
            accessibilityRole="button"
            accessibilityLabel={`${step.done ? 'Complete' : 'Not complete'}: ${step.title}`}
            onPress={step.action}
            className="flex-row items-center gap-3 rounded-xl bg-surface/80 px-3.5 py-3"
          >
            <View className={`h-7 w-7 items-center justify-center rounded-full ${step.done ? 'bg-pine' : 'bg-sand'}`}>
              <Icon name={step.done ? 'check' : step.icon} size={13} tone={step.done ? 'inverse' : 'muted'} />
            </View>
            <View className="min-w-0 flex-1">
              <Text className={`text-sm font-semibold ${step.done ? 'text-muted line-through' : 'text-ink'}`}>{step.title}</Text>
              <Text className="text-xs text-subtle" numberOfLines={2}>{step.detail}</Text>
            </View>
            <Icon name="chevron-right" size={14} tone="subtle" />
          </Touchable>
        ))}
      </View>

      {installHelp ? (
        <Notice
          tone="amber"
          title="Install Notomi on iPhone"
          body="Open Safari’s Share menu, choose Add to Home Screen, then launch Notomi from the new icon and enable reminders here."
        />
      ) : null}
      {error ? <Notice title="That did not work" body={error} /> : null}

      <View className="flex-row flex-wrap items-center gap-2">
        <Button
          label={demoLoaded ? 'Clear demo data' : 'Load a demo semester'}
          icon={demoLoaded ? 'trash-2' : 'play'}
          variant="secondary"
          size="sm"
          loading={working}
          disabled={working || busy}
          onPress={() => void toggleDemo()}
        />
        <Text className="min-w-0 flex-1 text-[11px] leading-4 text-subtle">
          {demoLoaded
            ? 'Only records marked as demo are removed.'
            : 'Uses sample records only — no AI call and no uploaded file.'}
        </Text>
      </View>
    </Card>
  );
}
