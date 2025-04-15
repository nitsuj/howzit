const fetch = require('node-fetch');

exports.handler = async function(event, context) {
  const SQUARE_ACCESS_TOKEN = process.env.SQUARE_TOKEN;
  const SQUARE_LOCATION_ID = process.env.SQUARE_LOCATION_ID;

  try {
    const { cart } = JSON.parse(event.body);

    if (!Array.isArray(cart) || cart.length === 0) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Cart is empty or invalid' })
      };
    }

    const totalQuantity = cart.reduce((sum, item) => sum + item.quantity, 0);

    const shippingCost = totalQuantity === 1
      ? 990  // $9.90 for USPS Flat Rate Envelope
      : 1710; // $17.10 for USPS Flat Rate Medium Box

    const lineItems = cart.map(item => ({
      quantity: item.quantity.toString(),
      catalog_object_id: item.variation_id
    }));

    lineItems.push({
      name: "Shipping",
      quantity: "1",
      base_price_money: {
        amount: shippingCost,
        currency: "USD"
      }
    });

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
          redirect_url: "https://howzitbrewing.square.site/",
          shipping_address_collection: {
            allowed_countries: ["US"]
          }
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
