const crypto = require('crypto');
const {
  ITEM_NAME,
  STICKER_ITEM_NAME,
  COLORS,
  SIZES,
  normalize,
  buildOptionLookup,
  parseVariation,
  variationEligibility,
  selectTeeItem,
  square,
  listCatalog,
  resolveLocation
} = require('./_merch-square');

const MAX_LINES = 8;
const MAX_TOTAL_QTY = 10;

function parseCart(body) {
  let source = Array.isArray(body.items) ? body.items : [];

  if (!source.length && body.variationId) {
    source = [{ variationId: body.variationId, quantity: body.quantity || 1 }];
  }

  if (!source.length) return null;

  const merged = new Map();

  for (const line of source) {
    const variationId = String((line && line.variationId) || '').trim();
    const quantity = Number((line && line.quantity) || 0);

    if (!variationId || !Number.isInteger(quantity) || quantity < 1 || quantity > 5) {
      return null;
    }

    const nextQuantity = (merged.get(variationId) || 0) + quantity;
    if (nextQuantity > 5) return null;
    merged.set(variationId, nextQuantity);
  }

  return Array.from(merged.entries()).map(function (entry) {
    return { variationId: entry[0], quantity: entry[1] };
  });
}

function publicError(message, status) {
  const error = new Error(message);
  error.publicStatus = status || 400;
  return error;
}

function validateVariation(line, variation, parent, optionLookup, locationId, teeItemId) {
  const data = variation && variation.item_variation_data;

  if (!variation || variation.type !== 'ITEM_VARIATION' || !data || !parent || parent.type !== 'ITEM') {
    throw publicError('Invalid product selection', 400);
  }

  const parentDisplayName = (parent.item_data && parent.item_data.name) || '';
  const parentName = normalize(parentDisplayName);
  const eligibility = variationEligibility(variation, parent, locationId);

  if (!eligibility.eligible) {
    throw publicError('That item is not currently available for web sale', 409);
  }

  if (parentName === normalize(STICKER_ITEM_NAME)) {
    if (normalize(data.name) !== 'regular') {
      throw publicError('Sticker variation is not approved for web sale', 400);
    }

    return {
      variationId: line.variationId,
      quantity: line.quantity,
      kind: 'sticker',
      name: parentDisplayName || STICKER_ITEM_NAME
    };
  }

  if (parent.id !== teeItemId) {
    throw publicError('Item is not approved for web sale', 400);
  }

  const parsed = parseVariation(data, optionLookup);
  const color = parsed.color;
  const size = parsed.size;

  if (!COLORS.includes(color) || !SIZES.includes(size)) {
    throw publicError('Variation is not approved for web sale', 400);
  }

  const sameCombo = ((parent.item_data && parent.item_data.variations) || []).filter(function (candidate) {
    const candidateData = candidate.item_variation_data || {};
    const candidateParsed = parseVariation(candidateData, optionLookup);
    const candidateEligibility = variationEligibility(candidate, parent, locationId);

    return candidateEligibility.eligible &&
      candidateParsed.color === color &&
      candidateParsed.size === size;
  });

  if (sameCombo.length !== 1 || sameCombo[0].id !== line.variationId) {
    throw publicError('That color/size needs cleanup in Square before web sale', 409);
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
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
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
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      body: JSON.stringify({ error: 'Square is not configured' })
    };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (error) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      body: JSON.stringify({ error: 'Invalid request' })
    };
  }

  const cart = parseCart(body);
  const totalQty = cart
    ? cart.reduce(function (sum, line) { return sum + line.quantity; }, 0)
    : 0;

  if (!cart || !cart.length || cart.length > MAX_LINES || totalQty < 1 || totalQty > MAX_TOTAL_QTY) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      body: JSON.stringify({ error: 'Invalid cart' })
    };
  }

  try {
    const location = await resolveLocation(token, configuredLocationId);
    const locationId = location.id;
    const ids = cart.map(function (line) { return line.variationId; });

    const results = await Promise.all([
      square('/v2/catalog/batch-retrieve', token, {
        method: 'POST',
        body: JSON.stringify({
          object_ids: ids,
          include_related_objects: true
        })
      }),
      listCatalog(token, ['ITEM', 'ITEM_OPTION'])
    ]);

    const catalog = results[0];
    const catalogObjects = results[1];
    const optionLookup = buildOptionLookup(catalogObjects);
    const teeItem = selectTeeItem(
      catalogObjects.filter(function (object) { return object.type === 'ITEM'; }),
      optionLookup
    );

    if (!teeItem) {
      throw publicError('Merch item is not configured for web sale', 503);
    }

    const variationsById = {};
    const parentsById = {};

    (catalog.objects || []).forEach(function (object) {
      if (object.type === 'ITEM_VARIATION') variationsById[object.id] = object;
      if (object.type === 'ITEM') parentsById[object.id] = object;
    });

    (catalog.related_objects || []).forEach(function (object) {
      if (object.type === 'ITEM') parentsById[object.id] = object;
    });

    const validated = cart.map(function (line) {
      const variation = variationsById[line.variationId];
      const data = variation && variation.item_variation_data;
      const parent = data && parentsById[data.item_id];

      return validateVariation(
        line,
        variation,
        parent,
        optionLookup,
        locationId,
        teeItem.id
      );
    });

    const hasTee = validated.some(function (line) { return line.kind === 'tee'; });
    const hasSticker = validated.some(function (line) { return line.kind === 'sticker'; });

    if (hasSticker && !hasTee) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
        body: JSON.stringify({
          error: 'Stickers are available as an add-on with a tee order.'
        })
      };
    }

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
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
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
            name: 'Flat Rate Shipping',
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
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
        body: JSON.stringify({ error: error.message })
      };
    }

    return {
      statusCode: 502,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      body: JSON.stringify({
        error: 'Unable to start Square checkout right now',
        squareStatus: error && error.status ? error.status : null,
        squareErrors: error && error.squareErrors ? error.squareErrors : []
      })
    };
  }
};
