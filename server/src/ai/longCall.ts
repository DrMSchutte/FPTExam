import Anthropic from "@anthropic-ai/sdk";

// One place for the long AI calls (drafting, revising, reading a paper, the
// standard check). They can run for several minutes and produce up to 20k
// tokens, so they are streamed: streaming avoids the SDK's non-streaming time
// limit, and the growing output lets the job report live progress ("about
// 1,400 words written so far") instead of a silent wait.

let client: Anthropic | null = null;
export function getAnthropic(): Anthropic {
  if (!client) {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set.");
    // A single attempt may legitimately take 8-10 minutes; give it room and don't
    // silently retry a call that long - the job reports failure instead.
    client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: 15 * 60 * 1000, maxRetries: 1 });
  }
  return client;
}

export const MODEL = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-5-20250929";

export type ProgressHook = (info: { chars: number; words: number }) => void | Promise<void>;

export async function createLongMessage(
  params: Anthropic.MessageCreateParamsNonStreaming,
  onProgress?: ProgressHook,
  everyMs = 6000
): Promise<Anthropic.Message> {
  const anthropic = getAnthropic();
  // Tool input is what carries the paper, so ask for it to be streamed as it is
  // written rather than buffered until the end - that is what makes the live
  // "words written so far" honest instead of jumping from 0 to done.
  const tools = params.tools?.map((t) => ("input_schema" in t ? { ...t, eager_input_streaming: true } : t));
  const stream = anthropic.beta.messages.stream({
    ...params,
    tools,
    stream: true,
    betas: ["fine-grained-tool-streaming-2025-05-14"],
  } as unknown as Parameters<typeof anthropic.beta.messages.stream>[0]);
  let chars = 0;
  let lastReport = Date.now();
  const report = async () => {
    if (!onProgress) return;
    try {
      await onProgress({ chars, words: Math.round(chars / 6) });
    } catch {
      /* progress is best-effort */
    }
  };
  stream.on("inputJson", (delta) => {
    chars += delta.length;
    if (Date.now() - lastReport > everyMs) {
      lastReport = Date.now();
      void report();
    }
  });
  stream.on("text", (delta) => {
    chars += delta.length;
  });
  const message = await stream.finalMessage();
  await report();
  return message as unknown as Anthropic.Message;
}
