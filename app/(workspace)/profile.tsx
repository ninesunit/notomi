import { useEffect, useState } from 'react';
import { Image, Pressable, Text, View } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import { updateProfile as updateAuthProfile } from 'firebase/auth';
import { limit, query, where } from 'firebase/firestore';
import { Icon } from '@/components/Icon';
import { ScreenScroll } from '@/components/ScreenScroll';
import { Sheet } from '@/components/Sheet';
import { SurfaceBack } from '@/components/SurfaceBack';
import { Button, Card, Field, Loading, Notice, PageHeader } from '@/components/ui';
import { useAuth, useUid } from '@/hooks/useAuth';
import { useCollection, useDocument } from '@/hooks/useFirestore';
import { paths } from '@/lib/paths';
import type { AttendanceLog } from '@/lib/schema';
import { getDb } from '@/services/firebase';
import {
  normaliseUsername,
  normaliseProfileStats,
  myProfile,
  profilePath,
  saveProfile,
  syncPublicAttendanceBadge,
  type Profile,
} from '@/services/social';
import {
  deleteR2File,
  PROFILE_IMAGE_MAX_BYTES,
  uploadProfileImage,
} from '@/services/r2Storage';
import { searchUniversities, universityLabel, type University } from '@/services/universities';

const AVATAR_PRESETS = ['#B4552D', '#2E6F5E', '#4C5FA8', '#8A4B86', '#2B7A78'];

export default function ProfilePage() {
  const uid = useUid();
  const { user } = useAuth();
  const profile = useDocument<Profile>(profilePath(getDb(), uid), [uid]);
  const attendanceCutoff = recentAttendanceCutoff();
  const recentAttendance = useCollection<AttendanceLog>(
    query(paths.attendanceLogs(getDb(), uid), where('date', '>=', attendanceCutoff), limit(50)),
    [uid, attendanceCutoff]
  );
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    void myProfile(uid).catch((error) =>
      console.warn('[profile] Existing profile migration could not be completed.', error)
    );
  }, [uid]);

  useEffect(() => {
    if (recentAttendance.loading || !profile.data) return;
    const earned =
      recentAttendance.data.length >= 4 &&
      recentAttendance.data.every((entry) => entry.status === 'present');
    if (profile.data.stats?.perfectAttendanceMonth === earned) return;
    void syncPublicAttendanceBadge(uid, earned).catch((error) =>
      console.warn('[profile] Attendance badge could not be updated.', error)
    );
  }, [profile.data, recentAttendance.data, recentAttendance.loading, uid]);

  if (profile.loading) {
    return (
      <ScreenScroll>
        <Loading label="Opening your profile…" />
      </ScreenScroll>
    );
  }

  const current = profile.data;
  const displayName = current?.displayName || user?.displayName || 'Student';
  const color = current?.avatarPreset || current?.color || '#B4552D';
  const stats = normaliseProfileStats(current?.stats);
  const achievements = profileAchievements(stats);

  return (
    <ScreenScroll maxWidth={760}>
      <SurfaceBack href="/dashboard" label="Back to Dashboard" />
      <View className="mt-4" />
      <PageHeader
        title="Student profile"
        subtitle="Your public identity for search, friends, quiz challenges and project sprints."
        actions={<Button label="Edit Profile" icon="edit-3" onPress={() => setEditing(true)} />}
      />

      {profile.error ? <Notice title="Could not load your profile" body={profile.error.message} /> : null}

      <Card className="gap-6 p-6">
        <View className="flex-row flex-wrap items-center gap-5">
          <ProfileAvatar
            name={displayName}
            color={color}
            avatarUrl={current?.avatarUrl ?? null}
            size={84}
          />
          <View className="min-w-[220px] flex-1 gap-1">
            <Text className="text-2xl font-bold tracking-tight text-ink">{displayName}</Text>
            <Text className="text-sm font-semibold text-accent">
              {current?.username ? `@${current.username}` : 'Choose a username'}
            </Text>
            <Text className="text-sm text-muted">
              {current?.major || 'Add your major and university'}
            </Text>
            {current?.university ? (
              <Text className="text-xs font-medium text-subtle">{universityLabel(current)}</Text>
            ) : null}
            <View className="mt-2 flex-row flex-wrap gap-2">
              {current?.shareCourses ? <ProfilePill icon="book-open" label="Classmate discovery on" /> : null}
              {current?.sharePresence ? <ProfilePill icon="activity" label="Live study status on" /> : null}
            </View>
          </View>
        </View>

        <View className="h-px bg-line" />

        <View className="gap-2">
          <View className="flex-row items-center gap-2">
            <Icon name="user" size={15} color="#6F6A5F" />
            <Text className="text-xs font-bold uppercase tracking-wider text-muted">Bio</Text>
          </View>
          <Text className="text-sm leading-6 text-ink">
            {current?.bio || 'No bio yet. Add a short introduction so classmates know what you study.'}
          </Text>
        </View>
      </Card>

      <Card className="mt-5 gap-5 p-6">
        <View className="flex-row items-center gap-2">
          <Icon name="trending-up" size={17} color="#B4552D" />
          <Text className="font-heading text-lg font-semibold text-ink">Learning stats</Text>
        </View>
        <View className="flex-row flex-wrap gap-3">
          <ProfileStat icon="layers" value={String(stats.masteredCards)} label="Cards mastered" />
          <ProfileStat icon="timer" value={formatHours(stats.focusMinutes)} label="Focus time" />
          <ProfileStat icon="flame" value={String(stats.currentStreak)} label="Day streak" />
          <ProfileStat icon="trophy" value={String(stats.arenaWins)} label="Arena wins" />
        </View>
        <View className="h-px bg-line" />
        <View className="gap-2">
          <Text className="text-xs font-bold uppercase tracking-wider text-muted">Achievements</Text>
          {achievements.length ? (
            <View className="flex-row flex-wrap gap-2">
              {achievements.map((achievement) => (
                <View key={achievement.label} className="flex-row items-center gap-2 rounded-full bg-amber-soft px-3 py-2">
                  <Icon name="award" size={14} color="#B4832A" />
                  <Text className="text-xs font-semibold text-ink">{achievement.label}</Text>
                </View>
              ))}
            </View>
          ) : (
            <Text className="text-sm text-muted">Keep learning, focusing and sharing materials to unlock profile badges.</Text>
          )}
        </View>
      </Card>

      <EditProfileModal
        visible={editing}
        profile={current}
        fallbackName={user?.displayName || ''}
        onClose={() => setEditing(false)}
        onSaved={async (name) => {
          if (user && name !== user.displayName) await updateAuthProfile(user, { displayName: name });
          setEditing(false);
        }}
      />
    </ScreenScroll>
  );
}

