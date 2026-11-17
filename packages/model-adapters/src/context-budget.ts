import { createHash } from 'node:crypto';
import { getEncoding } from 'js-tiktoken';

export const modelBudgetProfileVersion =
  'ath-envelope-v3-chunks16-cl100k-o200k-image32-pngframes-cold1.5';
export interface ModelBudgetEstimate {
  fits: boolean;
  inputTokensEstimate: number;
  rawInputTokens: number;
  contextLimit: number | null;
  maxOutput: number;
  safetyMargin: number;
  exact: false;
  profileVersion: string;
  calibrationFactor: number;
  schemaHash: string;
  envelopeHash: string;
  components: {
    textTokens: number;
    imageTokens: number;
    opaqueTokens: number;
    imageCount: number;
    serializedCharacters: number;
    toolsSerializedCharacters: number;
    messagesSerializedCharacters: number;
    systemSerializedCharacters: number;
  };
}

/** Process-local state. The trusted factory isolates owner/service/model/revision;
 * this object further isolates protocol/schema/profile. Usage only raises it. */
export class ModelBudgetCalibration {
  readonly #factors = new Map<string, number>();
  factor(schemaHash: string): number {
    return this.#factors.get(schemaHash) ?? 1.5;
  }
  observe(estimate: ModelBudgetEstimate, reportedInputTokens: string | null) {
    if (
      estimate.profileVersion !== modelBudgetProfileVersion ||
      !reportedInputTokens ||
      !/^\d+$/.test(reportedInputTokens) ||
      estimate.rawInputTokens < 1
    )
      return;
    const actual = Number(reportedInputTokens);
    if (!Number.isSafeInteger(actual) || actual < 0) return;
    const current = this.factor(estimate.schemaHash);
    if (actual > estimate.rawInputTokens * current)
      this.#factors.set(
        estimate.schemaHash,
        Math.max(current, (actual / estimate.rawInputTokens) * 1.05),
      );
  }
}
export function createModelBudgetCalibration(): ModelBudgetCalibration {
  return new ModelBudgetCalibration();
}

export class ModelImageBudgetError extends Error {
  readonly code = 'IMAGE_BUDGET_UNAVAILABLE';
  constructor() {
    super('Image dimensions cannot be bounded by the current budget policy.');
    this.name = 'ModelImageBudgetError';
  }
}

const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const encoders = () => {
  encoderPair ??= [getEncoding('cl100k_base'), getEncoding('o200k_base')];
  return encoderPair;
};
let encoderPair: ReturnType<typeof getEncoding>[] | undefined;
const tokenCache = new Map<string, readonly number[]>();
function tokens(text: string, cache = false): readonly number[] {
  const key = cache ? createHash('sha256').update(text).digest('hex') : '';
  const existing = key ? tokenCache.get(key) : undefined;
  if (existing) {
    tokenCache.delete(key);
    tokenCache.set(key, existing);
    return existing;
  }
  const counts = encoders().map(
    (encoder) => encoder.encode(text, [], []).length,
  );
  if (key) {
    if (tokenCache.size >= 128) {
      const oldest = tokenCache.keys().next().value;
      if (oldest) tokenCache.delete(oldest);
    }
    tokenCache.set(key, counts);
  }
  return counts;
}

