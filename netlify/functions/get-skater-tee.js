const fetch = require('node-fetch');

exports.handler = async function (event) {
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

    // Find the specific item
    const item = objects.find(obj => obj.type === 'ITEM' && obj.id === ITEM_ID);
    if (!item) {
      return {
        statusCode: 404,
        body: JSON.stringify({ error: 'Item not found' }),
      };
    }

    const variations = item.item_data.variations || [];

    // Parse variations to extract color and size
    const parsedVariations = variations.map(variation => {
      const [size, color] = variation.item_variation_data.name.split(',').map(s => s.trim());
      return {
        id: variation.id,
        name: variation.item_variation_data.name,
        price: variation.item_variation_data.price_money?.amount / 100,
        available: true, // Assume available unless inventory data says otherwise
        stock: 0, // Default stock to 0, will update later
        color,
        size,
      };
    });

    // Fetch inventory counts for variations
    const variationIds = parsedVariations.map(v => v.id);
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

    // Map inventory counts to variations
    const inventoryMap = {};
    counts.forEach(entry => {
      inventoryMap[entry.catalog_object_id] = parseInt(entry.quantity, 10);
    });

    const output = parsedVariations.map(variation => ({
      ...variation,
      stock: inventoryMap[variation.id] || 0,
      available: (inventoryMap[variation.id] || 0) > 0,
    }));

    return {
      statusCode: 200,
      body: JSON.stringify({
        id: item.id,
        name: item.item_data.name,
        image: item.item_data.image_ids?.[0] || null, // Replace with actual image logic
        variations: output,
      }),
    };
  } catch (error) {
    console.error('Error fetching Skater Tee:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Failed to fetch item or inventory' }),
    };
  }
};
