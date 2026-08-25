import { createPreference } from '@/lib/preference';

export type AppLanguage =
  | 'auto'
  | 'en'
  | 'ms'
  | 'id'
  | 'zh-CN'
  | 'zh-TW'
  | 'ta'
  | 'ar'
  | 'es'
  | 'fr';

export const LANGUAGE_OPTIONS: Array<{ id: AppLanguage; label: string; detail: string }> = [
  { id: 'auto', label: 'Automatic', detail: 'Follow the language used in the question.' },
  { id: 'en', label: 'English', detail: 'English' },
  { id: 'ms', label: 'Bahasa Melayu', detail: 'Malay' },
  { id: 'id', label: 'Bahasa Indonesia', detail: 'Indonesian' },
  { id: 'zh-CN', label: '简体中文', detail: 'Simplified Chinese' },
  { id: 'zh-TW', label: '繁體中文', detail: 'Traditional Chinese' },
  { id: 'ta', label: 'தமிழ்', detail: 'Tamil' },
  { id: 'ar', label: 'العربية', detail: 'Arabic' },
  { id: 'es', label: 'Español', detail: 'Spanish' },
  { id: 'fr', label: 'Français', detail: 'French' },
];

const ids = new Set<AppLanguage>(LANGUAGE_OPTIONS.map((option) => option.id));

export const languagePreference = createPreference<AppLanguage>({
  key: 'notomi:language-v1',
  fallback: 'auto',
  parse: (raw) => (typeof raw === 'string' && ids.has(raw as AppLanguage) ? raw as AppLanguage : null),
});

export function languageLabel(language: AppLanguage): string {
  return LANGUAGE_OPTIONS.find((option) => option.id === language)?.label ?? 'Automatic';
}

/**
 * One instruction shared by chat, notes, quizzes and document analysis.
 * Identifiers and quotations are protected so choosing another explanation
 * language never translates a course code, room, date, JSON key or source.
 */
export function aiLanguageInstruction(): string {
  const language = languagePreference.get();
  const response =
    language === 'auto'
      ? "Use the language of the student's latest request. If there is no request or it is unclear, use English."
      : `Write student-facing explanations in ${languageLabel(language)}.`;

  return [
    'LANGUAGE:',
    `- ${response}`,
    '- Preserve course codes, names, room codes, dates, formulas, code, JSON keys, enum values and quoted source text exactly.',
    '- A request to transcribe or extract exact text overrides translation.',
  ].join('\n');
}

