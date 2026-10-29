import { MAX_INPUT_BYTES } from './jobLimits';

export async function readLimitedText(body: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!body) return '';
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) return text + decoder.decode();
    bytes += value.byteLength;
    if (bytes > MAX_INPUT_BYTES) {
      await reader.cancel();
      throw new Error('Input exceeds 64 KiB.');
    }
    text += decoder.decode(value, { stream: true });
  }
}
