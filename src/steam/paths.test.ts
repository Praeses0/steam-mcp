import { describe, it, expect } from 'vitest';
import { selectUserEntry } from './paths.js';
import { parseVdf } from '../vdf/parser.js';
import type { VdfObject } from '../vdf/types.js';

describe('selectUserEntry', () => {
  it('prefers MostRecent=1 over a newer Timestamp', () => {
    const users: VdfObject = {
      '76561198000000001': { MostRecent: '1', Timestamp: '1000000000' },
      '76561198000000002': { Timestamp: '1700000000' },
    };
    expect(selectUserEntry(users)?.[0]).toBe('76561198000000001');
  });

  it('falls back to the newest Timestamp when MostRecent is missing', () => {
    const parsed = parseVdf(`
"users"
{
	"76561198000000001"
	{
		"AccountName"		"someuser"
		"RememberPassword"		"1"
		"Timestamp"		"1700000000"
	}
	"76561198000000002"
	{
		"AccountName"		"otheruser"
		"AutoLogin"		"1"
		"Timestamp"		"1791523691"
	}
}`);
    const selected = selectUserEntry(parsed['users'] as VdfObject);
    expect(selected?.[0]).toBe('76561198000000002');
    expect(selected?.[1]['AccountName']).toBe('otheruser');
  });

  it('accepts lowercase mostrecent and timestamp keys', () => {
    expect(
      selectUserEntry({
        '76561198000000001': { mostrecent: '1', timestamp: '1000000000' },
        '76561198000000002': { timestamp: '1700000000' },
      })?.[0],
    ).toBe('76561198000000001');
    expect(
      selectUserEntry({
        '76561198000000001': { timestamp: '1000000000' },
        '76561198000000002': { timestamp: '1700000000' },
      })?.[0],
    ).toBe('76561198000000002');
  });

  it('uses the only entry when it has neither MostRecent nor Timestamp', () => {
    const users: VdfObject = { '76561198000000001': { AccountName: 'someuser' } };
    expect(selectUserEntry(users)?.[0]).toBe('76561198000000001');
  });

  it('returns undefined when several entries lack MostRecent and a valid Timestamp', () => {
    const users: VdfObject = {
      '76561198000000001': { Timestamp: 'not-a-number' },
      '76561198000000002': { AccountName: 'otheruser' },
    };
    expect(selectUserEntry(users)).toBeUndefined();
  });
});
