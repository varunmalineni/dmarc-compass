// Reads a large JSON array one element at a time, so a list of a million reports
// never has to exist in memory as one string or one array. Only elements that
// are objects are produced (that is all the report lists contain).

export async function* streamObjects<T>(body: ReadableStream<Uint8Array>): AsyncGenerator<T> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let depth = 0;
  let inString = false;
  let escaped = false;
  let pending: string[] = []; // pieces of the object being read, when it spans chunks

  try {
    for (;;) {
      const { done, value } = await reader.read();
      const text = done ? decoder.decode() : decoder.decode(value, { stream: true });
      let segment = depth >= 2 ? 0 : -1; // where the current object's text starts in this chunk

      for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i);
        if (inString) {
          if (escaped) escaped = false;
          else if (c === 92) escaped = true;
          else if (c === 34) inString = false;
          continue;
        }
        if (c === 34) inString = true;
        else if (c === 123 || c === 91) {
          depth++;
          if (depth === 2 && c === 123) segment = i;
        } else if (c === 125 || c === 93) {
          if (depth === 2 && c === 125) {
            const json = pending.length ? pending.join("") + text.slice(0, i + 1) : text.slice(segment, i + 1);
            pending = [];
            segment = -1;
            yield JSON.parse(json) as T;
          }
          depth--;
        }
      }

      if (depth >= 2 && segment >= 0) pending.push(text.slice(segment));
      if (done) break;
    }
  } finally {
    reader.releaseLock();
  }
}
