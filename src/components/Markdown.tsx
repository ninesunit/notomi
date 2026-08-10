import { Fragment, useMemo } from 'react';
import { ScrollView, Text, View } from 'react-native';

/**
 * Renders the Markdown subset the notes generator produces: headings, tables,
 * fenced code, blockquotes, lists and inline emphasis.
 *
 * A full Markdown engine would be a large dependency for a fixed, known output
 * shape, and none of them render sensibly through react-native-web's Text/View
 * primitives anyway.
 */

type Block =
  | { type: 'heading'; level: number; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'list'; ordered: boolean; items: { text: string; depth: number }[] }
  | { type: 'code'; language: string; code: string }
  | { type: 'quote'; text: string }
  | { type: 'table'; header: string[]; rows: string[][] }
  | { type: 'rule' };

function splitRow(line: string): string[] {
  return line
    .replace(/^\s*\|/, '')
    .replace(/\|\s*$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

const isDivider = (line: string): boolean => /^\s*\|?[\s:—-]*-{2,}[\s:|—-]*\|?\s*$/.test(line);

export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const blocks: Block[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];

    if (!line.trim()) {
      index += 1;
      continue;
    }

    // Fenced code — consumed verbatim so Markdown inside it is not parsed.
    const fence = /^\s*```(\w*)/.exec(line);
    if (fence) {
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !/^\s*```/.test(lines[index])) {
        code.push(lines[index]);
        index += 1;
      }
      index += 1;
      blocks.push({ type: 'code', language: fence[1] || '', code: code.join('\n') });
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push({ type: 'heading', level: heading[1].length, text: heading[2].trim() });
      index += 1;
      continue;
    }

    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      blocks.push({ type: 'rule' });
      index += 1;
      continue;
    }

    // Table: a header row followed by a divider row.
    if (line.includes('|') && index + 1 < lines.length && isDivider(lines[index + 1])) {
      const header = splitRow(line);
      index += 2;
      const rows: string[][] = [];
      while (index < lines.length && lines[index].includes('|') && lines[index].trim()) {
        rows.push(splitRow(lines[index]));
        index += 1;
      }
      blocks.push({ type: 'table', header, rows });
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const quote: string[] = [];
      while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
        quote.push(lines[index].replace(/^\s*>\s?/, ''));
        index += 1;
      }
      blocks.push({ type: 'quote', text: quote.join(' ').trim() });
      continue;
    }

    const bullet = /^(\s*)([-*+]|\d+[.)])\s+/.exec(line);
    if (bullet) {
      const ordered = /\d/.test(bullet[2]);
      const items: { text: string; depth: number }[] = [];
      while (index < lines.length) {
        const match = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[index]);
        if (!match) break;
        items.push({ text: match[3], depth: Math.floor(match[1].length / 2) });
        index += 1;
      }
      blocks.push({ type: 'list', ordered, items });
      continue;
    }

    // Paragraph: run until a blank line or the start of another block.
    const paragraph: string[] = [];
    while (
      index < lines.length &&
      lines[index].trim() &&
      !/^\s*(#{1,6}\s|```|>|\s*([-*+]|\d+[.)])\s)/.test(lines[index]) &&
      !(lines[index].includes('|') && index + 1 < lines.length && isDivider(lines[index + 1]))
    ) {
      paragraph.push(lines[index].trim());
      index += 1;
    }
    if (paragraph.length) blocks.push({ type: 'paragraph', text: paragraph.join(' ') });
    else index += 1;
  }

  return blocks;
}

