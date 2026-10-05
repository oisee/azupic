import http from 'node:http';

export function streamFromText(text, chunkSizes = [7, 13, 5, 29]) {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      const size = chunkSizes[index++ % chunkSizes.length];
      controller.enqueue(bytes.slice(offset, Math.min(bytes.length, offset + size)));
      offset += size;
    },
  });
}

export async function collect(iterable) {
  const out = [];
  for await (const item of iterable) out.push(item);
  return out;
}

export async function startHttpServer(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  return {
    server,
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

export async function readRequestJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

