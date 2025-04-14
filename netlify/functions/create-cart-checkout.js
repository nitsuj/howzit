
const fetch = require('node-fetch');

exports.handler = async function(event, context) {
  const SQUARE_ACCESS_TOKEN = process.env.SQUARE_TOKEN;
  const SQUARE_LOCATION_ID = process.env.SQUARE_LOCATION_ID;

  try {
    const { cart } = JSON.parse(event.body); // Expecting an array of { variation_id, quantity }

    if (!Array.isArray(cart) || cart.length === 0) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Cart is empty or invalid' })
      };
    }

    const lineItems = cart.map(item => ({
      quantity: item.quantity.toString(),
      catalog_object_id: item.variation_id
    }));

    const response = await fetch("https://connect.squareup.com/v2/online-checkout/payment-links", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${SQUARE_ACCESS_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        idempotency_key: `cart-${Date.now()}`,
        order: {
          location_id: SQUARE_LOCATION_ID,
          line_items: lineItems
        },
        checkout_options: {
          redirect_url: "https://howzitbrewing.square.site/"
        }
      })
    });

    const data = await response.json();

    if (!response.ok) {
      console.error("Square API error:", data);
      return {
        statusCode: 500,
        body: JSON.stringify({ error: data })
      };
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ url: data.payment_link.url })
    };

  } catch (err) {
    console.error("Cart checkout function error:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Internal server error" })
    };
  }
};