/** Scan framing metadata only; never inflate or change the original pixels. */
function pngFrames(bytes: Buffer, width: number, height: number): number {
  let cursor = 8,
    declaredFrames: number | undefined,
    frames = 0,
    sequence = 0;
  let defaultIncluded = false,
    hasDefaultData = false,
    defaultDataClosed = false,
    frameHasData = false,
    ended = false;
  while (cursor + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(cursor),
      kind = bytes.toString('ascii', cursor + 4, cursor + 8),
      data = cursor + 8;
    // Check remaining bytes before adding an untrusted uint32 chunk length.
    if (length > bytes.length - cursor - 12) throw new ModelImageBudgetError();
    const next = cursor + 12 + length;
    if (
      (cursor === 8 && (kind !== 'IHDR' || length !== 13)) ||
      (cursor !== 8 && kind === 'IHDR')
    )
      throw new ModelImageBudgetError();
    if (kind === 'acTL') {
      if (declaredFrames !== undefined || hasDefaultData || length !== 8)
        throw new ModelImageBudgetError();
      declaredFrames = bytes.readUInt32BE(data);
      if (declaredFrames < 1) throw new ModelImageBudgetError();
    } else if (kind === 'fcTL') {
      if (
        declaredFrames === undefined ||
        length !== 26 ||
        (frames > 0 && !frameHasData) ||
        bytes.readUInt32BE(data) !== sequence++
      )
        throw new ModelImageBudgetError();
      const frameWidth = bytes.readUInt32BE(data + 4),
        frameHeight = bytes.readUInt32BE(data + 8),
        left = bytes.readUInt32BE(data + 12),
        top = bytes.readUInt32BE(data + 16);
      if (
        frameWidth < 1 ||
        frameHeight < 1 ||
        left + frameWidth > width ||
        top + frameHeight > height ||
        (bytes[data + 24] ?? 3) > 2 ||
        (bytes[data + 25] ?? 2) > 1
      )
        throw new ModelImageBudgetError();
      if (frames === 0) {
        defaultIncluded = !hasDefaultData;
        if (
          defaultIncluded &&
          (left !== 0 ||
            top !== 0 ||
            frameWidth !== width ||
            frameHeight !== height)
        )
          throw new ModelImageBudgetError();
      }
      frames++;
      frameHasData = false;
    } else if (kind === 'IDAT') {
      if (
        defaultDataClosed ||
        (frames > 0 && (!defaultIncluded || frames !== 1))
      )
        throw new ModelImageBudgetError();
      hasDefaultData = true;
      if (defaultIncluded && length > 0) frameHasData = true;
    } else if (kind === 'fdAT') {
      if (
        declaredFrames === undefined ||
        !hasDefaultData ||
        frames === 0 ||
        (defaultIncluded && frames === 1) ||
        length < 4 ||
        bytes.readUInt32BE(data) !== sequence++
      )
        throw new ModelImageBudgetError();
      if (length > 4) frameHasData = true;
    } else if (kind === 'IEND') {
      if (length !== 0) throw new ModelImageBudgetError();
      cursor = next;
      ended = true;
      break;
    }
    if (hasDefaultData && kind !== 'IDAT') defaultDataClosed = true;
    cursor = next;
  }
  if (!ended || cursor !== bytes.length || !hasDefaultData)
    throw new ModelImageBudgetError();
  if (declaredFrames === undefined) return 1;
  if (frames !== declaredFrames || !frameHasData)
    throw new ModelImageBudgetError();
  // A standalone default PNG is also transmitted even when it is not animated.
  // Charge the whole canvas per frame rather than assuming provider resizing.
  return frames + (defaultIncluded ? 0 : 1);
}

