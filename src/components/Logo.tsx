import { View } from 'react-native';

/**
 * The Notomi mark: five nodes joined into an "N".
 *
 * Drawn from Views rather than loaded as an image so it stays crisp at any
 * size, needs no asset request, and can be recoloured. It is the same shape as
 * the app icon and the program structure map — the degree as a graph.
 */
export function Logo({ size = 32, tone = 'ink' }: { size?: number; tone?: 'ink' | 'paper' }) {
  const surface = tone === 'ink' ? '#1B1A17' : '#F7F5EE';
  const stroke = tone === 'ink' ? '#F7F5EE' : '#1B1A17';
  const accent = '#B4552D';

  // Geometry is a fraction of the tile so a 24px logo and a 40px one are the
  // same drawing, not two approximations of it.
  const span = size * 0.56;
  const inset = (size - span) / 2;
  const edge = Math.max(1.5, span * 0.135);
  const node = Math.max(2.5, span * 0.16);

  const dot = (left: number, top: number, radius: number, color: string) => (
    <View
      style={{
        position: 'absolute',
        left: left - radius,
        top: top - radius,
        width: radius * 2,
        height: radius * 2,
        borderRadius: radius,
        backgroundColor: color,
      }}
    />
  );

  const stem = (left: number) => (
    <View
      style={{
        position: 'absolute',
        left: left - edge / 2,
        top: inset,
        width: edge,
        height: span,
        borderRadius: edge / 2,
        backgroundColor: stroke,
      }}
    />
  );

  // The diagonal is one bar rotated about its centre — two half-segments would
  // need their own joint handling for no visual gain at this size.
  const diagonalLength = Math.sqrt(span * span + span * span);
  const angle = `${(Math.atan2(span, span) * 180) / Math.PI}deg`;

  return (
    <View
      style={{ width: size, height: size, borderRadius: size * 0.28, backgroundColor: surface }}
    >
      {stem(inset)}
      {stem(inset + span)}

      <View
        style={{
          position: 'absolute',
          left: size / 2 - diagonalLength / 2,
          top: size / 2 - edge / 2,
          width: diagonalLength,
          height: edge,
          borderRadius: edge / 2,
          backgroundColor: accent,
          transform: [{ rotate: angle }],
        }}
      />

      {dot(inset, inset, node, stroke)}
      {dot(inset, inset + span, node, stroke)}
      {dot(inset + span, inset, node, stroke)}
      {dot(inset + span, inset + span, node, stroke)}
      {dot(size / 2, size / 2, node * 1.05, accent)}
    </View>
  );
}
