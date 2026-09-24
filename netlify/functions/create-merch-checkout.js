const fetch = require('node-fetch');
const crypto = require('crypto');

const API = 'https://connect.squareup.com';
const VERSION = '2026-09-16';
const COLORS = ['Black', 'Yellow', 'Mint', 'Heather Gray'];
const SIZES = ['S', 'M', 'L', 'XL', '2XL'];
const MAX_LINES = 8;
const MAX_TOTAL_QTY = 10;

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
    err.squareErrors = (data.errors || []).map(function (e) {
      return {
        code: e.code || null,
        category: e.category || null,
        detail: e.detail || null,
        field: e.field || null
      };
    });
    throw err;
  }

  return data;
}

async function resolveLocation(token, configuredLocationId) {
  try {
    const data = await square('/v2/locations', token, { method: 'GET' });
    const locations = data.locations || [];
    const active = locations.filter(function (location) {
      return location.status === 'ACTIVE';
    });

    if (active.length === 1) return active[0];

    const configured = active.find(function (location) {
      return location.id === configuredLocationId;
    });
    if (configured) return configured;

    if (active.length) return active[0];
  } catch (error) {
    console.error('checkout location resolution failed', error);
  }

  if (configuredLocationId) return { id: configuredLocationId, name: configuredLocationId };
  throw new Error('No Square location available');
}

function parseCart(body) {
  let source = Array.isArray(body.items) ? body.items : [];

  // Backward compatibility with the first prototype request shape.
  if (!source.length && body.variationId) {
    source = [{ variationId: body.variationId, quantity: body.quantity || 1 }];
  }

  const merged = new Map();

  source.forEach(function (line) {
    const variationId = String((line && line.variationId) || '').trim();
    const quantity = Number((line && line.quantity) || 0);
    if (!variationId || !Number.isInteger(quantity) || quantity < 1 || quantity > 5) return;
    merged.set(variationId, (merged.get(variationId) || 0) + quantity);
  });

  return Array.from(merged.entries()).map(function (entry) {
    return { variationId: entry[0], quantity: entry[1] };
  });
}

