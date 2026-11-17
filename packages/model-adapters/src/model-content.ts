import {
  modelContentSchema,
  type ModelContent,
} from '../../contracts/src/model-content.js';

/** Only explicit byte inputs, never remote URLs or provider-owned file references. */
export function validateModelContent(
  value: unknown,
  role: string,
): ModelContent {
  const content = modelContentSchema.parse(value);
  if (typeof content === 'string') return content;
  const images = content.filter((block) => block.type === 'image');
  if (
    (images.length && role !== 'user') ||
    images.length > 10 ||
    images.reduce(
      (size, block) => size + Buffer.from(block.data, 'base64').length,
      0,
    ) >
      8 * 1024 * 1024
  )
    throw new Error('MODEL_CONTENT_LIMIT');
  for (const image of images) {
    const bytes = Buffer.from(image.data, 'base64');
    if (
      bytes.toString('base64') !== image.data ||
      bytes.length > 4 * 1024 * 1024
    )
      throw new Error('MODEL_IMAGE_INVALID');
    const matches =
      image.mediaType === 'image/png'
        ? bytes
            .subarray(0, 8)
            .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        : image.mediaType === 'image/jpeg'
          ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
          : image.mediaType === 'image/gif'
            ? /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('ascii'))
            : bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
              bytes.subarray(8, 12).toString('ascii') === 'WEBP';
    if (!matches) throw new Error('MODEL_IMAGE_INVALID');
  }
  return content;
}

export function serializeModelContent(
  value: unknown,
  role: string,
  protocol: 'chatCompletions' | 'responses' | 'anthropicMessages',
): unknown {
  const content = validateModelContent(value, role);
  if (typeof content === 'string') return content;
  return content.map((block) => {
    if (block.type === 'text')
      return {
        type: protocol === 'responses' ? 'input_text' : 'text',
        text: block.text,
      };
    if (protocol === 'anthropicMessages')
      return {
        type: 'image',
        source: {
          type: 'base64',
          media_type: block.mediaType,
          data: block.data,
        },
      };
    const url = `data:${block.mediaType};base64,${block.data}`;
    return protocol === 'responses'
      ? { type: 'input_image', image_url: url, detail: 'auto' }
      : { type: 'image_url', image_url: { url, detail: 'auto' } };
  });
}

export function modelContentText(content: ModelContent): string {
  return typeof content === 'string'
    ? content
    : content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('\n');
}
