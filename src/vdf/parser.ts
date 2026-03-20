import type { VdfObject, VdfValue } from './types.js';

/**
 * Recursive descent parser for Valve's text-based VDF (KeyValues) format.
 *
 * Handles:
 *  - Double-quoted strings with backslash escape sequences
 *  - Unquoted tokens (rare, but seen in some files)
 *  - Nested objects delimited by { }
 *  - Duplicate keys (last value wins, matching Steam behaviour)
 *  - Comments starting with //
 */

// ---------------------------------------------------------------------------
// Tokeniser
// ---------------------------------------------------------------------------

const enum TokType {
  String,
  BraceOpen,
  BraceClose,
  EOF,
}

interface Token {
  type: TokType;
  value: string;
}

class Lexer {
  private pos = 0;

  constructor(private readonly src: string) {}

  /** Advance past whitespace and // comments. */
  private skipWhitespaceAndComments(): void {
    const { src } = this;
    while (this.pos < src.length) {
      const ch = src[this.pos];

      // whitespace
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
        this.pos++;
        continue;
      }

      // line comment
      if (ch === '/' && this.pos + 1 < src.length && src[this.pos + 1] === '/') {
        this.pos += 2;
        while (this.pos < src.length && src[this.pos] !== '\n') {
          this.pos++;
        }
        continue;
      }

      break;
    }
  }

  /** Read a double-quoted string, interpreting backslash escapes. */
  private readQuotedString(): string {
    // skip opening quote
    this.pos++;

    const parts: string[] = [];
    const { src } = this;

    while (this.pos < src.length) {
      const ch = src[this.pos];
      if (ch === '"') {
        this.pos++; // skip closing quote
        return parts.join('');
      }
      if (ch === '\\' && this.pos + 1 < src.length) {
        const next = src[this.pos + 1];
        switch (next) {
          case 'n':
            parts.push('\n');
            break;
          case 't':
            parts.push('\t');
            break;
          case '\\':
            parts.push('\\');
            break;
          case '"':
            parts.push('"');
            break;
          default:
            // Keep the backslash for unknown escapes (e.g. paths like C:\\)
            parts.push('\\');
            parts.push(next);
            break;
        }
        this.pos += 2;
        continue;
      }
      parts.push(ch);
      this.pos++;
    }

    // unterminated string – return what we collected
    return parts.join('');
  }

  /** Read an unquoted token (sequence of non-whitespace, non-brace, non-quote chars). */
  private readUnquotedToken(): string {
    const start = this.pos;
    const { src } = this;
    while (this.pos < src.length) {
      const ch = src[this.pos];
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' ||
          ch === '{' || ch === '}' || ch === '"') {
        break;
      }
      this.pos++;
    }
    return src.slice(start, this.pos);
  }

  next(): Token {
    this.skipWhitespaceAndComments();

    if (this.pos >= this.src.length) {
      return { type: TokType.EOF, value: '' };
    }

    const ch = this.src[this.pos];

    if (ch === '{') {
      this.pos++;
      return { type: TokType.BraceOpen, value: '{' };
    }

    if (ch === '}') {
      this.pos++;
      return { type: TokType.BraceClose, value: '}' };
    }

    if (ch === '"') {
      return { type: TokType.String, value: this.readQuotedString() };
    }

    // Unquoted token
    return { type: TokType.String, value: this.readUnquotedToken() };
  }

  /** Peek at the next token type without consuming. */
  peek(): Token {
    const saved = this.pos;
    const tok = this.next();
    this.pos = saved;
    return tok;
  }
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

function parseObject(lex: Lexer): VdfObject {
  const obj: VdfObject = {};

  while (true) {
    const tok = lex.peek();

    if (tok.type === TokType.EOF || tok.type === TokType.BraceClose) {
      break;
    }

    // Expect a key (string token)
    const keyTok = lex.next();
    if (keyTok.type !== TokType.String) {
      // Unexpected token – skip it
      continue;
    }
    const key = keyTok.value;

    // Next is either a value string or an opening brace (nested object)
    const valueTok = lex.peek();

    if (valueTok.type === TokType.BraceOpen) {
      // consume the brace
      lex.next();
      obj[key] = parseObject(lex);
      // consume closing brace
      const closing = lex.next();
      if (closing.type !== TokType.BraceClose) {
        // Missing closing brace – best effort
      }
    } else if (valueTok.type === TokType.String) {
      lex.next(); // consume
      obj[key] = valueTok.value;
    } else {
      // EOF or unexpected – break
      break;
    }
  }

  return obj;
}

/**
 * Parse a VDF (KeyValues) text string into a JavaScript object.
 *
 * @param text - The VDF-formatted text.
 * @returns A VdfObject representing the parsed data.
 */
export function parseVdf(text: string): VdfObject {
  const lex = new Lexer(text);
  return parseObject(lex);
}

// ---------------------------------------------------------------------------
// Serialiser
// ---------------------------------------------------------------------------

function serializeValue(
  key: string,
  value: VdfValue,
  depth: number,
): string {
  const indent = '\t'.repeat(depth);

  if (typeof value === 'string') {
    return `${indent}"${escapeString(key)}"\t\t"${escapeString(value)}"\n`;
  }

  // nested object
  let out = `${indent}"${escapeString(key)}"\n`;
  out += `${indent}{\n`;
  for (const [k, v] of Object.entries(value)) {
    out += serializeValue(k, v, depth + 1);
  }
  out += `${indent}}\n`;
  return out;
}

function escapeString(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t');
}

/**
 * Serialise a VdfObject back to VDF text format.
 *
 * @param obj   - The object to serialise.
 * @param indent - Starting indentation depth (default 0).
 * @returns The VDF-formatted text string.
 */
export function serializeVdf(obj: VdfObject, indent: number = 0): string {
  let out = '';
  for (const [key, value] of Object.entries(obj)) {
    out += serializeValue(key, value, indent);
  }
  return out;
}
