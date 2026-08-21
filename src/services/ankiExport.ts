import { Platform, Share } from 'react-native';
import type { QuizQuestion, WeakConcept } from '@/lib/schema';
import { downloadBlob } from '@/lib/download';

/**
 * Anki export.
 *
 * Anki 2.1.55+ reads a plain CSV as long as the file opens with `#`-prefixed
 * directives telling it the separator, the column roles and whether the fields
 * are HTML. Getting those right is the difference between a clean import and a
 * deck of cards with literal `<br>` in them.
 */

export type AnkiCard = {
  front: string;
  back: string;
  tags: string[];
};

/** Anki treats a leading/trailing quote pair as an escape, so double them. */
function csvCell(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

/** Tags are whitespace-separated in Anki, so each one must be a single token. */
function tagToken(value: string): string {
  return value
    .trim()
    .replace(/[\s,]+/g, '-')
    .replace(/[^\w\-:]/g, '')
    .slice(0, 40);
}

export function cardsFromWeakConcepts(concepts: WeakConcept[]): AnkiCard[] {
  return concepts.map((concept) => ({
    front: concept.question,
    back: [
      concept.correctAnswer,
      concept.explanation ? `<br><br>${concept.explanation}` : '',
    ]
      .filter(Boolean)
      .join(''),
    tags: ['notomi', concept.subjectName ?? 'subject', concept.concept]
      .map(tagToken)
      .filter(Boolean),
  }));
}

export function cardsFromQuiz(questions: QuizQuestion[], subjectName: string | null): AnkiCard[] {
  return questions.map((question) => ({
    front: question.question,
    back: [
      question.options[question.correctAnswerIndex] ?? '',
      question.explanation ? `<br><br>${question.explanation}` : '',
    ]
      .filter(Boolean)
      .join(''),
    tags: ['notomi', subjectName ?? 'subject', question.concept ?? '']
      .map(tagToken)
      .filter(Boolean),
  }));
}

export function buildAnkiCsv(cards: AnkiCard[]): string {
  const header = ['#separator:Comma', '#html:true', '#notetype:Basic', '#tags column:3'];

  const rows = cards.map((card) =>
    [csvCell(card.front), csvCell(card.back), csvCell(card.tags.join(' '))].join(',')
  );

  return `${[...header, ...rows].join('\n')}\n`;
}

export function ankiFileName(subjectName: string | null): string {
  const slug = (subjectName ?? 'notomi')
    .toLowerCase()
    .replace(/[^\w]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
  return `notomi-${slug || 'deck'}.csv`;
}

export class ExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExportError';
  }
}

/**
 * Saves the deck. On web this is a Blob download; elsewhere the share sheet is
 * the only route to a file the Anki app can pick up.
 */
export async function downloadAnkiDeck(
  cards: AnkiCard[],
  subjectName: string | null
): Promise<number> {
  if (cards.length === 0) {
    throw new ExportError('There is nothing to export yet — miss a quiz question first.');
  }

  const csv = buildAnkiCsv(cards);
  const fileName = ankiFileName(subjectName);

  if (Platform.OS === 'web') {
    // BOM so Excel and Anki agree the file is UTF-8 before parsing a single row.
    downloadBlob(new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8' }), fileName);
    return cards.length;
  }

  await Share.share({ message: csv, title: fileName });
  return cards.length;
}
