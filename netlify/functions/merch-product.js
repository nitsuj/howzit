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
    const err = new Error('Square API ' + response.status);
    err.status = response.status;
    err.path = path;
    err.squareErrors = (data.errors || []).map(function (e) {
      return {
        code: e.code || null,
        category: e.category || null,
        detail: e.detail || null
      };
    });
    throw err;
  }

  return data;
}

async function listCatalog(token) {
  let cursor = null;
  const objects = [];

  do {
    const params = new URLSearchParams({ types: 'ITEM,IMAGE' });
    if (cursor) params.set('cursor', cursor);

    const page = await square('/v2/catalog/list?' + params.toString(), token, { method: 'GET' });
    (page.objects || []).forEach(function (obj) { objects.push(obj); });
    cursor = page.cursor || null;
  } while (cursor);

  return objects;
}

function errorBody(error, stage) {
  return {
    error: 'Unable to load Square merch right now',
    stage: stage,
    squareStatus: error && error.status ? error.status : null,
    squareErrors: error && error.squareErrors ? error.squareErrors : []
  };
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
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      body: JSON.stringify({
        error: 'Square is not configured',
        missing: {
          SQUARE_ACCESS_TOKEN: !token,
          SQUARE_LOCATION_ID: !locationId
        }
      })
    };
  }

  let objects;
  try {
    objects = await listCatalog(token);
  } catch (error) {
    console.error('merch-product catalog list failed', error);
    return {
      statusCode: 502,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      body: JSON.stringify(errorBody(error, 'catalog'))
    };
  }

  const items = objects.filter(function (obj) { return obj.type === 'ITEM'; });
  const images = {};
  objects.forEach(function (obj) {
    if (obj.type === 'IMAGE' && obj.image_data && obj.image_data.url) {
      images[obj.id] = obj.image_data.url;
    }
  });

  function scoreItem(item) {
    const vars = (item.item_data && item.item_data.variations) || [];
    const recognized = vars.map(function (variation) {
      const data = variation.item_variation_data || {};
      return {
        color: getColor(data.name),
        size: getSize(data.name),
        priceCents: Number((data.price_money && data.price_money.amount) || 0)
      };
    }).filter(function (v) {
      return COLORS.includes(v.color) && SIZES.includes(v.size);
    });

    const combos = new Set(recognized.map(function (v) { return v.color + '|' + v.size; }));
    const priceMatches = recognized.filter(function (v) { return v.priceCents === 3200; }).length;
    return {
      item: item,
      combos: combos.size,
      recognized: recognized.length,
      priceMatches: priceMatches
    };
  }

  let item = items.find(function (candidate) {
    return normalize(candidate.item_data && candidate.item_data.name) === normalize(ITEM_NAME);
  });

  if (!item) {
    const teeCandidates = items
      .filter(function (candidate) {
        const n = normalize(candidate.item_data && candidate.item_data.name);
        return n.includes('tee') || n.includes('shirt');
      })
      .map(scoreItem)
      .sort(function (a, b) {
        return (b.combos - a.combos) ||
               (b.priceMatches - a.priceMatches) ||
               (b.recognized - a.recognized);
      });

    if (teeCandidates.length && teeCandidates[0].combos >= 10) {
      const top = teeCandidates[0];
      const next = teeCandidates[1];
      if (!next || top.combos > next.combos || top.priceMatches > next.priceMatches) {
        item = top.item;
      }
    }

    if (!item) {
      return {
        statusCode: 404,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
        body: JSON.stringify({
          error: 'Howzit Tee not found',
          stage: 'item-match',
          candidates: teeCandidates.slice(0, 10).map(function (c) {
            return ((c.item.item_data && c.item.item_data.name) || '') +
              ' [' + c.combos + ' combos / ' + c.recognized + ' recognized]';
          })
        })
      };
    }
  }

  const rawVariations = (item.item_data && item.item_data.variations) || [];

  const stickerCandidates = [];
  items.forEach(function (candidate) {
    const itemName = (candidate.item_data && candidate.item_data.name) || '';
    if (normalize(itemName) !== 'sticker') return;

    ((candidate.item_data && candidate.item_data.variations) || []).forEach(function (variation) {
      const data = variation.item_variation_data || {};
      stickerCandidates.push({
        itemId: candidate.id,
        itemName: itemName,
        id: variation.id,
        variationName: data.name || '',
        priceCents: Number((data.price_money && data.price_money.amount) || 0),
        imageId: (data.image_ids && data.image_ids[0]) ||
          ((candidate.item_data && candidate.item_data.image_ids && candidate.item_data.image_ids[0]) || null)
      });
    });
  });

  const stickerMatch = stickerCandidates.find(function (candidate) {
    return normalize(candidate.variationName) === 'regular';
  }) || null;

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
  let inventoryError = null;
  if (parsed.length || stickerMatch) {
    try {
      const inventory = await square('/v2/inventory/counts/batch-retrieve', token, {
        method: 'POST',
        body: JSON.stringify({
          catalog_object_ids: parsed.map(function (v) { return v.id; }).concat(stickerMatch ? [stickerMatch.id] : []),
          location_ids: [locationId],
          states: ['IN_STOCK']
        })
      });

      (inventory.counts || []).forEach(function (count) {
        if (count.state !== 'IN_STOCK') return;
        inventoryMap[count.catalog_object_id] =
          (inventoryMap[count.catalog_object_id] || 0) + Number(count.quantity || 0);
      });
    } catch (error) {
      console.error('merch-product inventory failed', error);
      inventoryError = errorBody(error, 'inventory');
    }
  }

  let stickerInventoryByLocation = [];
  if (stickerMatch) {
    try {
      const allStickerInventory = await square('/v2/inventory/counts/batch-retrieve', token, {
        method: 'POST',
        body: JSON.stringify({
          catalog_object_ids: [stickerMatch.id],
          states: ['IN_STOCK']
        })
      });

      const locationsData = await square('/v2/locations', token, { method: 'GET' });
      const locationNames = {};
      (locationsData.locations || []).forEach(function (location) {
        locationNames[location.id] = location.name || location.id;
      });

      stickerInventoryByLocation = (allStickerInventory.counts || [])
        .filter(function (count) {
          return count.catalog_object_id === stickerMatch.id && count.state === 'IN_STOCK';
        })
        .map(function (count) {
          return {
            locationId: count.location_id,
            locationName: locationNames[count.location_id] || count.location_id,
            quantity: Number(count.quantity || 0),
            isWebsiteLocation: count.location_id === locationId
          };
        });
    } catch (error) {
      console.error('sticker location diagnostics failed', error);
    }
  }

  const grouped = {};
  parsed.forEach(function (variation) {
    const key = variation.color + '|' + variation.size;
    if (!grouped[key]) grouped[key] = [];
    variation.stock = inventoryMap[variation.id] || 0;
    grouped[key].push(variation);
  });

  const itemImageId = item.item_data && item.item_data.image_ids && item.item_data.image_ids[0];
  const itemImage = itemImageId ? images[itemImageId] || null : null;
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
        image: (v.imageId && images[v.imageId]) || itemImage
      });
    });
  });

  const priced = variations.find(function (v) { return v.priceCents; });
  const sticker = stickerMatch ? {
    id: stickerMatch.id,
    itemId: stickerMatch.itemId,
    name: stickerMatch.itemName || 'Howzit Sticker',
    variationName: stickerMatch.variationName,
    priceCents: stickerMatch.priceCents,
    price: stickerMatch.priceCents / 100,
    stock: inventoryMap[stickerMatch.id] || 0,
    available: (inventoryMap[stickerMatch.id] || 0) > 0,
    image: (stickerMatch.imageId && images[stickerMatch.imageId]) || null,
    inventoryByLocation: stickerInventoryByLocation,
    websiteLocationId: locationId
  } : null;

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
      variations: variations,
      sticker: sticker,
      debug: {
        itemImageId: itemImageId || null,
        itemImageResolved: !!itemImage,
        variationCountRaw: rawVariations.length,
        variationCountParsed: parsed.length,
        imageCount: Object.keys(images).length,
        matchedSquareItem: (item.item_data && item.item_data.name) || null,
        stickerCandidates: stickerCandidates.map(function (candidate) {
          return candidate.itemName + ' / ' + candidate.variationName + ' / ' + candidate.priceCents;
        }).slice(0, 10),
        matchedSticker: stickerMatch ? (stickerMatch.itemName + ' / ' + stickerMatch.variationName) : null,
        inventoryError: inventoryError
      }
    })
  };
};
