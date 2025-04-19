const fetch = require('node-fetch');

exports.handler = async function (event, context) {
  const SQUARE_ACCESS_TOKEN = process.env.SQUARE_TOKEN;
  const ITEM_ID = 'IRBP5IVMIC44HDQXWBFD2PY5'; // Replace with your specific item ID

  try {
    // Fetch catalog data
    const catalogRes = await fetch(
      'https://connect.squareup.com/v2/catalog/list?types=ITEM,IMAGE',
      {
        headers: {
          Authorization: `Bearer ${SQUARE_ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
        },
      }
    );

    const catalog = await catalogRes.json();
    const objects = catalog.objects || [];

    // Map images
    const images = {};
    objects.forEach(obj => {
      if (obj.type === 'IMAGE') {
        images[obj.id] = obj.image_data.url;
      }
    });

    // Find the specific item
    const item = objects.find(obj => obj.type === 'ITEM' && obj.id === ITEM_ID);
    if (!item) {
      return {
        statusCode: 404,
        body: JSON.stringify({ error: 'Item not found' }),
      };
    }

    const imageId = item.item_data.image_ids?.[0];
    const variations = item.item_data.variations || [];

    // Fetch inventory counts for variations
    const variationIds = variations.map(v => v.id);
    const inventoryRes = await fetch(
      'https://connect.squareup.com/v2/inventory/counts/batch-retrieve',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${SQUARE_ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ catalog_object_ids: variationIds }),
      }
    );

    const inventoryData = await inventoryRes.json();
    const counts = inventoryData.counts || [];

    // Map inventory counts
    const inventoryMap = {};
    counts.forEach(entry => {
      inventoryMap[entry.catalog_object_id] = parseInt(entry.quantity, 10);
    });

    // Build the output
    const output = {
      id: item.id,
      name: item.item_data.name,
      image: images[imageId] || null,
      variations: variations.map(v => ({
        id: v.id,
        name: v.item_variation_data.name,
        price: v.item_variation_data.price_money?.amount / 100,
        available: (inventoryMap[v.id] || 0) > 0,
        stock: inventoryMap[v.id] || 0,
        color: v.item_variation_data.name.split(' ')[0], // Assuming color is the first word
        size: v.item_variation_data.name.split(' ')[1], // Assuming size is the second word
      })),
    };

    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
      body: JSON.stringify(output, null, 2),
    };
  } catch (err) {
    console.error(err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Failed to fetch item or inventory' }),
    };
  }
};
