const fetch = require('node-fetch');

exports.handler = async function (event) {
  const SQUARE_ACCESS_TOKEN = process.env.SQUARE_TOKEN;

  try {
    // Fetch catalog data from Square
    const response = await fetch(
      'https://connect.squareup.com/v2/catalog/list?types=ITEM,IMAGE',
      {
        headers: {
          Authorization: `Bearer ${SQUARE_ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
        },
      }
    );

    if (!response.ok) {
      throw new Error(`Square API error: ${response.statusText}`);
    }

    const catalog = await response.json();
    const allObjects = catalog.objects || [];

    // Separate images and items
    const images = {};
    allObjects.forEach(obj => {
      if (obj.type === 'IMAGE') {
        images[obj.id] = obj.image_data.url;
      }
    });

    const items = allObjects.filter(obj => obj.type === 'ITEM');

    // Map items to a simplified structure
    const output = items.map(item => {
      const imageId = item.item_data.image_ids?.[0];
      return {
        id: item.id,
        name: item.item_data.name,
        image: images[imageId] || 'https://via.placeholder.com/300',
        variations: item.item_data.variations?.map(variation => ({
          id: variation.id,
          name: variation.item_variation_data.name,
          price: variation.item_variation_data.price_money?.amount / 100,
        })),
      };
    });

    return {
      statusCode: 200,
      body: JSON.stringify(output, null, 2),
    };
  } catch (error) {
    console.error('Error fetching Square products:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Failed to fetch Square data' }),
    };
  }
};
