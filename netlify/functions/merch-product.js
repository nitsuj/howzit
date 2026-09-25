const {
  ITEM_NAME,
  STICKER_ITEM_NAME,
  COLORS,
  SIZES,
  normalize,
  buildOptionLookup,
  parseVariation,
  effectivePriceCents,
  variationEligibility,
  square,
  listCatalog,
  resolveLocation
} = require('./_merch-square');

function errorBody(error, stage) {
  return {
    error: 'Unable to load Square merch right now',
    stage: stage,
    squareStatus: error && error.status ? error.status : null,
    squareErrors: error && error.squareErrors ? error.squareErrors : []
  };
}

function imageIdForVariation(data, parentItem) {
  return (data.image_ids && data.image_ids[0]) ||
    ((parentItem.item_data && parentItem.item_data.image_ids && parentItem.item_data.image_ids[0]) || null);
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const token = process.env.SQUARE_ACCESS_TOKEN;
  const configuredLocationId = process.env.SQUARE_LOCATION_ID;

  if (!token) {
    return {
      statusCode: 503,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      body: JSON.stringify({
        error: 'Square is not configured',
        missing: { SQUARE_ACCESS_TOKEN: true }
      })
    };
  }

  let location;
  try {
    location = await resolveLocation(token, configuredLocationId);
  } catch (error) {
    console.error('merch-product location resolution failed', error);
    return {
      statusCode: 503,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      body: JSON.stringify({
        error: 'No usable Square location found',
        detail: error && error.message ? error.message : null
      })
    };
  }

  const locationId = location.id;

  let objects;
  try {
    objects = await listCatalog(token, ['ITEM', 'IMAGE', 'ITEM_OPTION']);
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

  const optionLookup = buildOptionLookup(objects);

  const item = items.find(function (candidate) {
    return normalize(candidate.item_data && candidate.item_data.name) === normalize(ITEM_NAME);
  });

  if (!item) {
    return {
      statusCode: 404,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      body: JSON.stringify({
        error: ITEM_NAME + ' not found',
        stage: 'item-match'
      })
    };
  }

  const rawVariations = (item.item_data && item.item_data.variations) || [];
  const parsed = rawVariations.map(function (variation) {
    const data = variation.item_variation_data || {};
    const resolved = parseVariation(data, optionLookup);
    const eligibility = variationEligibility(variation, item, locationId);

    return {
      object: variation,
      id: variation.id,
      name: data.name || '',
      color: resolved.color,
      size: resolved.size,
      usedStructuredColor: resolved.usedStructuredColor,
      usedStructuredSize: resolved.usedStructuredSize,
      priceCents: effectivePriceCents(data, locationId),
      imageId: imageIdForVariation(data, item),
      eligibility: eligibility
    };
  }).filter(function (variation) {
    return COLORS.includes(variation.color) && SIZES.includes(variation.size);
  });

  const stickerItem = items.find(function (candidate) {
    return normalize(candidate.item_data && candidate.item_data.name) === normalize(STICKER_ITEM_NAME);
  }) || null;

  const stickerCandidates = stickerItem
    ? ((stickerItem.item_data && stickerItem.item_data.variations) || []).map(function (variation) {
        const data = variation.item_variation_data || {};
        return {
          object: variation,
          itemId: stickerItem.id,
          itemName: (stickerItem.item_data && stickerItem.item_data.name) || STICKER_ITEM_NAME,
          id: variation.id,
          variationName: data.name || '',
          priceCents: effectivePriceCents(data, locationId),
          imageId: imageIdForVariation(data, stickerItem),
          eligibility: variationEligibility(variation, stickerItem, locationId)
        };
      })
    : [];

  const stickerMatches = stickerCandidates.filter(function (candidate) {
    return normalize(candidate.variationName) === 'regular';
  });
  const stickerMatch = stickerMatches.length === 1 ? stickerMatches[0] : null;

  const inventoryIds = parsed.map(function (v) { return v.id; })
    .concat(stickerMatch ? [stickerMatch.id] : []);

  const inventoryMap = {};
  let inventoryError = null;

  if (inventoryIds.length) {
    try {
      const inventory = await square('/v2/inventory/counts/batch-retrieve', token, {
        method: 'POST',
        body: JSON.stringify({
          catalog_object_ids: inventoryIds,
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

  parsed.forEach(function (variation) {
    variation.stock = inventoryMap[variation.id] || 0;
  });

  const grouped = {};
  const colorImageIds = {};

  parsed.forEach(function (variation) {
    const key = variation.color + '|' + variation.size;
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(variation);

    if (variation.imageId && !colorImageIds[variation.color]) {
      colorImageIds[variation.color] = variation.imageId;
    }
  });

  const itemImageId = item.item_data && item.item_data.image_ids && item.item_data.image_ids[0];
  const itemImage = itemImageId ? images[itemImageId] || null : null;
  const variations = [];

  COLORS.forEach(function (color) {
    SIZES.forEach(function (size) {
      const matches = grouped[color + '|' + size] || [];

      if (!matches.length) {
        variations.push({
          color: color,
          size: size,
          available: false,
          stock: 0,
          missing: true
        });
        return;
      }

      const eligibleMatches = matches.filter(function (candidate) {
        return candidate.eligibility.eligible;
      });

      if (eligibleMatches.length > 1) {
        variations.push({
          color: color,
          size: size,
          available: false,
          stock: 0,
          ambiguous: true
        });
        return;
      }

      const v = eligibleMatches[0] || (matches.length === 1 ? matches[0] : null);

      if (!v) {
        variations.push({
          color: color,
          size: size,
          available: false,
          stock: 0,
          ambiguous: true
        });
        return;
      }

      variations.push({
        id: v.id,
        color: color,
        size: size,
        priceCents: v.priceCents,
        price: v.priceCents / 100,
        stock: v.stock,
        available: v.eligibility.eligible && v.stock > 0,
        unavailableAtLocation: !v.eligibility.eligible,
        soldOut: v.eligibility.soldOut,
        image: (v.imageId && images[v.imageId]) ||
          (colorImageIds[color] && images[colorImageIds[color]]) ||
          itemImage
      });
    });
  });

  let teeInventoryStates = [];
  try {
    const allTeeInventory = parsed.length ? await square('/v2/inventory/counts/batch-retrieve', token, {
      method: 'POST',
      body: JSON.stringify({
        catalog_object_ids: parsed.map(function (v) { return v.id; })
      })
    }) : { counts: [] };

    const locationNames = {};
    (location.locations || []).forEach(function (entry) {
      locationNames[entry.id] = entry.name || entry.id;
    });

    teeInventoryStates = (allTeeInventory.counts || []).map(function (count) {
      const variation = parsed.find(function (v) { return v.id === count.catalog_object_id; });
      return {
        variationId: count.catalog_object_id,
        variationName: variation ? variation.name : null,
        color: variation ? variation.color : null,
        size: variation ? variation.size : null,
        state: count.state,
        locationId: count.location_id,
        locationName: locationNames[count.location_id] || count.location_id,
        quantity: Number(count.quantity || 0),
        calculatedAt: count.calculated_at || null,
        isWebsiteLocation: count.location_id === locationId
      };
    });
  } catch (error) {
    console.error('tee location diagnostics failed', error);
  }

  const priced = variations.find(function (v) { return v.priceCents > 0; });

  const stickerStock = stickerMatch ? (inventoryMap[stickerMatch.id] || 0) : 0;
  const sticker = stickerMatch ? {
    id: stickerMatch.id,
    itemId: stickerMatch.itemId,
    name: stickerMatch.itemName,
    variationName: stickerMatch.variationName,
    priceCents: stickerMatch.priceCents,
    price: stickerMatch.priceCents / 100,
    stock: stickerStock,
    available: stickerMatch.eligibility.eligible && stickerStock > 0,
    image: (stickerMatch.imageId && images[stickerMatch.imageId]) || null,
    websiteLocationId: locationId,
    websiteLocationName: location.name
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
        variationCountStructuredColor: parsed.filter(function (v) { return v.usedStructuredColor; }).length,
        variationCountStructuredSize: parsed.filter(function (v) { return v.usedStructuredSize; }).length,
        parsedVariations: parsed.map(function (v) {
          return {
            id: v.id,
            name: v.name,
            color: v.color,
            size: v.size,
            stock: v.stock,
            priceCents: v.priceCents,
            imageId: v.imageId,
            imageResolved: !!(v.imageId && images[v.imageId]),
            usedStructuredColor: v.usedStructuredColor,
            usedStructuredSize: v.usedStructuredSize,
            eligibility: v.eligibility
          };
        }),
        rawVariationParsing: rawVariations.map(function (variation) {
          const data = variation.item_variation_data || {};
          const resolved = parseVariation(data, optionLookup);
          return {
            id: variation.id,
            name: data.name || '',
            resolvedColor: resolved.color,
            resolvedSize: resolved.size,
            usedStructuredColor: resolved.usedStructuredColor,
            usedStructuredSize: resolved.usedStructuredSize,
            imageIds: data.image_ids || []
          };
        }),
        colorImageIds: colorImageIds,
        teeInventoryStates: teeInventoryStates,
        itemOptionCount: Object.keys(optionLookup.options).length,
        imageCount: Object.keys(images).length,
        matchedSquareItem: (item.item_data && item.item_data.name) || null,
        configuredLocationId: configuredLocationId || null,
        resolvedLocationId: locationId,
        resolvedLocationName: location.name,
        locationSource: location.source,
        locations: (location.locations || []).map(function (entry) {
          return { id: entry.id, name: entry.name || entry.id, status: entry.status || null };
        }),
        stickerCandidateCount: stickerCandidates.length,
        stickerRegularMatchCount: stickerMatches.length,
        matchedSticker: stickerMatch ? (stickerMatch.itemName + ' / ' + stickerMatch.variationName) : null,
        inventoryError: inventoryError
      }
    })
  };
};