function imageDimensions(bytes: Buffer, mediaType: string) {
  let width = 0,
    height = 0,
    frames = 1;
  if (
    mediaType === 'image/png' &&
    bytes.length >= 24 &&
    bytes
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    bytes.toString('ascii', 12, 16) === 'IHDR'
  ) {
    width = bytes.readUInt32BE(16);
    height = bytes.readUInt32BE(20);
    frames = pngFrames(bytes, width, height);
  } else if (
    mediaType === 'image/gif' &&
    bytes.length >= 10 &&
    /^GIF8[79]a$/.test(bytes.toString('ascii', 0, 6))
  ) {
    width = bytes.readUInt16LE(6);
    height = bytes.readUInt16LE(8);
    if (bytes.length < 13) throw new ModelImageBudgetError();
    const packed = bytes[10] ?? 0;
    let cursor = 13 + (packed & 128 ? 3 * 2 ** ((packed & 7) + 1) : 0);
    let ended = false;
    frames = 0;
    const skipBlocks = () => {
      for (;;) {
        if (cursor >= bytes.length) throw new ModelImageBudgetError();
        const length = bytes[cursor++] ?? 0;
        if (!length) return;
        if (cursor + length > bytes.length) throw new ModelImageBudgetError();
        cursor += length;
      }
    };
    while (cursor < bytes.length) {
      const marker = bytes[cursor++];
      if (marker === 59) {
        ended = true;
        break;
      }
      if (marker === 33) {
        cursor++; // extension label; all extension payloads are sub-blocks
        skipBlocks();
      } else if (marker === 44 && cursor + 9 <= bytes.length) {
        const left = bytes.readUInt16LE(cursor),
          top = bytes.readUInt16LE(cursor + 2),
          frameWidth = bytes.readUInt16LE(cursor + 4),
          frameHeight = bytes.readUInt16LE(cursor + 6),
          flags = bytes[cursor + 8] ?? 0;
        if (
          frameWidth < 1 ||
          frameHeight < 1 ||
          left + frameWidth > width ||
          top + frameHeight > height
        )
          throw new ModelImageBudgetError();
        cursor += 9 + (flags & 128 ? 3 * 2 ** ((flags & 7) + 1) : 0);
        cursor++; // LZW minimum code size; payload is never decoded
        skipBlocks();
        frames++;
      } else throw new ModelImageBudgetError();
    }
    if (!ended || !frames) throw new ModelImageBudgetError();
  } else if (
    mediaType === 'image/jpeg' &&
    bytes[0] === 255 &&
    bytes[1] === 216
  ) {
    let cursor = 2;
    while (cursor + 4 <= bytes.length) {
      if (bytes[cursor] !== 255) break;
      while (bytes[cursor] === 255) cursor++;
      const marker = bytes[cursor++];
      if (marker === undefined || marker === 217 || marker === 218) break;
      if (marker === 1 || (marker >= 208 && marker <= 215)) continue;
      if (cursor + 2 > bytes.length) break;
      const length = bytes.readUInt16BE(cursor);
      if (length < 2 || cursor + length > bytes.length) break;
      if (
        [
          192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207,
        ].includes(marker) &&
        length >= 8
      ) {
        height = bytes.readUInt16BE(cursor + 3);
        width = bytes.readUInt16BE(cursor + 5);
        break;
      }
      cursor += length;
    }
  } else if (
    mediaType === 'image/webp' &&
    bytes.length >= 25 &&
    bytes.toString('ascii', 0, 4) === 'RIFF' &&
    bytes.toString('ascii', 8, 12) === 'WEBP'
  ) {
    const kind = bytes.toString('ascii', 12, 16);
    if (kind === 'VP8X' && bytes.length >= 30) {
      width = bytes.readUIntLE(24, 3) + 1;
      height = bytes.readUIntLE(27, 3) + 1;
      if ((bytes[20] ?? 0) & 2) {
        let cursor = 12;
        frames = 0;
        while (cursor + 8 <= bytes.length) {
          const chunk = bytes.toString('ascii', cursor, cursor + 4),
            length = bytes.readUInt32LE(cursor + 4);
          if (cursor + 8 + length > bytes.length)
            throw new ModelImageBudgetError();
          if (chunk === 'ANMF') {
            if (length < 16) throw new ModelImageBudgetError();
            frames++;
          }
          cursor += 8 + length + (length % 2);
        }
        if (cursor !== bytes.length || !frames)
          throw new ModelImageBudgetError();
      }
    } else if (kind === 'VP8L' && bytes[20] === 47) {
      const bits = bytes.readUInt32LE(21);
      width = (bits & 0x3fff) + 1;
      height = ((bits >>> 14) & 0x3fff) + 1;
    } else if (
      kind === 'VP8 ' &&
      bytes.length >= 30 &&
      bytes[23] === 157 &&
      bytes[24] === 1 &&
      bytes[25] === 42
    ) {
      width = bytes.readUInt16LE(26) & 0x3fff;
      height = bytes.readUInt16LE(28) & 0x3fff;
    }
  }
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1 ||
    !Number.isSafeInteger(width * height)
  )
    throw new ModelImageBudgetError();
  return { width, height, frames };
}

function imageReserve(mediaType: string, data: string) {
  const bytes = Buffer.from(data, 'base64');
  if (!bytes.length || bytes.toString('base64') !== data)
    throw new ModelImageBudgetError();
  const { width, height, frames } = imageDimensions(bytes, mediaType);
  // A versioned engineering proxy, not a provider-independent upper bound.
  // No resizing is assumed. The common calibration and safety margin still apply.
  // Both patch and tile policies are charged; original pixels stay untouched.
  const reserve =
    frames *
    Math.max(
      1024,
      Math.ceil(width / 32) * Math.ceil(height / 32),
      85 + 170 * Math.ceil(width / 512) * Math.ceil(height / 512),
    );
  if (!Number.isSafeInteger(reserve)) throw new ModelImageBudgetError();
  return reserve;
}
export function hasOpaqueModelOutput(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasOpaqueModelOutput);
  const entry = object(value);
  if (!entry) return false;
  if (
    (entry.role === 'assistant' &&
      typeof entry.reasoning_content === 'string' &&
      entry.reasoning_content.length > 0) ||
    (entry.type === 'reasoning' &&
      typeof entry.encrypted_content === 'string') ||
    entry.type === 'thinking' ||
    entry.type === 'redacted_thinking'
  )
    return true;
  return Object.values(entry).some(hasOpaqueModelOutput);
}
export function opaqueOutputReserve(
  output: unknown,
  reportedOutputTokens: string | null,
  maximumOutput: number,
): number {
  if (!hasOpaqueModelOutput(output)) return 0;
  const known =
    reportedOutputTokens === null ? NaN : Number(reportedOutputTokens);
  return Number.isSafeInteger(known) && known > 0 ? known : maximumOutput;
}

/** Counts semantic wire content only. This never mutates/returns native bodies,
 * image bytes, provider reasoning, credentials or authorization decisions. */
