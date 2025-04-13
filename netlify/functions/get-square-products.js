const fetch = require('node-fetch');

exports.handler = async function (event, context) {
  const SQUARE_ACCESS_TOKEN = process.env.SQUARE_TOKEN;

  try {
    const response = await fetch(
      'https://connect.squareup.com/v2/catalog/list?types=ITEM,IMAGE',
      {
        headers: {
          Authorization: `Bearer ${SQUARE_ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
        }
      }
    );

    const catalog = await response.json();
    const allObjects = catalog.objects || [];

    const imageMap = {};
    allObjects.forEach(obj => {
      if (obj.type === 'IMAGE') {
        imageMap[obj.id] = obj.image_data?.url;
      }
    });

    const items = allObjects.filter(obj => obj.type === 'ITEM');

    const output = items.map(item => ({
      id: item.id,
      name: item.item_data.name,
      image: imageMap[item.item_data.image_ids?.[0]] || null,
      category_id: item.item_data.category_id,
      variations: item.item_data.variations?.map(v => ({
        name: v.item_variation_data.name,
        price: v.item_variation_data.price_money?.amount / 100,
      }))
    }));

    return {
      statusCode: 200,
      body: JSON.stringify(output, null, 2)
    };
  } catch (err) {
    console.error(err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Failed to fetch Square data' })
    };
  }
};

