const assert = require('assert');
const {
  getColor,
  getSize,
  buildOptionLookup,
  parseVariation,
  isObjectPresentAtLocation,
  isSoldOutAtLocation,
  effectivePriceCents,
  variationEligibility
} = require('../netlify/functions/_merch-square');

assert.strictEqual(getColor('Lifeguard'), 'Yellow');
assert.strictEqual(getColor('Mint'), 'Mint');
assert.strictEqual(getColor('Black/Aqua'), 'Black');
assert.strictEqual(getColor('Grey/Blue'), 'Heather Gray');
assert.strictEqual(getColor('Green/Yellow'), null);

assert.strictEqual(getSize('Small'), 'S');
assert.strictEqual(getSize('Medium'), 'M');
assert.strictEqual(getSize('Large'), 'L');
assert.strictEqual(getSize('XL'), 'XL');
assert.strictEqual(getSize('2XL'), '2XL');

const optionObjects = [
  {
    type: 'ITEM_OPTION',
    id: 'SIZE',
    item_option_data: {
      name: 'Size',
      values: [
        { id: 'SIZE_M', item_option_value_data: { name: 'Medium' } }
      ]
    }
  },
  {
    type: 'ITEM_OPTION',
    id: 'COLOR',
    item_option_data: {
      name: 'Color',
      values: [
        { id: 'COLOR_LIFE', item_option_value_data: { name: 'Lifeguard' } },
        { id: 'COLOR_GREENYELLOW', item_option_value_data: { name: 'Green/Yellow' } }
      ]
    }
  }
];

const lookup = buildOptionLookup(optionObjects);
const structured = parseVariation({
  name: 'Medium, Green/Yellow',
  item_option_values: [
    { item_option_id: 'SIZE', item_option_value_id: 'SIZE_M' },
    { item_option_id: 'COLOR', item_option_value_id: 'COLOR_LIFE' }
  ]
}, lookup);

assert.deepStrictEqual(
  { color: structured.color, size: structured.size },
  { color: 'Yellow', size: 'M' }
);
assert.strictEqual(structured.usedStructuredColor, true);
assert.strictEqual(structured.usedStructuredSize, true);

const fallback = parseVariation({ name: 'Medium, Lifeguard' }, { options: {}, values: {} });
assert.deepStrictEqual(
  { color: fallback.color, size: fallback.size },
  { color: 'Yellow', size: 'M' }
);

const rejectedCompound = parseVariation({ name: 'Medium, Green/Yellow' }, { options: {}, values: {} });
assert.strictEqual(rejectedCompound.color, null);
assert.strictEqual(rejectedCompound.size, 'M');

const locationId = 'LOC';
assert.strictEqual(isObjectPresentAtLocation({ present_at_all_locations: true }, locationId), true);
assert.strictEqual(isObjectPresentAtLocation({
  present_at_all_locations: true,
  absent_at_location_ids: [locationId]
}, locationId), false);
assert.strictEqual(isObjectPresentAtLocation({
  present_at_all_locations: false,
  present_at_location_ids: [locationId]
}, locationId), true);

const future = new Date(Date.now() + 60000).toISOString();
const past = new Date(Date.now() - 60000).toISOString();
assert.strictEqual(isSoldOutAtLocation({
  location_overrides: [{ location_id: locationId, sold_out: true }]
}, locationId), true);
assert.strictEqual(isSoldOutAtLocation({
  location_overrides: [{ location_id: locationId, sold_out: true, sold_out_valid_until: past }]
}, locationId), false);
assert.strictEqual(isSoldOutAtLocation({
  location_overrides: [{ location_id: locationId, sold_out: true, sold_out_valid_until: future }]
}, locationId), true);

assert.strictEqual(effectivePriceCents({
  price_money: { amount: 3200 },
  location_overrides: [{ location_id: locationId, price_money: { amount: 3500 } }]
}, locationId), 3500);

const parent = { present_at_all_locations: true };
const variation = {
  present_at_all_locations: true,
  item_variation_data: {
    sellable: true,
    track_inventory: true,
    location_overrides: [{ location_id: locationId, sold_out: false }]
  }
};
assert.strictEqual(variationEligibility(variation, parent, locationId).eligible, true);

console.log('Merch Square mapping tests passed');
