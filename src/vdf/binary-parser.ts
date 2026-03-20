import type { VdfObject, VdfValue } from './types.js';

/**
 * Parser for Valve's binary VDF format, as used by shortcuts.vdf and
 * similar files.
 *
 * Binary VDF type tags:
 *   0x00  Nested object (sub-dictionary) start
 *   0x01  String value (null-terminated)
 *   0x02  uint32 value (little-endian, 4 bytes)
 *   0x08  End of current object
 *
 * Object keys are always null-terminated unquoted strings.
 * Strings values are null-terminated.
 */

const TYPE_OBJECT = 0x00;
const TYPE_STRING = 0x01;
const TYPE_UINT32 = 0x02;
const TYPE_END = 0x08;

class BinaryReader {
  public offset = 0;

  constructor(private readonly buf: Buffer) {}

  get remaining(): number {
    return this.buf.length - this.offset;
  }

  readByte(): number {
    if (this.offset >= this.buf.length) {
      throw new Error(`Unexpected end of buffer at offset ${this.offset}`);
    }
    return this.buf[this.offset++];
  }

  /** Read a null-terminated UTF-8 string. */
  readNullTermString(): string {
    const start = this.offset;
    while (this.offset < this.buf.length && this.buf[this.offset] !== 0x00) {
      this.offset++;
    }
    const str = this.buf.toString('utf8', start, this.offset);
    // skip the null terminator
    if (this.offset < this.buf.length) {
      this.offset++;
    }
    return str;
  }

  /** Read a little-endian uint32. */
  readUint32LE(): number {
    if (this.offset + 4 > this.buf.length) {
      throw new Error(`Not enough bytes for uint32 at offset ${this.offset}`);
    }
    const val = this.buf.readUInt32LE(this.offset);
    this.offset += 4;
    return val;
  }
}

function readObject(reader: BinaryReader): VdfObject {
  const obj: VdfObject = {};

  while (reader.remaining > 0) {
    const typeByte = reader.readByte();

    if (typeByte === TYPE_END) {
      return obj;
    }

    const key = reader.readNullTermString();

    let value: VdfValue;

    switch (typeByte) {
      case TYPE_OBJECT:
        value = readObject(reader);
        break;

      case TYPE_STRING:
        value = reader.readNullTermString();
        break;

      case TYPE_UINT32:
        value = String(reader.readUint32LE());
        break;

      default:
        throw new Error(
          `Unknown binary VDF type 0x${typeByte.toString(16).padStart(2, '0')} at offset ${reader.offset - 1}`,
        );
    }

    // Duplicate keys: last value wins (consistent with text parser)
    obj[key] = value;
  }

  return obj;
}

/**
 * Parse a binary VDF buffer into a JavaScript object.
 *
 * @param buffer - The raw binary VDF data.
 * @returns A VdfObject representing the parsed data.
 */
export function parseBinaryVdf(buffer: Buffer): VdfObject {
  if (buffer.length === 0) {
    return {};
  }

  const reader = new BinaryReader(buffer);
  return readObject(reader);
}
