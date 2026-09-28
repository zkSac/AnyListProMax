const UA = "AnyListProMax/1.0 (+https://github.com/zkSac/AnyListProMax)";
const TIMEOUT_MS = 10000;

async function getJson(url, fetchImpl) {
  const res = await fetchImpl(url, {
    headers: { "User-Agent": UA, Accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function offCandidate(p) {
  const url = p.image_front_url || p.image_url;
  if (!url) return null;
  const name = [p.brands?.split(",")[0]?.trim(), p.product_name].filter(Boolean).join(" ");
  return {
    url,
    title: [name || p.code, p.quantity].filter(Boolean).join(" · "),
    source: "openfoodfacts",
    license: "CC-BY-SA",
    creator: "Open Food Facts contributors",
    upc: p.code,
  };
}

export async function searchProductByUpc(upc, fetchImpl = fetch) {
  const code = String(upc).replace(/\D/g, "");
  if (!code) return [];
  const d = await getJson(
    `https://world.openfoodfacts.org/api/v2/product/${code}.json?fields=code,product_name,brands,quantity,image_front_url`,
    fetchImpl,
  );
  if (d.status !== 1 || !d.product) return [];
  const c = offCandidate({ code, ...d.product });
  return c ? [c] : [];
}

export async function searchProducts(query, limit, fetchImpl = fetch) {
  const q = encodeURIComponent(query);
  const d = await getJson(
    `https://world.openfoodfacts.org/cgi/search.pl?search_terms=${q}&search_simple=1&action=process&json=1&page_size=${limit * 2}&fields=code,product_name,brands,quantity,image_front_url`,
    fetchImpl,
  );
  return (d.products || []).map(offCandidate).filter(Boolean).slice(0, limit);
}

export async function searchStock(query, limit, fetchImpl = fetch) {
  const q = encodeURIComponent(query);
  const d = await getJson(
    `https://api.openverse.org/v1/images/?q=${q}&page_size=${limit}&mature=false&license_type=commercial&category=photograph`,
    fetchImpl,
  );
  return (d.results || []).map(r => ({
    url: r.url,
    title: r.title || query,
    source: r.source || "openverse",
    license: r.license ? `CC ${r.license.toUpperCase()}${r.license_version ? " " + r.license_version : ""}` : "unknown",
    creator: r.creator || "unknown",
    page: r.foreign_landing_url,
  })).filter(c => c.url);
}

/**
 * Find candidate photos for a grocery item.
 * - upc: exact product photo from Open Food Facts (listed first).
 * - query: stock photos (Openverse, CC-licensed) and packaged-product photos (Open Food Facts).
 * A source that fails or times out is skipped; errors are returned in `errors`.
 */
export async function searchPhotos({ query, upc, limit = 3, fetchImpl = fetch } = {}) {
  const n = Math.min(Math.max(Number(limit) || 3, 1), 10);
  const jobs = [];
  if (upc) jobs.push(["openfoodfacts (upc)", searchProductByUpc(upc, fetchImpl)]);
  if (query) {
    jobs.push(["openverse", searchStock(query, n, fetchImpl)]);
    jobs.push(["openfoodfacts", searchProducts(query, n, fetchImpl)]);
  }
  const settled = await Promise.allSettled(jobs.map(j => j[1]));
  const results = [];
  const errors = [];
  const seen = new Set();
  settled.forEach((s, i) => {
    if (s.status === "rejected") {
      errors.push(`${jobs[i][0]}: ${s.reason?.message || s.reason}`);
      return;
    }
    for (const c of s.value) {
      if (!seen.has(c.url)) { seen.add(c.url); results.push(c); }
    }
  });
  return { results, errors };
}
