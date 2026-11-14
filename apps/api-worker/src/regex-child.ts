// Fixed trusted structured-assertion engine; a pattern is data, never evaluated as JS source.
import { z } from 'zod';
const chunks: Buffer[] = [];
let bytes = 0;
for await (const chunk of process.stdin) {
  const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  bytes += data.length;
  if (bytes > 1048576) process.exit(2);
  chunks.push(data);
}
try {
  const input = z
    .strictObject({
      pattern: z.string().max(2000),
      value: z.string().max(524288),
    })
    .parse(JSON.parse(Buffer.concat(chunks).toString()) as unknown);
  process.stdout.write(
    JSON.stringify({
      valid: true,
      passed: new RegExp(input.pattern).test(input.value),
    }),
  );
} catch {
  process.stdout.write(JSON.stringify({ valid: false, passed: false }));
}
