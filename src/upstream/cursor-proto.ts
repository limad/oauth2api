// Minimal protobuf / Connect-RPC helpers shared by the Cursor upstreams.

export function encodeVarint(value: number): Uint8Array {
  const bytes: number[] = [];
  let next = Math.max(0, Math.floor(value));
  while (next >= 0x80) {
    bytes.push((next % 0x80) | 0x80);
    next = Math.floor(next / 0x80);
  }
  bytes.push(next);
  return Uint8Array.from(bytes);
}

export function concatBytes(parts: ArrayLike<number>[]): Uint8Array {
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function encodeVarintField(field: number, value: number): Uint8Array {
  return concatBytes([encodeVarint((field << 3) | 0), encodeVarint(value)]);
}

export function encodeBytesField(
  field: number,
  value: Uint8Array | string,
): Uint8Array {
  const payload =
    typeof value === "string" ? new TextEncoder().encode(value) : value;
  return concatBytes([
    encodeVarint((field << 3) | 2),
    encodeVarint(payload.length),
    payload,
  ]);
}

export function connectFrame(payload: Uint8Array): Uint8Array {
  const frame = new Uint8Array(5 + payload.length);
  frame[0] = 0;
  new DataView(frame.buffer).setUint32(1, payload.length, false);
  frame.set(payload, 5);
  return frame;
}

export function decodeVarint(data: Uint8Array, pos: number): [number, number] {
  // Multiply instead of shifting so ids above 2^31 stay positive and exact.
  let value = 0;
  let scale = 1;
  while (pos < data.length) {
    const b = data[pos++];
    value += (b & 0x7f) * scale;
    if ((b & 0x80) === 0) break;
    scale *= 128;
  }
  return [value, pos];
}

export interface ProtoFieldRaw {
  field: number;
  wireType: number;
  bytes?: Uint8Array;
  varint?: number;
}

export function parseFields(data: Uint8Array): ProtoFieldRaw[] {
  const out: ProtoFieldRaw[] = [];
  let pos = 0;
  while (pos < data.length) {
    const [tag, afterTag] = decodeVarint(data, pos);
    if (afterTag <= pos) break;
    pos = afterTag;
    const field = tag >> 3;
    const wireType = tag & 7;
    if (wireType === 0) {
      const [v, p] = decodeVarint(data, pos);
      out.push({ field, wireType, varint: v });
      pos = p;
    } else if (wireType === 2) {
      const [len, afterLen] = decodeVarint(data, pos);
      pos = afterLen;
      if (len < 0 || pos + len > data.length) break;
      out.push({ field, wireType, bytes: data.slice(pos, pos + len) });
      pos += len;
    } else if (wireType === 1) {
      pos += 8;
    } else if (wireType === 5) {
      pos += 4;
    } else {
      break;
    }
  }
  return out;
}

export function getFieldBytes(
  fields: ProtoFieldRaw[],
  field: number,
): Uint8Array | undefined {
  return fields.find((f) => f.field === field && f.wireType === 2)?.bytes;
}

/** Readable summary of a Connect end-stream / error JSON payload. */
export function extractJsonError(payload: Uint8Array): string | undefined {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(payload));
    const code = parsed?.error?.code;
    const message = parsed?.error?.message;
    if (code || message) {
      const debug = parsed?.error?.details?.[0]?.debug?.error;
      const detail = parsed?.error?.details?.[0]?.debug?.details?.detail;
      const parts = [code, debug, message, detail].filter(Boolean);
      return parts.join(" — ");
    }
  } catch {
    /* not JSON */
  }
  return undefined;
}
