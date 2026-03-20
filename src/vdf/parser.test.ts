import { describe, it, expect } from 'vitest';
import { parseVdf, serializeVdf } from './parser.js';
import { parseBinaryVdf } from './binary-parser.js';
import type { VdfObject } from './types.js';

// ---------------------------------------------------------------------------
// Text VDF parser
// ---------------------------------------------------------------------------

describe('parseVdf', () => {
  it('parses a basic key-value pair', () => {
    const input = `"key"\t\t"value"`;
    expect(parseVdf(input)).toEqual({ key: 'value' });
  });

  it('parses multiple key-value pairs', () => {
    const input = `
      "a"   "1"
      "b"   "2"
      "c"   "3"
    `;
    expect(parseVdf(input)).toEqual({ a: '1', b: '2', c: '3' });
  });

  it('parses nested objects', () => {
    const input = `
"outer"
{
  "inner"
  {
    "key"   "val"
  }
}
    `;
    expect(parseVdf(input)).toEqual({
      outer: {
        inner: {
          key: 'val',
        },
      },
    });
  });

  it('parses empty objects', () => {
    const input = `"SharedDepots" {}`;
    expect(parseVdf(input)).toEqual({
      SharedDepots: {},
    });
  });

  it('handles duplicate keys (last value wins)', () => {
    const input = `
      "key" "first"
      "key" "second"
    `;
    expect(parseVdf(input)).toEqual({ key: 'second' });
  });

  it('handles escape sequences in quoted strings', () => {
    const input = `"path"\t\t"C:\\\\Program Files\\\\Steam"`;
    expect(parseVdf(input)).toEqual({ path: 'C:\\Program Files\\Steam' });
  });

  it('handles escaped quotes', () => {
    const input = `"msg"\t\t"He said \\"hello\\""`;
    expect(parseVdf(input)).toEqual({ msg: 'He said "hello"' });
  });

  it('handles newline and tab escapes', () => {
    const input = `"text"\t\t"line1\\nline2\\ttab"`;
    expect(parseVdf(input)).toEqual({ text: 'line1\nline2\ttab' });
  });

  it('skips line comments', () => {
    const input = `
// This is a comment
"key"   "value"
// Another comment
    `;
    expect(parseVdf(input)).toEqual({ key: 'value' });
  });

  it('handles unquoted tokens', () => {
    const input = `key value`;
    expect(parseVdf(input)).toEqual({ key: 'value' });
  });

  it('parses a real appmanifest format', () => {
    const input = `"AppState"
{
\t"appid"\t\t"365360"
\t"universe"\t\t"1"
\t"name"\t\t"Battle Brothers"
\t"StateFlags"\t\t"4"
\t"installdir"\t\t"Battle Brothers"
\t"LastUpdated"\t\t"1710000000"
\t"SizeOnDisk"\t\t"1384416810"
\t"StagingSize"\t\t"0"
\t"buildid"\t\t"12345678"
\t"LastOwner"\t\t"76561198012345678"
\t"UpdateResult"\t\t"0"
\t"BytesToDownload"\t\t"0"
\t"BytesDownloaded"\t\t"0"
\t"BytesToStage"\t\t"0"
\t"BytesStaged"\t\t"0"
\t"AutoUpdateBehavior"\t\t"0"
\t"InstalledDepots"
\t{
\t\t"365361"
\t\t{
\t\t\t"manifest"\t\t"4185531896397071155"
\t\t\t"size"\t\t"1384416810"
\t\t}
\t}
\t"SharedDepots"\t\t{}
\t"UserConfig"
\t{
\t\t"language"\t\t"english"
\t}
}`;
    const result = parseVdf(input);
    expect(result).toHaveProperty('AppState');

    const appState = result['AppState'] as VdfObject;
    expect(appState['appid']).toBe('365360');
    expect(appState['name']).toBe('Battle Brothers');
    expect(appState['installdir']).toBe('Battle Brothers');
    expect(appState['SizeOnDisk']).toBe('1384416810');

    const depots = appState['InstalledDepots'] as VdfObject;
    const depot = depots['365361'] as VdfObject;
    expect(depot['manifest']).toBe('4185531896397071155');
    expect(depot['size']).toBe('1384416810');

    expect(appState['SharedDepots']).toEqual({});

    const userConfig = appState['UserConfig'] as VdfObject;
    expect(userConfig['language']).toBe('english');
  });

  it('parses a real libraryfolders format', () => {
    const input = `"libraryfolders"
{
\t"0"
\t{
\t\t"path"\t\t"/home/user/.local/share/Steam"
\t\t"label"\t\t""
\t\t"contentid"\t\t"123456789"
\t\t"totalsize"\t\t"0"
\t\t"update_clean_bytes_tally"\t\t"0"
\t\t"time_last_update_corruption"\t\t"0"
\t\t"apps"
\t\t{
\t\t\t"228980"\t\t"0"
\t\t\t"365360"\t\t"1384416810"
\t\t}
\t}
\t"1"
\t{
\t\t"path"\t\t"/mnt/games/SteamLibrary"
\t\t"label"\t\t""
\t\t"contentid"\t\t"987654321"
\t\t"totalsize"\t\t"500107862016"
\t\t"apps"
\t\t{
\t\t\t"570"\t\t"25614014003"
\t\t}
\t}
}`;
    const result = parseVdf(input);
    expect(result).toHaveProperty('libraryfolders');

    const folders = result['libraryfolders'] as VdfObject;
    const folder0 = folders['0'] as VdfObject;
    expect(folder0['path']).toBe('/home/user/.local/share/Steam');

    const apps0 = folder0['apps'] as VdfObject;
    expect(apps0['365360']).toBe('1384416810');

    const folder1 = folders['1'] as VdfObject;
    expect(folder1['path']).toBe('/mnt/games/SteamLibrary');
    expect(folder1['totalsize']).toBe('500107862016');

    const apps1 = folder1['apps'] as VdfObject;
    expect(apps1['570']).toBe('25614014003');
  });

  it('handles empty input', () => {
    expect(parseVdf('')).toEqual({});
  });

  it('handles whitespace-only input', () => {
    expect(parseVdf('   \n\t\n  ')).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// VDF serialiser
// ---------------------------------------------------------------------------

describe('serializeVdf', () => {
  it('serialises basic key-value pairs', () => {
    const obj: VdfObject = { appid: '365360', name: 'Test Game' };
    const output = serializeVdf(obj);
    expect(output).toContain('"appid"');
    expect(output).toContain('"365360"');
    expect(output).toContain('"name"');
    expect(output).toContain('"Test Game"');
  });

  it('serialises nested objects with braces', () => {
    const obj: VdfObject = {
      AppState: {
        appid: '123',
        InstalledDepots: {
          '456': {
            manifest: '789',
          },
        },
      },
    };
    const output = serializeVdf(obj);
    expect(output).toContain('"AppState"');
    expect(output).toContain('{');
    expect(output).toContain('}');
    expect(output).toContain('"InstalledDepots"');
    expect(output).toContain('"456"');
    expect(output).toContain('"manifest"\t\t"789"');
  });

  it('escapes special characters in strings', () => {
    const obj: VdfObject = {
      path: 'C:\\Program Files\\Steam',
      msg: 'say "hi"',
    };
    const output = serializeVdf(obj);
    expect(output).toContain('C:\\\\Program Files\\\\Steam');
    expect(output).toContain('say \\"hi\\"');
  });

  it('serialises empty objects', () => {
    const obj: VdfObject = { SharedDepots: {} };
    const output = serializeVdf(obj);
    expect(output).toContain('"SharedDepots"');
    expect(output).toContain('{\n}');
  });

  it('respects indent parameter', () => {
    const obj: VdfObject = { key: 'val' };
    const output = serializeVdf(obj, 2);
    expect(output).toMatch(/^\t\t"key"/);
  });

  it('round-trips a parsed VDF document', () => {
    const original = `"AppState"
{
\t"appid"\t\t"365360"
\t"name"\t\t"Battle Brothers"
\t"UserConfig"
\t{
\t\t"language"\t\t"english"
\t}
}
`;
    const parsed = parseVdf(original);
    const serialised = serializeVdf(parsed);
    const reparsed = parseVdf(serialised);
    expect(reparsed).toEqual(parsed);
  });
});

// ---------------------------------------------------------------------------
// Binary VDF parser
// ---------------------------------------------------------------------------

describe('parseBinaryVdf', () => {
  /** Helper: build a buffer from a sequence of bytes / strings. */
  function buildBuffer(parts: Array<number | string | number[]>): Buffer {
    const chunks: Buffer[] = [];
    for (const part of parts) {
      if (typeof part === 'number') {
        chunks.push(Buffer.from([part]));
      } else if (typeof part === 'string') {
        // Null-terminated string
        chunks.push(Buffer.from(part, 'utf8'));
        chunks.push(Buffer.from([0x00]));
      } else {
        // number array
        chunks.push(Buffer.from(part));
      }
    }
    return Buffer.concat(chunks);
  }

  /** Helper: write a uint32 LE as 4-byte array. */
  function uint32LE(n: number): number[] {
    const buf = Buffer.alloc(4);
    buf.writeUInt32LE(n, 0);
    return [...buf];
  }

  it('parses an empty buffer', () => {
    expect(parseBinaryVdf(Buffer.alloc(0))).toEqual({});
  });

  it('parses a single string value', () => {
    // TYPE_STRING, key, value, TYPE_END
    const buf = buildBuffer([
      0x01, 'name', 'Test Game',
      0x08,
    ]);
    expect(parseBinaryVdf(buf)).toEqual({ name: 'Test Game' });
  });

  it('parses a uint32 value', () => {
    const buf = buildBuffer([
      0x02, 'appid', uint32LE(365360),
      0x08,
    ]);
    expect(parseBinaryVdf(buf)).toEqual({ appid: '365360' });
  });

  it('parses nested objects', () => {
    // { "0": { "AppName": "My Game" } }
    const buf = buildBuffer([
      0x00, '0',                          // nested object "0"
        0x01, 'AppName', 'My Game',       //   string "AppName" = "My Game"
      0x08,                               // end of "0"
      0x08,                               // end of root
    ]);
    const result = parseBinaryVdf(buf);
    expect(result).toEqual({
      '0': {
        AppName: 'My Game',
      },
    });
  });

  it('parses multiple values and nested objects', () => {
    const buf = buildBuffer([
      0x00, 'shortcuts',                          // nested "shortcuts"
        0x00, '0',                                // nested "0"
          0x01, 'AppName', 'Heroic Game',         //   string
          0x02, 'appid', uint32LE(2000000000),    //   uint32
          0x01, 'exe', '/usr/bin/heroic',         //   string
        0x08,                                     // end "0"
        0x00, '1',                                // nested "1"
          0x01, 'AppName', 'Lutris Game',         //   string
          0x02, 'appid', uint32LE(2000000001),    //   uint32
        0x08,                                     // end "1"
      0x08,                                       // end "shortcuts"
      0x08,                                       // end root
    ]);
    const result = parseBinaryVdf(buf);
    const shortcuts = result['shortcuts'] as VdfObject;
    expect(shortcuts).toBeDefined();

    const entry0 = shortcuts['0'] as VdfObject;
    expect(entry0['AppName']).toBe('Heroic Game');
    expect(entry0['appid']).toBe('2000000000');
    expect(entry0['exe']).toBe('/usr/bin/heroic');

    const entry1 = shortcuts['1'] as VdfObject;
    expect(entry1['AppName']).toBe('Lutris Game');
    expect(entry1['appid']).toBe('2000000001');
  });

  it('handles duplicate keys (last value wins)', () => {
    const buf = buildBuffer([
      0x01, 'key', 'first',
      0x01, 'key', 'second',
      0x08,
    ]);
    expect(parseBinaryVdf(buf)).toEqual({ key: 'second' });
  });

  it('parses uint32 zero', () => {
    const buf = buildBuffer([
      0x02, 'count', uint32LE(0),
      0x08,
    ]);
    expect(parseBinaryVdf(buf)).toEqual({ count: '0' });
  });

  it('parses uint32 max value', () => {
    const buf = buildBuffer([
      0x02, 'max', uint32LE(0xFFFFFFFF),
      0x08,
    ]);
    expect(parseBinaryVdf(buf)).toEqual({ max: '4294967295' });
  });
});
