import type { VdfObject, VdfValue } from './types.js';

/**
 * Serializer for Valve's binary VDF format, producing output compatible
 * with {@link parseBinaryVdf} from `./binary-parser.ts`.
 *
 * Binary VDF type tags:
 *   0x00  Nested object (sub-dictionary) start
 *   0x01  String value (null-terminated)
 *   0x02  uint32 value (little-endian, 4 bytes)
 *   0x08  End of current object
 *
 * Object keys are always null-terminated unquoted strings.
 */

const TYPE_OBJECT = 0x00;
const TYPE_STRING = 0x01;
const TYPE_UINT32 = 0x02;
const TYPE_END = 0x08;

function writeObject(parts: Buffer[], obj: VdfObject): void {
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'object' && value !== null) {
      // Nested object
      parts.push(Buffer.from([TYPE_OBJECT]));
      parts.push(Buffer.from(key + '\0', 'utf-8'));
      writeObject(parts, value as VdfObject);
      parts.push(Buffer.from([TYPE_END]));
    } else {
      const strValue = String(value);
      // Detect if the value should be written as a uint32.
      // The parser reads uint32 values and converts them to strings via
      // String(reader.readUint32LE()), so a round-trippable value is a
      // non-negative integer string that fits in 32 bits.
      const num = Number(strValue);
      if (
        Number.isInteger(num) &&
        num >= 0 &&
        num <= 0xffffffff &&
        /^\d+$/.test(strValue)
      ) {
        // Write as uint32
        parts.push(Buffer.from([TYPE_UINT32]));
        parts.push(Buffer.from(key + '\0', 'utf-8'));
        const buf = Buffer.alloc(4);
        buf.writeUInt32LE(num);
        parts.push(buf);
      } else {
        // Write as string
        parts.push(Buffer.from([TYPE_STRING]));
        parts.push(Buffer.from(key + '\0', 'utf-8'));
        parts.push(Buffer.from(strValue + '\0', 'utf-8'));
      }
    }
  }
}

/**
 * Serialize a VdfObject into a binary VDF buffer.
 *
 * The output is structured so that each top-level key in {@link obj} is
 * emitted as a nested object (0x00 ... 0x08 pair), matching the layout
 * that `parseBinaryVdf` expects — i.e. the root object is read until
 * end-of-buffer, and each top-level entry begins with a TYPE_OBJECT byte.
 *
 * @param obj - The VdfObject to serialize.
 * @returns A Buffer containing the binary VDF data.
 */
export function serializeBinaryVdf(obj: VdfObject): Buffer {
  const parts: Buffer[] = [];

  // The parser's readObject() reads entries until it hits TYPE_END or runs
  // out of data.  At the very top level the parser calls readObject() once
  // without a preceding TYPE_OBJECT byte, so the root entries are emitted
  // directly (not wrapped in 0x00/0x08).  However, each top-level key in
  // shortcuts.vdf *is* a nested object (e.g. "shortcuts"), so writeObject
  // will emit 0x00 for those automatically.
  writeObject(parts, obj);

  // A trailing TYPE_END closes the implicit root object.  The parser treats
  // TYPE_END as "return from readObject", and at the root level it simply
  // returns the accumulated object.  Writing this byte ensures compatibility
  // with Steam's own parser which expects it.
  parts.push(Buffer.from([TYPE_END]));

  return Buffer.concat(parts);
}
