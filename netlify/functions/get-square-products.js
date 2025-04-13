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
        }
      }
    );

    const catalog = await response.json();

    const categories = catalog.objects.map(obj => ({
      id: obj.id,
      name: obj.category_data.name
    }));

    return {
      statusCode: 200,
      body: JSON.stringify(categories, null, 2)
    };
  } catch (err) {
    console.error('Error fetching categories:', err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Failed to fetch categories' })
    };
  }
};
