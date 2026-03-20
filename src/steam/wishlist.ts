// ---------------------------------------------------------------------------
// Shared wishlist fetching logic
// ---------------------------------------------------------------------------

export interface WishlistItem {
  appid: number;
  name: string;
  capsule: string;
  review_score: number;
  review_desc: string;
  reviews_total: string;
  reviews_percent: number;
  release_string: string;
  release_date: number;
  priority: number;
  added: number;
  type: string;
  free: boolean;
  is_free_game: boolean;
  subs: Array<{
    id: number;
    discount_block?: string;
    discount_pct: number;
    price: string;
  }>;
}

interface WishlistResponse {
  [appid: string]: Omit<WishlistItem, 'appid'>;
}

interface WishlistErrorResponse {
  success: number;
}

/** Fetch a single wishlist page. Returns null if the page is empty or an error. */
async function fetchWishlistPage(
  steamid: string,
  page: number,
): Promise<WishlistResponse | null> {
  const url = `https://store.steampowered.com/wishlist/profiles/${steamid}/wishlistdata/?p=${page}`;
  const response = await fetch(url);

  if (!response.ok) {
    return null;
  }

  const data = (await response.json()) as WishlistResponse | WishlistErrorResponse;

  // Steam returns { success: 2 } when the wishlist is private or no more pages
  if ('success' in data && (data as WishlistErrorResponse).success === 2) {
    return null;
  }

  // Empty object means no more pages
  if (Object.keys(data).length === 0) {
    return null;
  }

  return data as WishlistResponse;
}

/**
 * Fetch all wishlist pages (0-2) in parallel, merge results, and return
 * a flat array of WishlistItem with the appid populated from the key.
 */
export async function fetchAllWishlistPages(steamid: string): Promise<WishlistItem[]> {
  // Fetch first 3 pages in parallel (covers up to ~300 items)
  const pages = await Promise.all([
    fetchWishlistPage(steamid, 0),
    fetchWishlistPage(steamid, 1),
    fetchWishlistPage(steamid, 2),
  ]);

  // Merge all pages into a single map
  const allItems: Record<string, Omit<WishlistItem, 'appid'>> = {};
  for (const page of pages) {
    if (page) {
      Object.assign(allItems, page);
    }
  }

  // Convert to flat array with appid populated
  return Object.entries(allItems).map(([appidStr, item]) => ({
    ...item,
    appid: Number(appidStr),
  }));
}
