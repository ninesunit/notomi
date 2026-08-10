import { AiError, generateProse, MAX_CONTEXT_CHARS } from '@/lib/ai';

/**
 * Full-length study notes.
 *
 * Deliberately verbose: this replaces reading the source, so it has to carry
 * the actual content rather than gesture at it. The prompt fixes the section
 * order so a student's notes look the same across every subject, and the
 * renderer can rely on the structure.
 */

export const NOTES_SECTIONS = [
  'Executive Overview',
  'Key Terminology',
  'Detailed Concept Breakdown',
  'Key Formulas & Code',
  'Review & Self-Test Questions',
] as const;

function buildPrompt(title: string, text: string): string {
  return `You are writing the definitive study notes for a university student on "${title}".

These notes replace reading the original material, so they must be genuinely
comprehensive. Explain the substance; never write "the document discusses X"
without then explaining X. Aim for real depth over brevity.

Output GitHub-flavoured Markdown with exactly these top-level sections, in this
order, each as an "## " heading:

## Executive Overview
Three to five paragraphs covering what this material is about, why it matters in
the wider subject, and what a student should be able to do after mastering it.

## Key Terminology
A Markdown table with columns | Term | Definition | Why it matters |. One row per
significant term — aim for 8-20 rows where the material supports it. Definitions
must be self-contained sentences, not fragments.

## Detailed Concept Breakdown
The heart of the notes. One "### " subsection per major concept. For each:
explain it from first principles, give the intuition before the formalism, work
through an example where the source provides one, and call out the mistakes a
student is likely to make. Use nested bullets and short paragraphs. This section
should be the longest by a wide margin.

## Key Formulas & Code
Every formula and code snippet in the material. Formulas in LaTeX between $
delimiters; code in fenced blocks with a language tag. Under each, state what
every symbol or identifier means and when you would use it. Write
"None in this material." if there genuinely are none.

## Review & Self-Test Questions
8-12 questions ordered from recall to application to analysis. Give each answer
underneath in a "> " blockquote so it can be skimmed past on a first read.

Rules:
- Work only from the SOURCE below. Never introduce outside facts.
- Where the source is thin on a concept, say so plainly rather than padding.
- Use **bold** for key terms on first use.
- No preamble and no sign-off — start at "## Executive Overview".

SOURCE
======
${text.slice(0, MAX_CONTEXT_CHARS)}`;
}

/** Rough guard so a truncated generation is not silently saved as notes. */
function looksComplete(markdown: string): boolean {
  const headings = (markdown.match(/^## /gm) ?? []).length;
  return headings >= 4 && markdown.length > 800;
}

export async function generateNotes(title: string, text: string): Promise<string> {
  if (!text.trim()) throw new AiError('This document has no text to write notes from.');

  const markdown = (await generateProse(buildPrompt(title, text))).trim();

  if (!looksComplete(markdown)) {
    throw new AiError(
      'Gemini returned notes that look incomplete. Try again — long documents occasionally ' +
        'truncate part-way.'
    );
  }
  return markdown;
}
