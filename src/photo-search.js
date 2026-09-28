const UA = "AnyListProMax/1.0";
const TIMEOUT_MS = 10000;

async function getJson(url, fetchImpl, retries = 1) {
  const res = await fetchImpl(url, {
    headers: { "User-Agent": UA, Accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status >= 500 && retries > 0) {
    await new Promise(r => setTimeout(r, 500));
    return getJson(url, fetchImpl, retries - 1);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}


// Spanish -> English for common grocery words. Product databases (Open Food Facts US
// brands, Flickr tags) are mostly English, so Spanish queries return nothing or noise.
const ES_EN = {
  arroz: "rice", frijol: "beans", frijoles: "beans", habichuelas: "beans", lenteja: "lentils", lentejas: "lentils",
  garbanzo: "chickpeas", garbanzos: "chickpeas", pasta: "pasta", espagueti: "spaghetti", espaguetis: "spaghetti",
  fideos: "noodles", harina: "flour", azucar: "sugar", sal: "salt", pimienta: "pepper", aceite: "oil",
  vinagre: "vinegar", salsa: "sauce", mayonesa: "mayonnaise", mostaza: "mustard", catsup: "ketchup",
  cereal: "cereal", avena: "oats", pan: "bread", tortilla: "tortilla", tortillas: "tortillas", galleta: "cookies",
  galletas: "cookies", queso: "cheese", leche: "milk", mantequilla: "butter", crema: "cream", yogur: "yogurt",
  huevo: "eggs", huevos: "eggs", pollo: "chicken", carne: "beef", res: "beef", cerdo: "pork",
  jamon: "ham", tocino: "bacon", salchicha: "sausage", salchichas: "sausage", pavo: "turkey", pescado: "fish",
  atun: "tuna", camaron: "shrimp", camarones: "shrimp", tomate: "tomato", tomates: "tomatoes",
  cebolla: "onion", cebollas: "onions", ajo: "garlic", papa: "potato", papas: "potatoes", zanahoria: "carrot",
  zanahorias: "carrots", lechuga: "lettuce", espinaca: "spinach", espinacas: "spinach", brocoli: "broccoli",
  pepino: "cucumber", aguacate: "avocado", aguacates: "avocados", limon: "lemon", limones: "lemons",
  naranja: "orange", naranjas: "oranges", manzana: "apple", manzanas: "apples", platano: "banana",
  platanos: "bananas", fresa: "strawberry", fresas: "strawberries", uva: "grapes", uvas: "grapes",
  sandia: "watermelon", pina: "pineapple", pimiento: "bell pepper", chile: "chili pepper", maiz: "corn",
  elote: "corn", hongos: "mushrooms", champinones: "mushrooms", jugo: "juice", agua: "water",
  refresco: "soda", cafe: "coffee", cerveza: "beer", vino: "wine", papel: "paper", higienico: "toilet",
  servilletas: "napkins", jabon: "soap", champu: "shampoo", detergente: "detergent", panales: "diapers",
  congelado: "frozen", congelados: "frozen", rallado: "shredded", rebanado: "sliced", integral: "whole grain",
  blanco: "white", negro: "black", onzas: "oz", onza: "oz", libras: "lb", libra: "lb", gramos: "g",
  litros: "l", litro: "l", de: "", del: "", la: "", el: "",
};

const stripAccents = w => w.normalize("NFD").replace(/[̀-ͯ]/g, "");

/** Translate known Spanish grocery words to English; unknown words (brands, English) pass through. */
export function translateQuery(query) {
  return String(query || "").split(/\s+/).filter(Boolean).map(w => {
    const key = stripAccents(w.toLowerCase());
    return Object.hasOwn(ES_EN, key) ? ES_EN[key] : w;
  }).filter(Boolean).join(" ").trim();
}

const SIZE_RE = /(\d+(?:[.,]\d+)?)\s*(fl\.?\s*oz|oz|lbs?|kg|g|ml|l|ct)\b\.?/i;
const normSize = (n, u) => `${n.replace(",", ".")}${u.toLowerCase().replace(/[\s.]/g, "").replace("lbs", "lb")}`;

// "kroger mozzarella 32 oz" -> terms "kroger mozzarella", size "32oz".
// Open Food Facts requires every word to match, so the size is used for ranking only.
export function splitSize(query) {
  const m = SIZE_RE.exec(query);
  if (!m) return { terms: query.trim(), size: null };
  return { terms: query.replace(m[0], " ").replace(/\s+/g, " ").trim(), size: normSize(m[1], m[2]) };
}

const titleSize = title => {
  const m = SIZE_RE.exec(title || "");
  return m ? normSize(m[1], m[2]) : null;
};

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
  const usedQuery = translateQuery(query || "");
  const { terms, size } = splitSize(usedQuery);
  if (terms) {
    jobs.push(["openverse", searchStock(terms, n, fetchImpl)]);
    jobs.push(["openfoodfacts", searchProducts(terms, size ? n * 3 : n, fetchImpl)]);
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
  if (size) {
    // stable sort: candidates whose title mentions the requested size go first
    results.sort((a, b) => (titleSize(b.title) === size) - (titleSize(a.title) === size));
  }
  const out = { results, errors };
  if (usedQuery && usedQuery !== (query || "").trim()) out.usedQuery = usedQuery;
  return out;
}
