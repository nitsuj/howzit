const fetch = require('node-fetch');

exports.handler = async function(event, context) {
  const SQUARE_ACCESS_TOKEN = process.env.SQUARE_TOKEN;

  try {
    const response = await fetch('https://connect.squareup.com/v2/catalog/list', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${SQUARE_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      }
    });

    const catalog = await response.json();

    const items = catalog.objects.filter(obj => obj.type === 'ITEM');

    const output = items.map(item => ({
      id: item.id,
      name: item.item_data.name,
      image: item.item_data.image_url,
      variations: item.item_data.variations?.map(v => ({
        name: v.item_variation_data.name,
        price: v.item_variation_data.price_money?.amount / 100,
        sku: v.item_variation_data.sku,
        available: true
      }))
    }));

    return {
      statusCode: 200,
      body: JSON.stringify(output)
    };
  } catch (err) {
    console.error(err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Failed to fetch Square data' })
    };
  }
};
