import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { register } from '../../src/tools/shopping.js';
import { MockAnyListClient, createMockServer } from './helpers.js';

describe('shopping tool', () => {
  let client;
  let handlers;
  let searchCalls;
  let searchResult;

  beforeEach(() => {
    searchResult = { results: [
      { url: 'https://img/1.jpg', title: 'Tomato', source: 'flickr', license: 'CC BY 2.0', creator: 'ann' },
      { url: 'https://img/2.jpg', title: 'Tomatoes', source: 'openfoodfacts', license: 'CC-BY-SA', creator: 'OFF' },
    ], errors: [] };
    client = new MockAnyListClient();
    const { server, handlers: h } = createMockServer();
    searchCalls = [];
    register(server, () => Promise.resolve(client), {
      searchPhotos: async (args) => {
        searchCalls.push(args);
        return searchResult;
      },
    });
    handlers = h;
  });

  describe('add_item', () => {
    it('adds an item', async () => {
      const result = await handlers.shopping({ action: 'add_item', name: 'Milk' });
      assert.ok(result.content[0].text.includes('Successfully added "Milk"'));
      assert.equal(client._items.length, 1);
      assert.equal(client._items[0].name, 'Milk');
    });

    it('adds item with quantity and notes', async () => {
      await handlers.shopping({ action: 'add_item', name: 'Eggs', quantity: 2, notes: 'organic' });
      assert.equal(client._items[0].quantity, 2);
      assert.equal(client._items[0].notes, 'organic');
    });

    it('accepts a string quantity with a unit', async () => {
      await handlers.shopping({ action: 'add_item', name: 'Flour', quantity: '500 g' });
      assert.equal(client._items[0].quantity, '500 g');
    });


    it ('should default to "other" category if not provided', async () => {
      await handlers.shopping({ action: 'add_item', name: 'Bread' });
      assert.equal(client._items[0].category, 'other');
    });

    it('should set category when provided', async () => {
      await handlers.shopping({ action: 'add_item', name: 'Bananas', category: 'produce' });
      assert.equal(client._items[0].category, 'produce');
    });

    it('should return error for invalid category', async () => {
      try {
        await handlers.shopping({ action: 'add_item', name: 'Soda', category: 'invalid-category' });
        assert.fail('Expected error for invalid category');
      } catch (e) {
        assert.ok(e.message.includes('Invalid input for field "category"'));
      }
    });
  });

  describe('add_items', () => {
    it('adds multiple items from plain names', async () => {
      const result = await handlers.shopping({ action: 'add_items', items: ['Milk', 'Eggs', 'Bread'] });
      assert.ok(result.content[0].text.includes('Added 3 of 3 items'));
      assert.equal(client._items.length, 3);
      assert.deepEqual(client._items.map(i => i.name), ['Milk', 'Eggs', 'Bread']);
    });

    it('adds items with quantity, notes and category', async () => {
      await handlers.shopping({
        action: 'add_items',
        items: [{ name: 'Eggs', quantity: 2, notes: 'organic', category: 'dairy' }],
      });
      assert.equal(client._items[0].quantity, 2);
      assert.equal(client._items[0].notes, 'organic');
      assert.equal(client._items[0].category, 'dairy');
    });

    it('defaults quantity to 1 and category to other', async () => {
      await handlers.shopping({ action: 'add_items', items: ['Milk'] });
      assert.equal(client._items[0].quantity, 1);
      assert.equal(client._items[0].category, 'other');
    });

    it('mixes plain names and objects', async () => {
      await handlers.shopping({ action: 'add_items', items: ['Milk', { name: 'Eggs', quantity: 12 }] });
      assert.equal(client._items.length, 2);
      assert.equal(client._items[1].quantity, 12);
    });

    it('continues past a failing item and reports it', async () => {
      client.addItem = async (name) => {
        if (name === 'Eggs') throw new Error('boom');
        client._items.push({ name });
      };
      const result = await handlers.shopping({ action: 'add_items', items: ['Milk', 'Eggs', 'Bread'] });
      const text = result.content[0].text;
      assert.equal(result.isError, true);
      assert.ok(text.includes('Added 2 of 3 items'));
      assert.ok(text.includes('✓ Milk'));
      assert.ok(text.includes('✗ Eggs: boom'));
      assert.ok(text.includes('✓ Bread'));
      assert.deepEqual(client._items.map(i => i.name), ['Milk', 'Bread']);
    });

    it('rejects an invalid category without aborting the batch', async () => {
      const result = await handlers.shopping({
        action: 'add_items',
        items: [{ name: 'Soda', category: 'invalid-category' }, 'Milk'],
      });
      assert.equal(result.isError, true);
      assert.ok(result.content[0].text.includes('invalid category "invalid-category"'));
      assert.deepEqual(client._items.map(i => i.name), ['Milk']);
    });

    it('assigns a store to an item', async () => {
      client._stores = [{ name: 'Costco' }];
      await handlers.shopping({ action: 'add_items', items: [{ name: 'Milk', store_name: 'Costco' }] });
      assert.equal(client._items[0].store, 'Costco');
    });

    it('rejects an unknown store without aborting the batch', async () => {
      client._stores = [{ name: 'Costco' }];
      const result = await handlers.shopping({
        action: 'add_items',
        items: [{ name: 'Milk', store_name: 'Nowhere' }, 'Eggs'],
      });
      assert.equal(result.isError, true);
      assert.ok(result.content[0].text.includes('Store "Nowhere" not found'));
      assert.deepEqual(client._items.map(i => i.name), ['Eggs']);
    });

    it('errors on a missing or empty items array', async () => {
      const missing = await handlers.shopping({ action: 'add_items' });
      assert.equal(missing.isError, true);
      assert.ok(missing.content[0].text.includes('non-empty "items" array'));

      const empty = await handlers.shopping({ action: 'add_items', items: [] });
      assert.equal(empty.isError, true);
    });

    it('connects to the list only once for the whole batch', async () => {
      let connects = 0;
      const realConnect = client.connect.bind(client);
      client.connect = async (n) => { connects++; return realConnect(n); };
      await handlers.shopping({ action: 'add_items', items: ['Milk', 'Eggs', 'Bread'] });
      assert.equal(connects, 1);
    });
  });

  describe('check_item', () => {
    it('checks off an existing item', async () => {
      client._items.push({ name: 'Milk', checked: false });
      const result = await handlers.shopping({ action: 'check_item', name: 'Milk' });
      assert.ok(result.content[0].text.includes('Successfully checked off'));
      assert.equal(client._items[0].checked, true);
    });

    it('returns error for non-existent item', async () => {
      const result = await handlers.shopping({ action: 'check_item', name: 'Nonexistent' });
      assert.equal(result.isError, true);
      assert.ok(result.content[0].text.includes('not found'));
    });
  });

  describe('uncheck_item', () => {
    it('unchecks a checked-off item', async () => {
      client._items.push({ name: 'Milk', checked: true });
      const result = await handlers.shopping({ action: 'uncheck_item', name: 'Milk' });
      assert.ok(result.content[0].text.includes('Successfully unchecked'));
      assert.equal(client._items[0].checked, false);
    });

    it('resolves a checked item by partial name', async () => {
      client._items.push({ name: 'Whole Milk', checked: true });
      const result = await handlers.shopping({ action: 'uncheck_item', name: 'milk' });
      assert.ok(result.content[0].text.includes('Successfully unchecked'));
      assert.equal(client._items[0].checked, false);
    });

    it('returns error when no checked item matches', async () => {
      client._items.push({ name: 'Milk', checked: false });
      const result = await handlers.shopping({ action: 'uncheck_item', name: 'Milk' });
      assert.equal(result.isError, true);
      assert.ok(result.content[0].text.includes('No checked-off item'));
    });

    it('returns error for non-existent item', async () => {
      const result = await handlers.shopping({ action: 'uncheck_item', name: 'Ghost' });
      assert.equal(result.isError, true);
    });
  });

  describe('delete_item', () => {
    it('deletes an existing item', async () => {
      client._items.push({ name: 'Milk' });
      const result = await handlers.shopping({ action: 'delete_item', name: 'Milk' });
      assert.ok(result.content[0].text.includes('Successfully deleted'));
      assert.equal(client._items.length, 0);
    });

    it('returns error for non-existent item', async () => {
      const result = await handlers.shopping({ action: 'delete_item', name: 'Ghost' });
      assert.equal(result.isError, true);
    });
  });

  describe('list_items', () => {
    it('returns empty message when no items', async () => {
      const result = await handlers.shopping({ action: 'list_items' });
      assert.ok(result.content[0].text.includes('No unchecked items'));
    });

    it('lists items grouped by category', async () => {
      client._items.push({ name: 'Milk', category: 'Dairy' }, { name: 'Bread', category: 'Bakery' });
      const result = await handlers.shopping({ action: 'list_items' });
      assert.ok(result.content[0].text.includes('Milk'));
      assert.ok(result.content[0].text.includes('Bread'));
      assert.ok(result.content[0].text.includes('Dairy'));
      assert.ok(result.content[0].text.includes('Bakery'));
    });

    it('renders quantities (including units) next to the item', async () => {
      client._items.push({ name: 'Flour', quantity: '500 g' }, { name: 'Eggs', quantity: 12 });
      const result = await handlers.shopping({ action: 'list_items' });
      assert.ok(result.content[0].text.includes('Flour (500 g)'));
      assert.ok(result.content[0].text.includes('Eggs (12)'));
    });

    it('excludes checked items by default', async () => {
      client._items.push({ name: 'Milk', checked: false }, { name: 'Done', checked: true });
      const result = await handlers.shopping({ action: 'list_items' });
      assert.ok(result.content[0].text.includes('Milk'));
      assert.ok(!result.content[0].text.includes('Done'));
    });

    it('includes checked items when requested', async () => {
      client._items.push({ name: 'Milk', checked: false }, { name: 'Done', checked: true });
      const result = await handlers.shopping({ action: 'list_items', include_checked: true });
      assert.ok(result.content[0].text.includes('Done'));
    });

    it('includes notes when requested', async () => {
      client._items.push({ name: 'Milk', notes: 'whole milk' });
      const result = await handlers.shopping({ action: 'list_items', include_notes: true });
      assert.ok(result.content[0].text.includes('whole milk'));
    });
  });

  describe('list_lists', () => {
    it('returns empty message when no lists', async () => {
      const result = await handlers.shopping({ action: 'list_lists' });
      assert.ok(result.content[0].text.includes('No lists found'));
    });

    it('returns list names with counts', async () => {
      client._lists = [
        { name: 'Groceries', uncheckedCount: 5 },
        { name: 'Costco', uncheckedCount: 2 },
      ];
      const result = await handlers.shopping({ action: 'list_lists' });
      assert.ok(result.content[0].text.includes('Groceries'));
      assert.ok(result.content[0].text.includes('5 unchecked'));
    });
  });

  describe('get_favorites', () => {
    it('returns empty message when no favorites', async () => {
      const result = await handlers.shopping({ action: 'get_favorites' });
      assert.ok(result.content[0].text.includes('No favorite items'));
    });

    it('returns favorite items', async () => {
      client._favorites = [{ name: 'Bananas', details: 'organic' }];
      const result = await handlers.shopping({ action: 'get_favorites' });
      assert.ok(result.content[0].text.includes('Bananas'));
      assert.ok(result.content[0].text.includes('organic'));
    });
  });

  describe('get_recents', () => {
    it('returns empty message when no recents', async () => {
      const result = await handlers.shopping({ action: 'get_recents' });
      assert.ok(result.content[0].text.includes('No recent items'));
    });

    it('returns recent items', async () => {
      client._recents = [{ name: 'Avocado' }];
      const result = await handlers.shopping({ action: 'get_recents' });
      assert.ok(result.content[0].text.includes('Avocado'));
    });
  });

  describe('set_item_pricing', () => {
    beforeEach(async () => {
      await handlers.shopping({ action: 'add_item', name: 'Tomatoes' });
    });

    it('sets price, package size and upc', async () => {
      const result = await handlers.shopping({
        action: 'set_item_pricing', name: 'Tomatoes',
        price: 2.49, price_details: 'per lb', package_size: '1 lb', upc: '0123',
      });
      assert.ok(result.content[0].text.includes('Updated pricing for "Tomatoes"'));
      assert.deepEqual(client._items[0].pricing, {
        price: 2.49, storeName: undefined, priceDetails: 'per lb', packageSize: '1 lb', upc: '0123',
      });
    });

    it('accepts null to clear the price', async () => {
      await handlers.shopping({ action: 'set_item_pricing', name: 'Tomatoes', price: null });
      assert.equal(client._items[0].pricing.price, null);
    });

    it('allows a price of 0', async () => {
      await handlers.shopping({ action: 'set_item_pricing', name: 'Tomatoes', price: 0 });
      assert.equal(client._items[0].pricing.price, 0);
    });

    it('resolves a partial item name', async () => {
      await handlers.shopping({ action: 'set_item_pricing', name: 'tomat', price: 1 });
      assert.equal(client._items[0].pricing.price, 1);
    });

    it('errors when nothing to set', async () => {
      const result = await handlers.shopping({ action: 'set_item_pricing', name: 'Tomatoes' });
      assert.equal(result.isError, true);
      assert.ok(result.content[0].text.includes('requires at least one of'));
    });

    it('errors when price_details is given without price', async () => {
      const result = await handlers.shopping({
        action: 'set_item_pricing', name: 'Tomatoes', package_size: '1 lb', price_details: 'per lb',
      });
      assert.equal(result.isError, true);
      assert.ok(result.content[0].text.includes('requires "price"'));
    });

    it('errors on unknown item', async () => {
      const result = await handlers.shopping({ action: 'set_item_pricing', name: 'Nope', price: 1 });
      assert.equal(result.isError, true);
    });
  });

  describe('set_item_photo', () => {
    beforeEach(async () => {
      await handlers.shopping({ action: 'add_item', name: 'Tomatoes' });
    });

    it('sets a photo from a URL', async () => {
      const result = await handlers.shopping({
        action: 'set_item_photo', name: 'Tomatoes', photo_url: 'https://example.com/t.jpg',
      });
      assert.ok(result.content[0].text.includes('Set photo for "Tomatoes"'));
      assert.equal(client._items[0].photo, 'https://example.com/t.jpg');
    });

    it('removes the photo with null', async () => {
      const result = await handlers.shopping({ action: 'set_item_photo', name: 'Tomatoes', photo_url: null });
      assert.ok(result.content[0].text.includes('Removed photo'));
    });

    it('errors when photo_url is missing', async () => {
      const result = await handlers.shopping({ action: 'set_item_photo', name: 'Tomatoes' });
      assert.equal(result.isError, true);
    });

    it('auto-picks the first search result with photo_query', async () => {
      const result = await handlers.shopping({ action: 'set_item_photo', name: 'Tomatoes', photo_query: 'red tomato' });
      assert.equal(client._items[0].photo, 'https://img/1.jpg');
      assert.ok(result.content[0].text.includes('CC BY 2.0'));
      assert.deepEqual(searchCalls[0], { query: 'red tomato', upc: undefined, limit: 1 });
    });

    it('auto-picks using the item name when only upc is missing', async () => {
      await handlers.shopping({ action: 'set_item_photo', name: 'Tomatoes', upc: '0123' });
      assert.deepEqual(searchCalls[0], { query: undefined, upc: '0123', limit: 1 });
    });

    it('errors when nothing is found', async () => {
      searchResult = { results: [], errors: ['openverse: HTTP 500'] };
      const result = await handlers.shopping({ action: 'set_item_photo', name: 'Tomatoes', photo_query: 'zzz' });
      assert.equal(result.isError, true);
      assert.ok(result.content[0].text.includes('No photo found'));
      assert.equal(client._items[0].photo, undefined);
    });
  });

  describe('search_item_photos', () => {
    it('lists candidates with license and creator', async () => {
      const result = await handlers.shopping({ action: 'search_item_photos', photo_query: 'tomato', limit: 2 });
      const text = result.content[0].text;
      assert.ok(text.includes('2 candidate photos'));
      assert.ok(text.includes('https://img/2.jpg'));
      assert.ok(text.includes('CC-BY-SA'));
      assert.equal(searchCalls[0].limit, 2);
    });

    it('falls back to the item name as query', async () => {
      await handlers.shopping({ action: 'search_item_photos', name: 'Tomatoes' });
      assert.equal(searchCalls[0].query, 'Tomatoes');
    });

    it('errors without query, name or upc', async () => {
      const result = await handlers.shopping({ action: 'search_item_photos' });
      assert.equal(result.isError, true);
    });

    it('reports empty results and source errors', async () => {
      searchResult = { results: [], errors: ['openverse: HTTP 500'] };
      const result = await handlers.shopping({ action: 'search_item_photos', photo_query: 'x' });
      assert.ok(result.content[0].text.includes('No photos found'));
      assert.ok(result.content[0].text.includes('HTTP 500'));
    });
  });
});
