const fetch = require('node-fetch');

const API = 'https://connect.squareup.com';
const VERSION = '2026-09-16';
const ITEM_NAME = 'Howzit Tee';
const STICKER_ITEM_NAME = 'Sticker';
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

function getColor(value) {
  const n = normalize(value);
  const aliases = {
    lifeguard: 'Yellow',
    yellow: 'Yellow',
    mint: 'Mint',
    'black aqua': 'Black',
    black: 'Black',
    'gray blue': 'Heather Gray',
    'heather gray': 'Heather Gray'
  };
  return aliases[n] || null;
}

function getSize(value) {
  const n = normalize(value);
  const aliases = {
    s: 'S',
    small: 'S',
    m: 'M',
    medium: 'M',
    l: 'L',
    large: 'L',
    xl: 'XL',
    xlarge: 'XL',
    'x large': 'XL',
    'extra large': 'XL',
    '2xl': '2XL',
    xxl: '2XL',
    '2x': '2XL',
    '2x large': '2XL',
    '2xlarge': '2XL',
    '2 extra large': '2XL'
  };
  return aliases[n] || null;
}

function buildOptionLookup(objects) {
  const options = {};
  const values = {};

  (objects || []).forEach(function (obj) {
    if (obj.type !== 'ITEM_OPTION' || !obj.item_option_data) return;
    const optionName = obj.item_option_data.name || '';
    options[obj.id] = optionName;

    (obj.item_option_data.values || []).forEach(function (value) {
      const valueData = value.item_option_value_data || {};
      values[value.id] = {
        optionId: obj.id,
        optionName: optionName,
        valueName: valueData.name || ''
      };
    });
  });

  return { options: options, values: values };
}

function parseVariation(data, optionLookup) {
  let color = null;
  let size = null;
  let usedStructuredColor = false;
  let usedStructuredSize = false;

  ((data && data.item_option_values) || []).forEach(function (selection) {
    const optionId = selection.item_option_id || null;
    const valueId = selection.item_option_value_id || null;
    const resolved = valueId && optionLookup && optionLookup.values[valueId];
    const optionName = normalize(
      (resolved && resolved.optionName) ||
      (optionLookup && optionLookup.options[optionId]) ||
      ''
    );
    const valueName = (resolved && resolved.valueName) || '';

    if (optionName.includes('color') || optionName.includes('colour')) {
      const mapped = getColor(valueName);
      if (mapped) {
        color = mapped;
        usedStructuredColor = true;
      }
    } else if (optionName.includes('size')) {
      const mapped = getSize(valueName);
      if (mapped) {
        size = mapped;
        usedStructuredSize = true;
      }
    }
  });

  // Square-generated names are "Size, Color". Keep this only as a fallback
  // for a variation that is missing one of the structured option links.
  if (!color || !size) {
    const parts = String((data && data.name) || '')
      .split(',')
      .map(function (part) { return part.trim(); })
      .filter(Boolean);

    if (!size && parts.length) size = getSize(parts[0]);
    if (!color && parts.length > 1) color = getColor(parts.slice(1).join(','));
  }

  return {
    color: color,
    size: size,
    usedStructuredColor: usedStructuredColor,
    usedStructuredSize: usedStructuredSize
  };
}

function isObjectPresentAtLocation(object, locationId) {
  if (!object || !locationId) return false;

  if (object.present_at_all_locations === false) {
    return (object.present_at_location_ids || []).includes(locationId);
  }

  return !(object.absent_at_location_ids || []).includes(locationId);
}

function getLocationOverride(data, locationId) {
  return ((data && data.location_overrides) || []).find(function (override) {
    return override.location_id === locationId;
  }) || null;
}

function isSoldOutAtLocation(data, locationId, nowMs) {
  const override = getLocationOverride(data, locationId);
  if (!override || override.sold_out !== true) return false;

  if (!override.sold_out_valid_until) return true;
  const validUntil = Date.parse(override.sold_out_valid_until);
  if (!Number.isFinite(validUntil)) return true;
  return validUntil > (nowMs || Date.now());
}

function effectiveTrackInventory(data, locationId) {
  const override = getLocationOverride(data, locationId);
  if (override && typeof override.track_inventory === 'boolean') {
    return override.track_inventory;
  }
  return !!(data && data.track_inventory);
}

function effectivePriceCents(data, locationId) {
  const override = getLocationOverride(data, locationId);
  if (override && override.price_money && override.price_money.amount != null) {
    return Number(override.price_money.amount) || 0;
  }
  return Number((data && data.price_money && data.price_money.amount) || 0);
}

function variationEligibility(variation, parentItem, locationId) {
  const data = variation && variation.item_variation_data;
  const present = isObjectPresentAtLocation(variation, locationId);
  const parentPresent = isObjectPresentAtLocation(parentItem, locationId);
  const sellable = !data || data.sellable !== false;
  const soldOut = isSoldOutAtLocation(data, locationId);
  const trackInventory = effectiveTrackInventory(data, locationId);

  return {
    present: present,
    parentPresent: parentPresent,
    sellable: sellable,
    soldOut: soldOut,
    trackInventory: trackInventory,
    eligible: !!data && present && parentPresent && sellable && !soldOut
  };
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
        detail: e.detail || null,
        field: e.field || null
      };
    });
    throw err;
  }

  return data;
}

async function listCatalog(token, types) {
  let cursor = null;
  const objects = [];
  const typeList = Array.isArray(types) ? types.join(',') : String(types || 'ITEM,IMAGE,ITEM_OPTION');

  do {
    const params = new URLSearchParams({ types: typeList });
    if (cursor) params.set('cursor', cursor);

    const page = await square('/v2/catalog/list?' + params.toString(), token, { method: 'GET' });
    (page.objects || []).forEach(function (obj) { objects.push(obj); });
    cursor = page.cursor || null;
  } while (cursor);

  return objects;
}

async function resolveLocation(token, configuredLocationId) {
  const data = await square('/v2/locations', token, { method: 'GET' });
  const locations = data.locations || [];
  const active = locations.filter(function (location) {
    return location.status === 'ACTIVE';
  });

  if (configuredLocationId) {
    const configured = active.find(function (location) {
      return location.id === configuredLocationId;
    });

    if (configured) {
      return {
        id: configured.id,
        name: configured.name || configured.id,
        configuredId: configuredLocationId,
        source: 'configured',
        locations: locations
      };
    }

    if (active.length === 1) {
      return {
        id: active[0].id,
        name: active[0].name || active[0].id,
        configuredId: configuredLocationId,
        source: 'single-active-fallback',
        locations: locations
      };
    }

    throw new Error('Configured Square location is not an active location');
  }

  if (active.length === 1) {
    return {
      id: active[0].id,
      name: active[0].name || active[0].id,
      configuredId: null,
      source: 'single-active',
      locations: locations
    };
  }

  if (!active.length) throw new Error('No active Square location available');
  throw new Error('Multiple active Square locations; SQUARE_LOCATION_ID is required');
}

module.exports = {
  API,
  VERSION,
  ITEM_NAME,
  STICKER_ITEM_NAME,
  COLORS,
  SIZES,
  normalize,
  getColor,
  getSize,
  buildOptionLookup,
  parseVariation,
  isObjectPresentAtLocation,
  getLocationOverride,
  isSoldOutAtLocation,
  effectiveTrackInventory,
  effectivePriceCents,
  variationEligibility,
  square,
  listCatalog,
  resolveLocation
};