export function estimateModelBudget(
  body: Readonly<Record<string, unknown>>,
  options: {
    protocol: 'chatCompletions' | 'responses' | 'anthropicMessages';
    contextLimit?: number;
    maxOutput: number;
    calibration: ModelBudgetCalibration;
    opaqueTokens: number;
  },
): ModelBudgetEstimate {
  let imageTokens = 0,
    imageCount = 0;
  const sanitize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sanitize);
    const entry = object(value);
    if (!entry) return value;
    let image: { mediaType: string; data: string } | undefined;
    const imageUrl =
      entry.type === 'image_url'
        ? object(entry.image_url)?.url
        : entry.type === 'input_image'
          ? entry.image_url
          : undefined;
    if (typeof imageUrl === 'string') {
      const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,(.+)$/.exec(
        imageUrl,
      );
      if (!match?.[1] || !match[2]) throw new ModelImageBudgetError();
      image = { mediaType: match[1], data: match[2] };
    } else if (entry.type === 'image') {
      const source = object(entry.source);
      if (
        source?.type !== 'base64' ||
        typeof source.media_type !== 'string' ||
        typeof source.data !== 'string'
      )
        throw new ModelImageBudgetError();
      image = { mediaType: source.media_type, data: source.data };
    }
    if (image) {
      imageTokens += imageReserve(image.mediaType, image.data);
      imageCount++;
      return { type: 'image', budget: 'pixels-accounted-separately' };
    }
    return Object.fromEntries(
      Object.entries(entry)
        .filter(
          ([key]) =>
            !(
              (entry.role === 'assistant' && key === 'reasoning_content') ||
              (entry.type === 'reasoning' && key === 'encrypted_content') ||
              ((entry.type === 'thinking' ||
                entry.type === 'redacted_thinking') &&
                ['thinking', 'signature', 'data'].includes(key))
            ),
        )
        .map(([key, child]) => [
          key,
          key === 'tools' || (entry.type === 'tool_use' && key === 'input')
            ? child
            : sanitize(child),
        ]),
    );
  };
  const sanitized = object(sanitize(body));
  if (!sanitized) throw new Error('MODEL_BUDGET_BODY_INVALID');
  const tools = JSON.stringify(sanitized.tools ?? []);
  const schemaHash = createHash('sha256')
    .update(modelBudgetProfileVersion + ':' + options.protocol + ':' + tools)
    .digest('hex');
  const rest = { ...sanitized };
  delete rest.tools;
  delete rest.messages;
  delete rest.input;
  delete rest.system;
  // Exact serialized chunks retain every field while allowing unchanged large
  // messages/schemas to reuse hash-only counts. Structure/BPE boundary reserves
  // are explicit; no provider-exact token count is claimed.
  const chunks = [
    tools,
    JSON.stringify(rest),
    JSON.stringify(sanitized.system ?? ''),
    ...[sanitized.messages, sanitized.input].flatMap((items) =>
      Array.isArray(items) ? items.map((item) => JSON.stringify(item)) : [],
    ),
  ];
  const counts = chunks.map((chunk) => tokens(chunk, true));
  const textTokens =
    Math.max(
      ...encoders().map((_, index) =>
        counts.reduce((sum, count) => sum + (count[index] ?? 0), 0),
      ),
    ) +
    16 * chunks.length;
  const opaqueTokens = options.opaqueTokens;
  const rawInputTokens = textTokens + imageTokens + opaqueTokens;
  const calibrationFactor = options.calibration.factor(schemaHash);
  const inputTokensEstimate = Math.min(
    Number.MAX_SAFE_INTEGER,
    Math.ceil(rawInputTokens * calibrationFactor),
  );
  const contextLimit = options.contextLimit ?? null;
  const safetyMargin = Math.max(2048, Math.ceil((contextLimit ?? 0) * 0.02));
  return {
    fits:
      contextLimit === null ||
      inputTokensEstimate + options.maxOutput + safetyMargin <= contextLimit,
    inputTokensEstimate,
    rawInputTokens,
    contextLimit,
    maxOutput: options.maxOutput,
    safetyMargin,
    exact: false,
    profileVersion: modelBudgetProfileVersion,
    calibrationFactor,
    schemaHash,
    envelopeHash: createHash('sha256')
      .update(JSON.stringify(body))
      .digest('hex'),
    components: {
      textTokens,
      imageTokens,
      opaqueTokens,
      imageCount,
      serializedCharacters: JSON.stringify(body).length,
      toolsSerializedCharacters: tools.length,
      messagesSerializedCharacters: JSON.stringify(
        sanitized.messages ?? sanitized.input ?? [],
      ).length,
      systemSerializedCharacters: JSON.stringify(sanitized.system ?? '').length,
    },
  };
}
