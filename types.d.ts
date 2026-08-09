/** Metro/NativeWind resolve the stylesheet; TypeScript just needs to allow it. */
declare module '*.css';

/**
 * mammoth ships no types for its browser bundle. Only the one call Notomi makes
 * is declared, so a typo in the call site is still caught.
 */
declare module 'mammoth/mammoth.browser' {
  export function extractRawText(input: {
    arrayBuffer: ArrayBuffer;
  }): Promise<{ value: string; messages: unknown[] }>;

  const mammoth: { extractRawText: typeof extractRawText };
  export default mammoth;
}
