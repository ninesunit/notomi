import { Fragment, useMemo } from 'react';
import { Text, View } from 'react-native';

/**
 * Gemini answers come back as light markdown with inline citations. Rather than
 * pulling in a markdown engine, this renders the handful of constructs the
 * reader prompt actually produces: headings, bullets, numbered steps, bold
 * spans, "quoted evidence" and [Source] tags.
 */
export function RichText({ text, tone = 'ink' }: { text: string; tone?: 'ink' | 'paper' }) {
  const blocks = useMemo(() => text.trim().split(/\n{2,}/), [text]);
  const body = tone === 'paper' ? 'text-paper' : 'text-ink/85';

  return (
    <View className="gap-2.5">
      {blocks.map((block, blockIndex) => (
        <Block key={blockIndex} block={block} body={body} tone={tone} />
      ))}
    </View>
  );
}

function Block({ block, body, tone }: { block: string; body: string; tone: 'ink' | 'paper' }) {
  const lines = block.split('\n').filter((line) => line.trim());

  const isBulleted = lines.every((line) => /^\s*[-*•]\s+/.test(line));
  const isNumbered = lines.length > 1 && lines.every((line) => /^\s*\d+[.)]\s+/.test(line));

  if (isBulleted || isNumbered) {
    return (
      <View className="gap-1.5">
        {lines.map((line, index) => (
          <View key={index} className="flex-row gap-2.5">
            <Text className={`text-[15px] leading-6 ${tone === 'paper' ? 'text-paper/60' : 'text-subtle'}`}>
              {isNumbered ? `${index + 1}.` : '•'}
            </Text>
            <Text className={`flex-1 text-[15px] leading-6 ${body}`}>
              <Inline text={line.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '')} tone={tone} />
            </Text>
          </View>
        ))}
      </View>
    );
  }

  const heading = /^(#{1,4})\s+(.*)$/.exec(lines[0] ?? '');
  if (heading && lines.length === 1) {
    return (
      <Text className={`mt-1 text-[15px] font-bold ${tone === 'paper' ? 'text-paper' : 'text-ink'}`}>
        {heading[2]}
      </Text>
    );
  }

  return (
    <Text className={`text-[15px] leading-6 ${body}`}>
      <Inline text={lines.join(' ')} tone={tone} />
    </Text>
  );
}

/** Splits on **bold**, "quotes" and [citations] in one pass. */
function Inline({ text, tone }: { text: string; tone: 'ink' | 'paper' }) {
  const parts = useMemo(
    () => text.split(/(\*\*[^*]+\*\*|"[^"]{3,}"|\[[^\]]{1,60}\])/g).filter(Boolean),
    [text]
  );

  return (
    <>
      {parts.map((part, index) => {
        if (part.startsWith('**') && part.endsWith('**')) {
          return (
            <Text key={index} className={`font-semibold ${tone === 'paper' ? 'text-paper' : 'text-ink'}`}>
              {part.slice(2, -2)}
            </Text>
          );
        }

        if (part.startsWith('"') && part.endsWith('"')) {
          return (
            <Text
              key={index}
              className={tone === 'paper' ? 'italic text-paper' : 'italic text-pine'}
            >
              {part}
            </Text>
          );
        }

        if (part.startsWith('[') && part.endsWith(']')) {
          return (
            <Text
              key={index}
              className={`text-[13px] font-semibold ${tone === 'paper' ? 'text-paper/70' : 'text-accent'}`}
            >
              {part}
            </Text>
          );
        }

        return <Fragment key={index}>{part}</Fragment>;
      })}
    </>
  );
}