async function validateVariation(line, token) {
  const catalog = await square(
    '/v2/catalog/object/' + encodeURIComponent(line.variationId) + '?include_related_objects=true',
    token,
    { method: 'GET' }
  );

  const variation = catalog.object;
  const data = variation && variation.item_variation_data;
  const parent = (catalog.related_objects || []).find(function (obj) {
    return obj.type === 'ITEM' && data && obj.id === data.item_id;
  });

  if (!variation || variation.type !== 'ITEM_VARIATION' || !data || !parent) {
    const err = new Error('Invalid product selection');
    err.publicStatus = 400;
    throw err;
  }

  const parentDisplayName = (parent.item_data && parent.item_data.name) || '';
  const parentName = normalize(parentDisplayName);

  if (parentName.includes('sticker')) {
    return {
      variationId: line.variationId,
      quantity: line.quantity,
      kind: 'sticker',
      name: parentDisplayName || 'Howzit Sticker'
    };
  }

  if (!(parentName.includes('tee') || parentName.includes('shirt'))) {
    const err = new Error('Item is not approved for web sale');
    err.publicStatus = 400;
    throw err;
  }

  const color = getColor(data.name);
  const size = getSize(data.name);

  if (!COLORS.includes(color) || !SIZES.includes(size)) {
    const err = new Error('Variation is not approved for web sale');
    err.publicStatus = 400;
    throw err;
  }

  const parentVariations = (parent.item_data && parent.item_data.variations) || [];
  const sameCombo = parentVariations.filter(function (candidate) {
    const candidateData = candidate.item_variation_data || {};
    return getColor(candidateData.name) === color && getSize(candidateData.name) === size;
  });

  if (sameCombo.length !== 1 || sameCombo[0].id !== line.variationId) {
    const err = new Error('That color/size needs cleanup in Square before web sale');
    err.publicStatus = 409;
    throw err;
  }

  return {
    variationId: line.variationId,
    quantity: line.quantity,
    kind: 'tee',
    color: color,
    size: size
  };
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Method not allowed' })
    };
  }

  const token = process.env.SQUARE_ACCESS_TOKEN;
  const configuredLocationId = process.env.SQUARE_LOCATION_ID;
  const rawShipping = String(process.env.MERCH_SHIPPING_CENTS || '995').trim();
  let shippingCents = Number(rawShipping);
  if (rawShipping.includes('.') && shippingCents > 0 && shippingCents < 100) {
    shippingCents = Math.round(shippingCents * 100);
  }
  if (!Number.isInteger(shippingCents) || shippingCents <= 0) {
    shippingCents = 995;
  }

  if (!token) {
    return {
      statusCode: 503,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Square is not configured' })
    };
  }

  let location;
  try {
    location = await resolveLocation(token, configuredLocationId);
  } catch (error) {
    return {
      statusCode: 503,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'No usable Square location found' })
    };
  }
  const locationId = location.id;

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (error) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Invalid request' })
    };
  }

  const cart = parseCart(body);
  const totalQty = cart.reduce(function (sum, line) { return sum + line.quantity; }, 0);

  if (!cart.length || cart.length > MAX_LINES || totalQty < 1 || totalQty > MAX_TOTAL_QTY) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Invalid cart' })
    };
  }

  try {
    const validated = [];
    for (const line of cart) {
      validated.push(await validateVariation(line, token));
    }

    const ids = validated.map(function (line) { return line.variationId; });
    const inventory = await square('/v2/inventory/counts/batch-retrieve', token, {
      method: 'POST',
      body: JSON.stringify({
        catalog_object_ids: ids,
        location_ids: [locationId],
        states: ['IN_STOCK']
      })
    });

    const stock = {};
    (inventory.counts || []).forEach(function (count) {
      if (count.state !== 'IN_STOCK') return;
      stock[count.catalog_object_id] =
        (stock[count.catalog_object_id] || 0) + Number(count.quantity || 0);
    });

    for (const line of validated) {
      if ((stock[line.variationId] || 0) < line.quantity) {
        return {
          statusCode: 409,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            error: line.kind === 'sticker'
              ? (line.name + ' does not have enough stock')
              : (line.color + ' / ' + line.size + ' does not have enough stock')
          })
        };
      }
    }

    const lineItems = validated.map(function (line) {
      return {
        quantity: String(line.quantity),
        catalog_object_id: line.variationId
      };
    });

    const note = validated.map(function (line) {
      if (line.kind === 'sticker') return line.quantity + 'x ' + line.name;
      return line.quantity + 'x ' + line.color + ' / ' + line.size;
    }).join(', ');

    const paymentLink = await square('/v2/online-checkout/payment-links', token, {
      method: 'POST',
      body: JSON.stringify({
        idempotency_key: crypto.randomUUID(),
        description: 'Howzit website merch',
        order: {
          location_id: locationId,
          line_items: lineItems,
          pricing_options: {
            auto_apply_taxes: true
          }
        },
        checkout_options: {
          ask_for_shipping_address: true,
          allow_tipping: false,
          enable_coupon: false,
          redirect_url: 'https://www.howzitbrewing.com/shopping/?checkout=success',
          shipping_fee: {
            name: 'Shipping',
            charge: {
              amount: shippingCents,
              currency: 'USD'
            }
          }
        },
        payment_note: 'Howzit website merch: ' + note
      })
    });

    const payment = paymentLink.payment_link || {};
    const checkoutUrl = payment.long_url || payment.url;

    if (!checkoutUrl) {
      throw new Error('Square did not return a checkout URL');
    }

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store'
      },
      body: JSON.stringify({ checkoutUrl: checkoutUrl })
    };
  } catch (error) {
    console.error('create-merch-checkout failed', error);

    if (error && error.publicStatus) {
      return {
        statusCode: error.publicStatus,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: error.message })
      };
    }

    return {
      statusCode: 502,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        error: 'Unable to start Square checkout right now',
        squareStatus: error && error.status ? error.status : null,
        squareErrors: error && error.squareErrors ? error.squareErrors : []
      })
    };
  }
};
