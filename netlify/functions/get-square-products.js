const fetch = require('node-fetch');

exports.handler = async function (event, context) {
  const SQUARE_ACCESS_TOKEN = process.env.SQUARE_TOKEN;

  try {
    const response = await fetch(
      'https://connect.squareup.com/v2/catalog/list?types=ITEM,IMAGE,CATEGORY',
      {
        headers: {
          Authorization: `Bearer ${SQUARE_ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
        },
      }
    );

    const catalog = await response.json();
    const allObjects = catalog.objects;

    // Build image map
    const imageMap = {};
    for (let obj of allObjects) {
      if (obj.type === 'IMAGE') {
        imageMap[obj.id] = obj.image_data.url;
      }
    }

    // Get only items from the "Tees" category
    const items = allObjects.filter(
      (obj) =>
        obj.type === 'ITEM' &&
        obj.item_data &&
        obj.item_data.category_id === RBLASICHDD63MPUYOCMUVWO2
    );

    const output = items.map((item) => ({
      id: item.id,
      name: item.item_data.name,
      image: imageMap[item.item_data.image_ids?.[0]] || null,
      variations: item.item_data.variations?.map((v) => ({
        name: v.item_variation_data.name,
        price: v.item_variation_data.price_money?.amount / 100,
        sku: v.item_variation_data.sku,
      })),
    }));

    return {
      statusCode: 200,
      body: JSON.stringify(output),
    };
  } catch (err) {
    console.error(err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Failed to fetch Square data' }),
    };
  }
};