function ProfileAvatar({
  name,
  color,
  avatarUrl,
  size,
}: {
  name: string;
  color: string;
  avatarUrl: string | null;
  size: number;
}) {
  if (avatarUrl) {
    return <Image source={{ uri: avatarUrl }} style={{ width: size, height: size, borderRadius: size / 2 }} />;
  }
  return (
    <View
      className="items-center justify-center rounded-full"
      style={{ width: size, height: size, backgroundColor: `${color}24` }}
    >
      <Text className="text-2xl font-bold" style={{ color }}>
        {name.charAt(0).toUpperCase()}
      </Text>
    </View>
  );
}

function EditProfileModal({
  visible,
  profile,
  fallbackName,
  onClose,
  onSaved,
}: {
  visible: boolean;
  profile: Profile | null;
  fallbackName: string;
  onClose: () => void;
  onSaved: (displayName: string) => Promise<void>;
}) {
  const uid = useUid();
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [avatarUrl, setAvatarUrl] = useState('');
  const [avatarKey, setAvatarKey] = useState('');
  const [pendingAvatar, setPendingAvatar] = useState<DocumentPicker.DocumentPickerAsset | null>(null);
  const [avatarPreset, setAvatarPreset] = useState(AVATAR_PRESETS[0]);
  const [university, setUniversity] = useState('');
  const [universityId, setUniversityId] = useState('');
  const [universityAbbreviation, setUniversityAbbreviation] = useState('');
  const [universityResults, setUniversityResults] = useState<University[]>([]);
  const [searchingUniversities, setSearchingUniversities] = useState(false);
  const [major, setMajor] = useState('');
  const [bio, setBio] = useState('');
  const [shareCourses, setShareCourses] = useState(false);
  const [sharePresence, setSharePresence] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!visible) return;
    setUsername(profile?.username ?? '');
    setDisplayName(profile?.displayName ?? fallbackName);
    setAvatarUrl(profile?.avatarUrl ?? '');
    setAvatarKey(profile?.avatarKey ?? '');
    setPendingAvatar(null);
    setAvatarPreset(profile?.avatarPreset || profile?.color || AVATAR_PRESETS[0]);
    setUniversity(profile?.university ?? '');
    setUniversityId(profile?.universityId ?? '');
    setUniversityAbbreviation(profile?.universityAbbreviation ?? '');
    setUniversityResults([]);
    setMajor(profile?.major ?? '');
    setBio(profile?.bio ?? '');
    setShareCourses(profile?.shareCourses === true);
    setSharePresence(profile?.sharePresence === true);
    setError(null);
  }, [visible, profile, fallbackName]);

  async function chooseAvatar() {
    setError(null);
    const result = await DocumentPicker.getDocumentAsync({
      type: ['image/jpeg', 'image/png', 'image/webp'],
      multiple: false,
      copyToCacheDirectory: true,
    });
    if (result.canceled) return;
    const asset = result.assets[0];
    if ((asset.size ?? 0) > PROFILE_IMAGE_MAX_BYTES) {
      setError('Profile images must be 2 MB or smaller.');
      return;
    }
    setPendingAvatar(asset);
    setAvatarUrl(asset.uri);
  }

  function removeAvatar() {
    setPendingAvatar(null);
    setAvatarUrl('');
    setAvatarKey('');
  }

  useEffect(() => {
    if (!visible || university.trim().length < 2 || universityId) {
      setUniversityResults([]);
      setSearchingUniversities(false);
      return;
    }
    let active = true;
    setSearchingUniversities(true);
    const timer = setTimeout(() => {
      void searchUniversities(university)
        .then((results) => active && setUniversityResults(results))
        .catch(() => active && setUniversityResults([]))
        .finally(() => active && setSearchingUniversities(false));
    }, 180);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [visible, university, universityId]);

  async function submit() {
    setBusy(true);
    setError(null);
    let uploadedKey = '';
    try {
      if (university.trim() && !universityId) {
        throw new Error('Select your university from the verified directory.');
      }
      let nextAvatarUrl = avatarUrl;
      let nextAvatarKey = avatarKey;
      if (pendingAvatar) {
        const bytes = pendingAvatar.file
          ? await pendingAvatar.file.arrayBuffer()
          : await (await fetch(pendingAvatar.uri)).arrayBuffer();
        if (bytes.byteLength > PROFILE_IMAGE_MAX_BYTES) {
          throw new Error('Profile images must be 2 MB or smaller.');
        }
        const uploaded = await uploadProfileImage(
          pendingAvatar.uri,
          pendingAvatar.name || 'profile.jpg',
          uid,
          profileImageMimeType(pendingAvatar),
          bytes
        );
        uploadedKey = uploaded.fileKey;
        nextAvatarKey = uploaded.fileKey;
        nextAvatarUrl = uploaded.fileUrl;
      }

      await saveProfile(uid, {
        username,
        displayName,
        avatarUrl: nextAvatarUrl || null,
        avatarKey: nextAvatarKey,
        avatarPreset,
        university,
        universityId,
        universityAbbreviation,
        major,
        bio,
        color: avatarPreset,
        courseCodes: profile?.courseCodes ?? [],
        shareCourses,
        sharePresence,
        stats: profile?.stats,
      });
      if (profile?.avatarKey && profile.avatarKey !== nextAvatarKey) {
        await deleteR2File(profile.avatarKey).catch(() => undefined);
      }
      await onSaved(displayName.trim());
    } catch (caught) {
      if (uploadedKey) await deleteR2File(uploadedKey).catch(() => undefined);
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      title="Edit Profile"
      icon="edit-3"
      maxHeight={720}
      footer={
        <>
          <Button label="Cancel" variant="ghost" disabled={busy} onPress={onClose} />
          <View className="flex-1" />
          <Button
            label="Save Profile"
            icon="check-circle-2"
            loading={busy}
            disabled={username.length < 3 || !displayName.trim()}
            onPress={() => void submit()}
          />
        </>
      }
    >
      {error ? <Notice title="Profile was not saved" body={error} /> : null}
      <Field
        label="Username"
        value={username}
        onChangeText={(value) => setUsername(normaliseUsername(value))}
        placeholder="student.username"
        autoCapitalize="none"
        autoCorrect={false}
      />
      <Field label="Display name" value={displayName} onChangeText={setDisplayName} placeholder="Your name" />
      <View className="gap-3">
        <Text className="text-sm font-medium text-muted">Profile picture</Text>
        <View className="flex-row flex-wrap items-center gap-3 rounded-xl border border-line bg-paper p-3">
          <ProfileAvatar
            name={displayName || 'Student'}
            color={avatarPreset}
            avatarUrl={avatarUrl || null}
            size={64}
          />
          <View className="min-w-[180px] flex-1 gap-1">
            <Text className="text-sm font-semibold text-ink">
              {pendingAvatar ? pendingAvatar.name : avatarUrl ? 'Current profile picture' : 'No picture selected'}
            </Text>
            <Text className="text-xs leading-4 text-muted">JPEG, PNG or WebP. Maximum 2 MB.</Text>
            <View className="mt-1 flex-row flex-wrap gap-2">
              <Button
                label={avatarUrl ? 'Change photo' : 'Upload photo'}
                icon="camera"
                variant="secondary"
                size="sm"
                disabled={busy}
                onPress={() => void chooseAvatar()}
              />
              {avatarUrl ? (
                <Button
                  label="Remove"
                  icon="trash-2"
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onPress={removeAvatar}
                />
              ) : null}
            </View>
          </View>
        </View>
      </View>
      <View className="gap-2">
        <Text className="text-sm font-medium text-muted">Avatar preset</Text>
        <View className="flex-row gap-2">
          {AVATAR_PRESETS.map((preset) => (
            <Pressable
              key={preset}
              accessibilityRole="radio"
              accessibilityState={{ selected: avatarPreset === preset }}
              accessibilityLabel={`Use avatar colour ${preset}`}
              onPress={() => setAvatarPreset(preset)}
              className="h-10 w-10 items-center justify-center rounded-full"
              style={{ backgroundColor: `${preset}24`, borderWidth: avatarPreset === preset ? 2 : 0, borderColor: preset }}
            >
              {avatarPreset === preset ? <Icon name="check" size={15} color={preset} /> : null}
            </Pressable>
          ))}
        </View>
      </View>
      <View className="gap-2">
        <Field
          label="University"
          value={university}
          onChangeText={(value) => {
            setUniversity(value);
            setUniversityId('');
            setUniversityAbbreviation('');
          }}
          placeholder="Search a verified university, such as MMU"
          autoCorrect={false}
        />
        {searchingUniversities ? (
          <Text className="text-xs text-muted">Searching the verified university directory...</Text>
        ) : universityResults.length ? (
          <View className="overflow-hidden rounded-xl border border-line bg-paper">
            {universityResults.map((entry) => (
              <Pressable
                key={entry.id}
                accessibilityRole="button"
                onPress={() => {
                  setUniversity(entry.name);
                  setUniversityId(entry.id);
                  setUniversityAbbreviation(entry.abbreviation);
                  setUniversityResults([]);
                }}
                className="flex-row items-center gap-3 border-b border-line px-3 py-3 last:border-b-0"
              >
                <Icon name="graduation-cap" size={16} color="#6F6A5F" />
                <View className="min-w-0 flex-1">
                  <Text className="text-sm font-semibold text-ink" numberOfLines={1}>{entry.name}</Text>
                  <Text className="text-xs text-muted" numberOfLines={1}>{entry.abbreviation} · {entry.country}</Text>
                </View>
              </Pressable>
            ))}
          </View>
        ) : universityId ? (
          <View className="flex-row items-center gap-2 rounded-xl bg-pine-soft px-3 py-2">
            <Icon name="check" size={14} color="#2E6F5E" />
            <Text className="text-xs font-semibold text-pine">Verified university selected</Text>
          </View>
        ) : null}
      </View>
      <Field label="Major" value={major} onChangeText={setMajor} placeholder="Degree or field of study" />
      <Field label="Bio" value={bio} onChangeText={setBio} placeholder="What are you studying or working toward?" multiline />
      <View className="gap-2">
        <Text className="text-sm font-medium text-muted">Social privacy</Text>
        <PrivacyToggle
          icon="book-open"
          title="Find classmates"
          detail="Share course codes only. Course materials, timetable details and marks remain private."
          value={shareCourses}
          onChange={setShareCourses}
        />
        <PrivacyToggle
          icon="activity"
          title="Share live study status"
          detail="Friends may see when you are focusing. This is off until you enable it."
          value={sharePresence}
          onChange={setSharePresence}
        />
      </View>
    </Sheet>
  );
}

function profileImageMimeType(asset: DocumentPicker.DocumentPickerAsset): string {
  if (asset.mimeType === 'image/jpeg' || asset.mimeType === 'image/png' || asset.mimeType === 'image/webp') {
    return asset.mimeType;
  }
  const extension = asset.name.split('.').pop()?.toLowerCase();
  if (extension === 'png') return 'image/png';
  if (extension === 'webp') return 'image/webp';
  return 'image/jpeg';
}

function ProfilePill({ icon, label }: { icon: 'book-open' | 'activity'; label: string }) {
  return (
    <View className="flex-row items-center gap-1.5 rounded-full bg-pine-soft px-2.5 py-1">
      <Icon name={icon} size={12} color="#2E6F5E" />
      <Text className="text-[11px] font-semibold text-pine">{label}</Text>
    </View>
  );
}

function PrivacyToggle({
  icon,
  title,
  detail,
  value,
  onChange,
}: {
  icon: 'book-open' | 'activity';
  title: string;
  detail: string;
  value: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityState={{ checked: value }}
      onPress={() => onChange(!value)}
      className="flex-row items-center gap-3 rounded-xl border border-line bg-paper p-3"
    >
      <View className={`h-9 w-9 items-center justify-center rounded-lg ${value ? 'bg-pine-soft' : 'bg-sand'}`}>
        <Icon name={icon} size={16} color={value ? '#2E6F5E' : '#6F6A5F'} />
      </View>
      <View className="min-w-0 flex-1 gap-0.5">
        <Text className="text-sm font-semibold text-ink">{title}</Text>
        <Text className="text-xs leading-4 text-muted">{detail}</Text>
      </View>
      <View className={`h-6 w-11 rounded-full p-0.5 ${value ? 'bg-pine' : 'bg-line'}`}>
        <View className={`h-5 w-5 rounded-full bg-white ${value ? 'self-end' : 'self-start'}`} />
      </View>
    </Pressable>
  );
}

function ProfileStat({
  icon,
  value,
  label,
}: {
  icon: 'layers' | 'timer' | 'flame' | 'trophy';
  value: string;
  label: string;
}) {
  return (
    <View className="min-w-[130px] flex-1 rounded-xl bg-sand p-3">
      <Icon name={icon} size={15} color="#6F6A5F" />
      <Text className="mt-2 font-heading text-xl font-bold text-ink">{value}</Text>
      <Text className="mt-0.5 text-xs text-muted">{label}</Text>
    </View>
  );
}

function profileAchievements(stats: Profile['stats']): { label: string }[] {
  if (!stats) return [];
  return [
    ...(stats.nightFocusMinutes >= 600 ? [{ label: 'The Night Owl' }] : []),
    ...(stats.perfectAttendanceMonth ? [{ label: 'The Regular' }] : []),
    ...(stats.arenaWins >= 50 ? [{ label: 'Arena Champion' }] : []),
    ...(stats.materialCount >= 20 ? [{ label: 'Library Architect' }] : []),
    ...(stats.masteredCards >= 100 ? [{ label: 'Knowledge Keeper' }] : []),
  ];
}

function recentAttendanceCutoff(): string {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 30);
  return `${cutoff.getFullYear()}-${String(cutoff.getMonth() + 1).padStart(2, '0')}-${String(
    cutoff.getDate()
  ).padStart(2, '0')}`;
}

function formatHours(minutes: number): string {
  const safeMinutes = Number.isFinite(minutes) && minutes > 0 ? Math.floor(minutes) : 0;
  if (safeMinutes < 60) return `${safeMinutes}m`;
  const hours = Math.floor(safeMinutes / 60);
  const remainder = safeMinutes % 60;
  return remainder ? `${hours}h ${remainder}m` : `${hours}h`;
}
