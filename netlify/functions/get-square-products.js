const fetch = require('node-fetch');

exports.handler = async function (event, context) {
  const SQUARE_ACCESS_TOKEN = process.env.SQUARE_TOKEN;

  try {
    const res = await fetch('https://connect.squareup.com/v2/catalog/list?types=ITEM,IMAGE', {
      headers: {
        Authorization: `Bearer ${SQUARE_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      }
    });

    const catalog = await res.json();
    const all = catalog.objects || [];

    const images = {};
    all.forEach(obj => {
      if (obj.type === 'IMAGE') {
        images[obj.id] = obj.image_data.url;
      }
    });

    const items = all.filter(obj => obj.type === 'ITEM');

    const output = items.map(item => {
      const imageId = item.item_data.image_ids?.[0];
      return {
        id: item.id,
        name: item.item_data.name,
        image: images[imageId] || 'https://via.placeholder.com/300',
        variations: item.item_data.variations?.map(v => ({
          name: v.item_variation_data.name,
          price: v.item_variation_data.price_money?.amount / 100,
        }))
      };
    });

    return {
      statusCode: 200,
      body: JSON.stringify(output, null, 2)
    };

  } catch (err) {
    console.error(err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'API call failed' })
    };
  }
};
