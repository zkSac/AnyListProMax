import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { searchPhotos, searchProductByUpc, splitSize } from '../src/photo-search.js';

const json = (data, ok = true, status = 200) => Promise.resolve({ ok, status, json: async () => data });

function fakeFetch(routes) {
  const calls = [];
  const f = async (url, opts) => {
    calls.push(url);
    for (const [frag, handler] of Object.entries(routes)) {
      if (url.includes(frag)) return handler(url, opts);
    }
    throw new Error('unexpected url ' + url);
  };
  f.calls = calls;
  return f;
}

const OPENVERSE = {
  results: [
    { url: 'https://f/1.jpg', title: 'Tomato', source: 'flickr', license: 'by-sa', license_version: '2.0', creator: 'ann', foreign_landing_url: 'https://flickr/1' },
    { url: 'https://f/2.jpg', title: null, license: 'cc0', creator: null },
    { title: 'no url' },
  ],
};
const OFF_SEARCH = {
  products: [
    { code: '1', product_name: 'Ketchup', brands: 'Heinz, Kraft', quantity: '580 g', image_front_url: 'https://o/1.jpg' },
    { code: '2', product_name: 'No image' },
  ],
};

describe('searchPhotos', () => {
  it('merges stock and product results and drops entries without images', async () => {
    const f = fakeFetch({ 'openverse': () => json(OPENVERSE), 'cgi/search.pl': () => json(OFF_SEARCH) });
    const { results, errors } = await searchPhotos({ query: 'tomato', fetchImpl: f });
    assert.deepEqual(errors, []);
    assert.deepEqual(results.map(r => r.url), ['https://f/1.jpg', 'https://f/2.jpg', 'https://o/1.jpg']);
    assert.equal(results[0].license, 'CC BY-SA 2.0');
    assert.equal(results[1].title, 'tomato');
    assert.equal(results[1].creator, 'unknown');
    assert.equal(results[2].title, 'Heinz Ketchup · 580 g');
  });

  it('puts the exact UPC product photo first', async () => {
    const f = fakeFetch({
      'api/v2/product/5449000000996': () => json({ status: 1, product: { product_name: 'Coca-Cola', brands: 'Coca-Cola SA', quantity: '330 ml', image_front_url: 'https://o/coke.jpg' } }),
      'openverse': () => json(OPENVERSE),
      'cgi/search.pl': () => json(OFF_SEARCH),
    });
    const { results } = await searchPhotos({ upc: '5449-0000-00996', query: 'coke', fetchImpl: f });
    assert.equal(results[0].url, 'https://o/coke.jpg');
    assert.equal(results[0].title, 'Coca-Cola SA Coca-Cola · 330 ml');
    assert.ok(f.calls[0].includes('5449000000996'));
  });

  it('tolerates a failing source and reports it', async () => {
    const f = fakeFetch({
      'openverse': () => json({}, false, 503),
      'cgi/search.pl': () => json(OFF_SEARCH),
    });
    const { results, errors } = await searchPhotos({ query: 'x', fetchImpl: f });
    assert.equal(results.length, 1);
    assert.deepEqual(errors, ['openverse: HTTP 503']);
  });

  it('returns nothing (no requests) without query or upc', async () => {
    const f = fakeFetch({});
    assert.deepEqual(await searchPhotos({ fetchImpl: f }), { results: [], errors: [] });
    assert.equal(f.calls.length, 0);
  });

  it('clamps limit and url-encodes the query', async () => {
    const f = fakeFetch({ 'openverse': () => json({ results: [] }), 'cgi/search.pl': () => json({ products: [] }) });
    await searchPhotos({ query: 'a b&c', limit: 999, fetchImpl: f });
    assert.ok(f.calls[0].includes('q=a%20b%26c'));
    assert.ok(f.calls[0].includes('page_size=10'));
  });

  it('dedupes identical urls', async () => {
    const f = fakeFetch({
      'openverse': () => json({ results: [{ url: 'https://same/1.jpg', title: 'a' }] }),
      'cgi/search.pl': () => json({ products: [{ code: '1', image_front_url: 'https://same/1.jpg' }] }),
    });
    const { results } = await searchPhotos({ query: 'x', fetchImpl: f });
    assert.equal(results.length, 1);
  });

  it('unknown UPC yields no product', async () => {
    const f = fakeFetch({ 'api/v2/product': () => json({ status: 0 }) });
    assert.deepEqual(await searchProductByUpc('123', f), []);
    assert.deepEqual(await searchProductByUpc('abc', f), []);
  });
});

describe('size-aware search', () => {
  it('splitSize separates the size from the search terms', () => {
    assert.deepEqual(splitSize('kroger mozzarella cheese 32 oz'), { terms: 'kroger mozzarella cheese', size: '32oz' });
    assert.deepEqual(splitSize('Milk 1.5 L whole'), { terms: 'Milk whole', size: '1.5l' });
    assert.deepEqual(splitSize('coke 12 fl oz'), { terms: 'coke', size: '12floz' });
    assert.deepEqual(splitSize('rice 2 lbs'), { terms: 'rice', size: '2lb' });
    assert.deepEqual(splitSize('tomatoes'), { terms: 'tomatoes', size: null });
    assert.deepEqual(splitSize('Vitamin B12 tablets'), { terms: 'Vitamin B12 tablets', size: null });
  });

  it('searches without the size and ranks matching sizes first', async () => {
    const f = fakeFetch({
      'openverse': () => json({ results: [] }),
      'cgi/search.pl': () => json({ products: [
        { code: '1', brands: 'Kroger', product_name: 'Mozzarella slices', quantity: '21 g', image_front_url: 'https://o/1.jpg' },
        { code: '2', brands: 'Kroger', product_name: 'Mozzarella bar', quantity: '32 oz', image_front_url: 'https://o/2.jpg' },
        { code: '3', brands: 'Kroger', product_name: 'Mozzarella bar', quantity: '8 oz', image_front_url: 'https://o/3.jpg' },
      ] }),
    });
    const { results } = await searchPhotos({ query: 'kroger mozzarella 32 oz', limit: 2, fetchImpl: f });
    assert.equal(results[0].url, 'https://o/2.jpg');
    assert.ok(!decodeURIComponent(f.calls.join(' ')).includes('32 oz'));
  });

  it('retries once on a 5xx and then succeeds', async () => {
    let n = 0;
    const f = fakeFetch({
      'openverse': () => json({ results: [] }),
      'cgi/search.pl': () => (++n === 1 ? json({}, false, 503) : json(OFF_SEARCH)),
    });
    const { results, errors } = await searchPhotos({ query: 'ketchup', fetchImpl: f });
    assert.equal(n, 2);
    assert.deepEqual(errors, []);
    assert.equal(results.length, 1);
  });
});
