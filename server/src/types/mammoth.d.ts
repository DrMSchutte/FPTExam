// mammoth doesn't ship its own TypeScript types and there's no @types/mammoth
// package on the registry - minimal ambient declaration for the one function
// this codebase actually uses (see integrations/qcto/extractDocumentText.ts).
declare module "mammoth" {
  export interface ExtractRawTextResult {
    value: string;
    messages: unknown[];
  }
  export function extractRawText(input: { buffer: Buffer } | { path: string }): Promise<ExtractRawTextResult>;
  const _default: { extractRawText: typeof extractRawText };
  export default _default;
}
