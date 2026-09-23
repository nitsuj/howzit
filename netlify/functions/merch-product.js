const fetch = require('node-fetch');

const API = 'https://connect.squareup.com';
const VERSION = '2026-09-16';
const ITEM_NAME = 'Howzit Tee';
const COLORS = ['Black', 'Yellow', 'Mint', 'Heather Gray'];
const SIZES = ['S', 'M', 'L', 'XL', '2XL'];

function headers(token) {
  return {
    Authorization: 'Bearer ' + token,
    'Content-Type': 'application/json',
    'Square-Version': VERSION
  };
}

function normalize(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/grey/g, 'gray')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function getColor(name) {
  const n = normalize(name);
  if (n.includes('heather gray')) return 'Heather Gray';
  if (/(^| )black( |$)/.test(n)) return 'Black';
  if (/(^| )yellow( |$)/.test(n)) return 'Yellow';
  if (/(^| )mint( |$)/.test(n)) return 'Mint';
  return null;
}

function getSize(name) {
  const n = normalize(name);
  const t = new Set(n.split(' '));
  if (t.has('2xl') || t.has('xxl') || t.has('2x') || n.includes('2x large')) return '2XL';
  if (t.has('xl') || t.has('xlarge') || n.includes('x large')) return 'XL';
  if (t.has('l') || t.has('large')) return 'L';
  if (t.has('m') || t.has('medium')) return 'M';
  if (t.has('s') || t.has('small')) return 'S';
  return null;
}

async function square(path, token, options) {
  const response = await fetch(API + path, Object.assign({}, options || {}, {
    headers: Object.assign({}, headers(token), (options && options.headers) || {})
  }));
  const data = await response.json().catch(function () { return {}; });
  if (!response.ok) {
    console.error('Square API error', response.status, data);
    throw new Error('Square API ' + response.status);
  }
  return data;
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const token = process.env.SQUARE_ACCESS_TOKEN;
  const locationId = process.env.SQUARE_LOCATION_ID;

  if (!token || !locationId) {
    return {
      statusCode: 503,
      headers: { 'Cache-Control': 'no-store' },
      body: JSON.stringify({ error: 'Square is not configured' })
    };
  }

  try {
    const search = await square('/v2/catalog/search-catalog-items', token, {
      method: 'POST',
      body: JSON.stringify({
        text_filter: ITEM_NAME,
        enabled_location_ids: [locationId],
        archived_state: 'ARCHIVED_STATE_NOT_ARCHIVED'
      })
    });

    const exact = (search.items || []).filter(function (item) {
      return normalize(item.item_data && item.item_data.name) === normalize(ITEM_NAME);
    });

    if (exact.length !== 1) {
      return {
        statusCode: exact.length ? 409 : 404,
        headers: { 'Cache-Control': 'no-store' },
        body: JSON.stringify({ error: exact.length ? 'Multiple Howzit Tee items found' : 'Howzit Tee not found' })
      };
    }

    const itemId = exact[0].id;
    const retrieved = await square('/v2/catalog/batch-retrieve', token, {
      method: 'POST',
      body: JSON.stringify({ object_ids: [itemId], include_related_objects: true })
    });

    const item = (retrieved.objects || []).find(function (obj) { return obj.id === itemId; }) || exact[0];
    const rawVariations = (item.item_data && item.item_data.variations) || [];

    const imageIds = [];
    ((item.item_data && item.item_data.image_ids) || []).forEach(function (id) { imageIds.push(id); });
    rawVariations.forEach(function (variation) {
      ((variation.item_variation_data && variation.item_variation_data.image_ids) || []).forEach(function (id) {
        imageIds.push(id);
      });
    });

    let imageMap = {};
    const uniqueImageIds = Array.from(new Set(imageIds));
    if (uniqueImageIds.length) {
      const imageData = await square('/v2/catalog/batch-retrieve', token, {
        method: 'POST',
        body: JSON.stringify({ object_ids: uniqueImageIds, include_related_objects: false })
      });
      (imageData.objects || []).forEach(function (obj) {
        if (obj.type === 'IMAGE' && obj.image_data && obj.image_data.url) {
          imageMap[obj.id] = obj.image_data.url;
        }
      });
    }

    const parsed = rawVariations.map(function (variation) {
      const data = variation.item_variation_data || {};
      return {
        id: variation.id,
        name: data.name || '',
        color: getColor(data.name),
        size: getSize(data.name),
        priceCents: Number((data.price_money && data.price_money.amount) || 0),
        imageId: (data.image_ids && data.image_ids[0]) || null
      };
    }).filter(function (variation) {
      return COLORS.includes(variation.color) && SIZES.includes(variation.size);
    });

    const inventoryMap = {};
    if (parsed.length) {
      const inventory = await square('/v2/inventory/counts/batch-retrieve', token, {
        method: 'POST',
        body: JSON.stringify({
          catalog_object_ids: parsed.map(function (v) { return v.id; }),
          location_ids: [locationId],
          states: ['IN_STOCK']
        })
      });

      (inventory.counts || []).forEach(function (count) {
        if (count.state !== 'IN_STOCK') return;
        inventoryMap[count.catalog_object_id] =
          (inventoryMap[count.catalog_object_id] || 0) + Number(count.quantity || 0);
      });
    }

    const grouped = {};
    parsed.forEach(function (variation) {
      const key = variation.color + '|' + variation.size;
      if (!grouped[key]) grouped[key] = [];
      variation.stock = inventoryMap[variation.id] || 0;
      grouped[key].push(variation);
    });

    const itemImageId = item.item_data && item.item_data.image_ids && item.item_data.image_ids[0];
    const itemImage = itemImageId ? imageMap[itemImageId] || null : null;
    const variations = [];

    COLORS.forEach(function (color) {
      SIZES.forEach(function (size) {
        const matches = grouped[color + '|' + size] || [];
        if (!matches.length) {
          variations.push({ color: color, size: size, available: false, stock: 0, missing: true });
          return;
        }
        if (matches.length > 1) {
          variations.push({ color: color, size: size, available: false, stock: 0, ambiguous: true });
          return;
        }
        const v = matches[0];
        variations.push({
          id: v.id,
          color: color,
          size: size,
          priceCents: v.priceCents,
          price: v.priceCents / 100,
          stock: v.stock,
          available: v.stock > 0,
          image: (v.imageId && imageMap[v.imageId]) || itemImage
        });
      });
    });

    const priced = variations.find(function (v) { return v.priceCents; });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store, max-age=0' },
      body: JSON.stringify({
        id: item.id,
        name: (item.item_data && item.item_data.name) || ITEM_NAME,
        image: itemImage,
        colors: COLORS,
        sizes: SIZES,
        priceCents: priced ? priced.priceCents : 3200,
        price: priced ? priced.price : 32,
        variations: variations
      })
    };
  } catch (error) {
    console.error('merch-product failed', error);
    return {
      statusCode: 502,
      headers: { 'Cache-Control': 'no-store' },
      body: JSON.stringify({ error: 'Unable to load Square merch right now' })
    };
  }
};
