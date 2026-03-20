/**
 * Steam Web API client.
 *
 * API key is read from the STEAM_API_KEY environment variable.
 * Some endpoints (store API) work without a key.
 */

const STEAM_API_BASE = 'https://api.steampowered.com';
const STORE_API_BASE = 'https://store.steampowered.com';

/**
 * Get the Steam Web API key from environment.
 * @throws if STEAM_API_KEY is not set
 */
export function getApiKey(): string {
  const key = process.env.STEAM_API_KEY;
  if (!key) {
    throw new Error(
      'STEAM_API_KEY environment variable is not set. ' +
      'Get your key at https://steamcommunity.com/dev/apikey',
    );
  }
  return key;
}

/** Check if an API key is available without throwing. */
export function hasApiKey(): boolean {
  return !!process.env.STEAM_API_KEY;
}

/**
 * Make a request to the Steam Web API (requires API key).
 */
export async function steamApiRequest<T = unknown>(
  iface: string,
  method: string,
  version: string,
  params: Record<string, string | number> = {},
): Promise<T> {
  const key = getApiKey();
  const url = new URL(`${STEAM_API_BASE}/${iface}/${method}/${version}/`);
  url.searchParams.set('key', key);
  url.searchParams.set('format', 'json');
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, String(v));
  }

  const resp = await fetch(url.toString());
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`Steam API ${resp.status}: ${body.slice(0, 200)}`);
  }
  return (await resp.json()) as T;
}

/**
 * Make a request to the Steam Store API (no API key needed).
 */
export async function storeApiRequest<T = unknown>(
  path: string,
  params: Record<string, string | number> = {},
): Promise<T> {
  const url = new URL(`${STORE_API_BASE}${path}`);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, String(v));
  }

  const resp = await fetch(url.toString());
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`Store API ${resp.status}: ${body.slice(0, 200)}`);
  }
  return (await resp.json()) as T;
}
