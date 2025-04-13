const fetch = require('node-fetch');

exports.handler = async function (event, context) {
  const SQUARE_ACCESS_TOKEN = process.env.SQUARE_TOKEN;

  try {
    const response = await fetch(
      'https://connect.squareup.com/v2/catalog/list?types=CATEGORY',
      {
        headers: {
          Authorization: `Bearer ${SQUARE_ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
        },
      }
    );

    const catalog = await response.json();
    const allObjects = catalog.objects;

    const categories = allObjects.map(obj => ({
      name: obj.category_data.name,
      id: obj.id
    }));

    return {
      statusCode: 200,
      body: JSON.stringify(categories, null, 2)
    };
  } catch (err) {
    console.error(err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Failed to fetch categories' })
    };
  }
};

      (obj) => obj.type === 'CATEGORY' && obj.category_data.name === 'Tees'
    );
    const teesCategoryId = teesCategory?.id;

    if (!teesCategoryId) {
      return {
        statusCode: 404,
        body: JSON.stringify({ error: 'Tees category not found.' }),
      };
    }

    // Get only items from the "Tees" category
    const items = allObjects.filter(
      (obj) =>
        obj.type === 'ITEM' &&
        obj.item_data &&
        obj.item_data.category_id === teesCategoryId
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
