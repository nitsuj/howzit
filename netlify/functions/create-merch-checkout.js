const fetch = require('node-fetch');
const crypto = require('crypto');

const API = 'https://connect.squareup.com';
const VERSION = '2026-09-16';
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

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Method not allowed' })
    };
  }

  const token = process.env.SQUARE_ACCESS_TOKEN;
  const locationId = process.env.SQUARE_LOCATION_ID;
  const shippingCents = Number(process.env.MERCH_SHIPPING_CENTS || 995);

  if (!token || !locationId) {
    return {
      statusCode: 503,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Square is not configured' })
    };
  }

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

  const variationId = String(body.variationId || '').trim();
  const quantity = Number(body.quantity || 1);

  if (!variationId || !Number.isInteger(quantity) || quantity < 1 || quantity > 5) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Invalid product selection' })
    };
  }

  try {
    const catalog = await square(
      '/v2/catalog/object/' + encodeURIComponent(variationId) + '?include_related_objects=true',
      token,
      { method: 'GET' }
    );

    const variation = catalog.object;
    const variationData = variation && variation.item_variation_data;
    const parent = (catalog.related_objects || []).find(function (obj) {
      return obj.type === 'ITEM' && variationData && obj.id === variationData.item_id;
    });

    if (!variation || variation.type !== 'ITEM_VARIATION' || !variationData || !parent) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Invalid product selection' })
      };
    }

    const parentName = normalize(parent.item_data && parent.item_data.name);
    if (!(parentName.includes('tee') || parentName.includes('shirt'))) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Item is not approved for web sale' })
      };
    }

    const color = getColor(variationData.name);
    const size = getSize(variationData.name);

    if (!COLORS.includes(color) || !SIZES.includes(size)) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Variation is not approved for web sale' })
      };
    }

    const parentVariations = (parent.item_data && parent.item_data.variations) || [];
    const recognized = parentVariations.filter(function (candidate) {
      const data = candidate.item_variation_data || {};
      return COLORS.includes(getColor(data.name)) && SIZES.includes(getSize(data.name));
    });

    const comboSet = new Set(recognized.map(function (candidate) {
      const data = candidate.item_variation_data || {};
      return getColor(data.name) + '|' + getSize(data.name);
    }));

    if (comboSet.size < 10) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Item is not approved for web sale' })
      };
    }

    const sameCombo = parentVariations.filter(function (candidate) {
      const data = candidate.item_variation_data || {};
      return getColor(data.name) === color && getSize(data.name) === size;
    });

    if (sameCombo.length !== 1 || sameCombo[0].id !== variationId) {
      return {
        statusCode: 409,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'That color/size needs cleanup in Square before web sale' })
      };
    }

    const inventory = await square('/v2/inventory/counts/batch-retrieve', token, {
      method: 'POST',
      body: JSON.stringify({
        catalog_object_ids: [variationId],
        location_ids: [locationId],
        states: ['IN_STOCK']
      })
    });

    const available = (inventory.counts || []).reduce(function (sum, count) {
      if (count.catalog_object_id !== variationId || count.state !== 'IN_STOCK') return sum;
      return sum + Number(count.quantity || 0);
    }, 0);

    if (available < quantity) {
      return {
        statusCode: 409,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'That size/color is sold out' })
      };
    }

    const paymentLink = await square('/v2/online-checkout/payment-links', token, {
      method: 'POST',
      body: JSON.stringify({
        idempotency_key: crypto.randomUUID(),
        description: 'Howzit website merch',
        order: {
          location_id: locationId,
          line_items: [{
            quantity: String(quantity),
            catalog_object_id: variationId
          }],
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
        payment_note: 'Howzit website merch: ' + color + ' / ' + size
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
      body: JSON.stringify({
        checkoutUrl: checkoutUrl
      })
    };
  } catch (error) {
    console.error('create-merch-checkout failed', error);
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
