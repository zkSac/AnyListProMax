import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import AnyListClient from '../src/anylist-client.js';

const require = createRequire(import.meta.url);
const ProtoBuf = require('protobufjs');
const Item = require('../anylist-js/lib/item.js');
const pb = ProtoBuf.newBuilder({}).import(require('../anylist-js/lib/definitions.json')).build('pcov.proto');

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32)]);

function decodeOps(form) {
  const buf = form.body._streams.find(s => Buffer.isBuffer(s));
  return pb.PBListOperationList.decode(buf).operations;
}

describe('Item pricing / package / upc / photo', () => {
  let posts;
  let item;

  beforeEach(() => {
    posts = [];
    const client = { post: async (url, opts) => { posts.push({ url, body: opts.body }); } };
    item = new Item(
      { identifier: 'i1', listId: 'l1', name: 'Tomatoes', quantityPb: { rawQuantity: '2' }, photoIds: ['p0'], recipeId: 'r1' },
      { client, protobuf: pb, uid: 'u1' },
    );
  });

  it('sends save-item-price, package and upc ops in a single request', async () => {
    await item.setPricing({ price: 2.49, storeId: 's1', priceDetails: 'per lb', packageSize: '1.5 lb', upc: '0123' });
    assert.equal(posts.length, 1);
    assert.equal(posts[0].url, 'data/shopping-lists/update');
    const ops = decodeOps(posts[0]);
    assert.deepEqual(ops.map(o => o.metadata.handlerId),
      ['save-item-price', 'set-list-item-package-size', 'set-list-item-product-upc']);
    assert.equal(ops[0].itemPrice.amount, 2.49);
    assert.equal(ops[0].itemPrice.storeId, 's1');
    assert.equal(ops[0].itemPrice.details, 'per lb');
    assert.equal(ops[1].listItem.packageSizePb.size, '1.5');
    assert.equal(ops[1].listItem.packageSizePb.unit, 'lb');
    assert.equal(ops[2].updatedValue, '0123');
  });

  it('only sends ops for fields that were provided', async () => {
    await item.setPricing({ upc: '999' });
    assert.deepEqual(decodeOps(posts[0]).map(o => o.metadata.handlerId), ['set-list-item-product-upc']);
  });

  it('does not post when nothing is provided', async () => {
    await item.setPricing({});
    assert.equal(posts.length, 0);
  });

  it('replaces the price for the same store and keeps other stores', async () => {
    await item.setPricing({ price: 1, storeId: 's1' });
    await item.setPricing({ price: 2, storeId: 's2' });
    await item.setPricing({ price: 3, storeId: 's1' });
    const prices = item.toJSON().prices;
    assert.equal(prices.length, 2);
    assert.equal(prices.find(p => p.storeId === 's1').amount, 3);
    assert.equal(prices.find(p => p.storeId === 's2').amount, 2);
  });

  it('price=null removes the price for that store', async () => {
    await item.setPricing({ price: 1, storeId: 's1' });
    await item.setPricing({ price: null, storeId: 's1' });
    assert.equal(item.toJSON().prices.length, 0);
    const op = decodeOps(posts[1])[0];
    assert.equal(op.metadata.handlerId, 'save-item-price');
    assert.equal(op.itemPrice.storeId, 's1');
    assert.equal(op.itemPrice.amount, null);
  });

  it('rejects non-numeric prices without posting', async () => {
    await assert.rejects(() => item.setPricing({ price: NaN }), TypeError);
    await assert.rejects(() => item.setPricing({ price: '3' }), TypeError);
    assert.equal(posts.length, 0);
  });

  it('keeps photos, recipe link and quantity in a full-item encode', async () => {
    await item.setPricing({ price: 5 });
    const decoded = pb.ListItem.decode(item._encode().toBuffer());
    assert.deepEqual(decoded.photoIds, ['p0']);
    assert.equal(decoded.recipeId, 'r1');
    assert.equal(decoded.quantityPb.rawQuantity, '2');
    assert.equal(decoded.prices[0].amount, 5);
  });

  it('setPhoto(url) calls upload-url then set-list-item-photo-id', async () => {
    const id = await item.setPhoto('https://example.com/t.jpg');
    assert.equal(posts[0].url, 'data/photos/upload-url');
    assert.equal(posts[1].url, 'data/shopping-lists/update');
    const op = decodeOps(posts[1])[0];
    assert.equal(op.metadata.handlerId, 'set-list-item-photo-id');
    assert.equal(op.updatedValue, id);
    assert.deepEqual(item.toJSON().photoIds, [id]);
  });

  it('setPhoto(buffer) uploads multipart to data/photos/upload', async () => {
    await item.setPhoto(JPEG);
    assert.equal(posts[0].url, 'data/photos/upload');
  });

  it('setPhoto(null) clears the photo without uploading', async () => {
    assert.equal(await item.setPhoto(null), null);
    assert.equal(posts.length, 1);
    assert.equal(decodeOps(posts[0])[0].updatedValue, '');
    assert.deepEqual(item.toJSON().photoIds, []);
  });

  it('setPhoto rejects non-images, oversized files and non-http strings', async () => {
    await assert.rejects(() => item.setPhoto(Buffer.from('#!/bin/sh\nsecret secret secret')), /not a supported image/);
    await assert.rejects(() => item.setPhoto(Buffer.concat([JPEG, Buffer.alloc(11 * 1024 * 1024)])), /10 MB/);
    await assert.rejects(() => item.setPhoto('/etc/passwd'), /http\(s\) URL/);
    assert.equal(posts.length, 0);
  });
});

describe('AnyListClient local photo files', () => {
  it('refuses local paths when allowLocalFiles is false', async () => {
    const c = new AnyListClient({ allowLocalFiles: false });
    c.targetList = { getItemByName: () => ({ setPhoto: async () => 'id' }) };
    await assert.rejects(() => c.setItemPhoto('x', '/etc/passwd'), /not allowed/);
    assert.equal(await c.setItemPhoto('x', 'https://example.com/a.jpg'), 'id');
  });
});
