const fetch = require('node-fetch');

exports.handler = async function (event) {
  try {
    if (event.httpMethod !== 'POST') {
      return {
        statusCode: 405,
        body: JSON.stringify({ success: false, error: 'Method Not Allowed' }),
      };
    }

    const { cart, buyer } = JSON.parse(event.body);

    if (!cart || !buyer) {
      return {
        statusCode: 400,
        body: JSON.stringify({ success: false, error: 'Missing required fields' }),
      };
    }

    const SQUARE_TOKEN = process.env.SQUARE_TOKEN;
    const SQUARE_LOCATION_ID = process.env.SQUARE_LOCATION_ID;

    if (!SQUARE_TOKEN || !SQUARE_LOCATION_ID) {
      return {
        statusCode: 500,
        body: JSON.stringify({ success: false, error: 'Square credentials are not configured' }),
      };
    }

    // Calculate total amount
    const totalAmount = cart.reduce((sum, item) => {
      return sum + item.price * item.quantity;
    }, 0);

    // Create a checkout link
    const response = await fetch(`https://connect.squareup.com/v2/online-checkout/payment-links`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${SQUARE_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        idempotency_key: `checkout-${Date.now()}`,
        order: {
          location_id: SQUARE_LOCATION_ID,
          line_items: cart.map(item => ({
            name: item.name,
            quantity: item.quantity.toString(),
            base_price_money: {
              amount: Math.round(item.price * 100), // Convert to cents
              currency: 'USD',
            },
          })),
        },
        checkout_options: {
          redirect_url: 'https://your-site.com/thank-you', // Replace with your thank-you page URL
        },
        customer: {
          email_address: buyer.email,
          given_name: buyer.name,
          address: {
            address_line_1: buyer.address,
            locality: buyer.city,
            administrative_district_level_1: buyer.state,
            postal_code: buyer.zip,
            country: 'US',
          },
        },
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      return {
        statusCode: response.status,
        body: JSON.stringify({ success: false, error: data.errors || 'Failed to create checkout link' }),
      };
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ success: true, checkout_url: data.payment_link.url }),
    };
  } catch (error) {
    console.error('Error creating checkout link:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ success: false, error: error.message }),
    };
  }
};