/** Inline emphasis, code and LaTeX, in one pass. */
function Inline({ text, className = '' }: { text: string; className?: string }) {
  const parts = useMemo(
    () => text.split(/(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`|\$[^$]+\$)/g).filter(Boolean),
    [text]
  );

  return (
    <>
      {parts.map((part, index) => {
        if (part.startsWith('**') && part.endsWith('**')) {
          return (
            <Text key={index} className={`font-bold text-ink ${className}`}>
              {part.slice(2, -2)}
            </Text>
          );
        }
        if (part.startsWith('`') && part.endsWith('`')) {
          return (
            <Text key={index} className="font-mono text-[13px] text-accent">
              {part.slice(1, -1)}
            </Text>
          );
        }
        // LaTeX is shown as-is: a maths typesetter is a heavy dependency, and
        // the raw expression is still readable to the student who wrote it.
        if (part.startsWith('$') && part.endsWith('$')) {
          return (
            <Text key={index} className="font-mono text-[13px] text-pine">
              {part.slice(1, -1)}
            </Text>
          );
        }
        if (part.startsWith('*') && part.endsWith('*')) {
          return (
            <Text key={index} className={`italic ${className}`}>
              {part.slice(1, -1)}
            </Text>
          );
        }
        return <Fragment key={index}>{part}</Fragment>;
      })}
    </>
  );
}

const HEADING_STYLE: Record<number, string> = {
  1: 'text-[26px] font-bold leading-8 mt-6',
  2: 'text-[21px] font-bold leading-7 mt-6',
  3: 'text-[17px] font-semibold leading-6 mt-5',
  4: 'text-[15px] font-semibold leading-6 mt-4',
  5: 'text-[14px] font-semibold leading-5 mt-3',
  6: 'text-[13px] font-semibold leading-5 mt-3',
};

export function Markdown({ source }: { source: string }) {
  const blocks = useMemo(() => parseMarkdown(source), [source]);

  return (
    <View className="gap-3">
      {blocks.map((block, index) => {
        switch (block.type) {
          case 'heading':
            return (
              <Text key={index} className={`text-ink ${HEADING_STYLE[block.level] ?? ''}`}>
                <Inline text={block.text} />
              </Text>
            );

          case 'paragraph':
            return (
              <Text key={index} className="text-[15px] leading-7 text-ink/85">
                <Inline text={block.text} />
              </Text>
            );

          case 'list':
            return (
              <View key={index} className="gap-1.5">
                {block.items.map((item, i) => (
                  <View
                    key={i}
                    className="flex-row gap-2.5"
                    style={{ paddingLeft: item.depth * 16 }}
                  >
                    <Text className="text-[15px] leading-7 text-subtle">
                      {block.ordered ? `${i + 1}.` : '•'}
                    </Text>
                    <Text className="flex-1 text-[15px] leading-7 text-ink/85">
                      <Inline text={item.text} />
                    </Text>
                  </View>
                ))}
              </View>
            );

          case 'code':
            return (
              <View key={index} className="overflow-hidden rounded-xl bg-ink">
                {block.language ? (
                  <View className="border-b border-paper/10 px-4 py-1.5">
                    <Text className="text-[11px] font-semibold uppercase tracking-wider text-paper/50">
                      {block.language}
                    </Text>
                  </View>
                ) : null}
                <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                  <Text className="p-4 font-mono text-[13px] leading-5 text-paper">
                    {block.code}
                  </Text>
                </ScrollView>
              </View>
            );

          case 'quote':
            return (
              <View key={index} className="flex-row gap-3 rounded-r-xl bg-pine-soft/60 py-2 pr-3">
                <View className="w-1 rounded-full bg-pine" />
                <Text className="flex-1 text-[15px] leading-7 text-ink/80">
                  <Inline text={block.text} />
                </Text>
              </View>
            );

          case 'table':
            return <MarkdownTable key={index} header={block.header} rows={block.rows} />;

          case 'rule':
            return <View key={index} className="my-2 h-px w-full bg-line" />;
        }
      })}
    </View>
  );
}

/**
 * Tables scroll horizontally in their own container. Wide tables are common in
 * the terminology section and must never widen the page itself.
 */
function MarkdownTable({ header, rows }: { header: string[]; rows: string[][] }) {
  const columnWidth = header.length <= 2 ? 260 : header.length === 3 ? 200 : 170;

  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} className="my-1">
      {/* The border belongs to the content, not the scroller: on a table
          narrower than the viewport it would otherwise frame empty space. */}
      <View className="overflow-hidden rounded-xl border border-line">
        <View className="flex-row bg-sand">
          {header.map((cell, index) => (
            <View key={index} style={{ width: columnWidth }} className="px-3 py-2.5">
              <Text className="text-[13px] font-bold text-ink">
                <Inline text={cell} />
              </Text>
            </View>
          ))}
        </View>

        {rows.map((row, rowIndex) => (
          <View
            key={rowIndex}
            className={`flex-row ${rowIndex % 2 ? 'bg-paper/50' : 'bg-surface'} border-t border-line`}
          >
            {header.map((_, cellIndex) => (
              <View key={cellIndex} style={{ width: columnWidth }} className="px-3 py-2.5">
                <Text className="text-[13px] leading-5 text-ink/85">
                  <Inline text={row[cellIndex] ?? ''} />
                </Text>
              </View>
            ))}
          </View>
        ))}
      </View>
    </ScrollView>
  );
}
