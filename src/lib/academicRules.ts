import { createPreference } from '@/lib/preference';

/**
 * The rules a university sets that Notomi cannot guess.
 *
 * Both of these were hardcoded to one institution's answer: attendance had to
 * clear 80%, and an A was worth 4.0. Neither is wrong — they are both common —
 * but a student at a 75%-rule university was being shown the wrong number of
 * classes they could still afford to miss, and one on a 5.0 scale was shown a
 * GPA that was not their GPA. Those are wrong answers rather than missing
 * features, which is why they are settings rather than a backlog item.
 */

/* ------------------------------ Attendance ------------------------------ */

const THRESHOLDS = [70, 75, 80, 85, 90] as const;
export type AttendanceThreshold = (typeof THRESHOLDS)[number];

export const ATTENDANCE_THRESHOLDS: readonly AttendanceThreshold[] = THRESHOLDS;

/**
 * The share of classes that must be attended, as a percentage.
 *
 * Defaults to 80 because that is what the app has always assumed, so no
 * existing student's numbers move until they say otherwise.
 */
export const attendanceThreshold = createPreference<AttendanceThreshold>({
  key: 'notomi:attendance-threshold',
  fallback: 80,
  parse: (raw) =>
    THRESHOLDS.includes(raw as AttendanceThreshold) ? (raw as AttendanceThreshold) : null,
});

export const useAttendanceThreshold = attendanceThreshold.use;

/* ------------------------------ Grade scale ----------------------------- */

export type GradeScaleId = 'gpa4' | 'gpa4plus' | 'gpa5' | 'cgpa10';

export type GradeScale = {
  label: string;
  /** What a perfect grade is worth, which is also the ceiling a target is checked against. */
  max: number;
  points: Record<string, number>;
};

/**
 * Every scale carries the same letters, so the grade picker and everything
 * stored against a subject stay valid when a student switches. Only what a
 * letter is worth changes — which is the whole difference between these
 * systems anyway.
 *
 * Labelled by their ceiling rather than by name, because "4.0" and "4.3" is
 * the distinction a student recognises and "US 4-point with plus grades" is
 * not — and because a pill has room for four characters.
 */
export const GRADE_SCALES: Record<GradeScaleId, GradeScale> = {
  gpa4: {
    label: '4.0',
    max: 4,
    points: {
      'A+': 4.0, A: 4.0, 'A-': 3.7,
      'B+': 3.3, B: 3.0, 'B-': 2.7,
      'C+': 2.3, C: 2.0, 'C-': 1.7,
      'D+': 1.3, D: 1.0, F: 0.0,
    },
  },
  gpa4plus: {
    label: '4.3',
    max: 4.3,
    points: {
      'A+': 4.3, A: 4.0, 'A-': 3.7,
      'B+': 3.3, B: 3.0, 'B-': 2.7,
      'C+': 2.3, C: 2.0, 'C-': 1.7,
      'D+': 1.3, D: 1.0, F: 0.0,
    },
  },
  gpa5: {
    label: '5.0',
    max: 5,
    points: {
      'A+': 5.0, A: 5.0, 'A-': 4.5,
      'B+': 4.0, B: 3.5, 'B-': 3.0,
      'C+': 2.5, C: 2.0, 'C-': 1.5,
      'D+': 1.0, D: 0.5, F: 0.0,
    },
  },
  cgpa10: {
    label: '10.0',
    max: 10,
    points: {
      'A+': 10, A: 10, 'A-': 9,
      'B+': 8, B: 7, 'B-': 6,
      'C+': 5, C: 4, 'C-': 3,
      'D+': 2, D: 1, F: 0,
    },
  },
};

export const GRADE_SCALE_IDS = Object.keys(GRADE_SCALES) as GradeScaleId[];

export const gradeScale = createPreference<GradeScaleId>({
  key: 'notomi:grade-scale',
  fallback: 'gpa4',
  parse: (raw) => (typeof raw === 'string' && raw in GRADE_SCALES ? (raw as GradeScaleId) : null),
});

export const useGradeScale = gradeScale.use;

/**
 * The scale in force, for the maths — which runs in plain functions rather than
 * components and so cannot hold a hook. Screens that display a GPA call
 * `useGradeScale()` as well, so a change in Settings reaches them without a
 * reload.
 */
export function activeGradeScale(): GradeScale {
  return GRADE_SCALES[gradeScale.get()];
}
