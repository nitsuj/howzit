const fetch = require('node-fetch');

exports.handler = async function(event) {
  try {
    const { token, cart, buyer } = JSON.parse(event.body);

    const SQUARE_TOKEN = process.env.SQUARE_TOKEN;
    const SQUARE_LOCATION_ID = process.env.SQUARE_LOCATION_ID;

    // Calculate total cart amount
    const totalAmount = cart.reduce((sum, item) => {
      return sum + (item.price * item.quantity);
    }, 0);

    const response = await fetch('https://connect.squareup.com/v2/payments', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${SQUARE_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        source_id: token,
        idempotency_key: `payment-${Date.now()}`,
        location_id: SQUARE_LOCATION_ID,
        amount_money: {
          amount: Math.round(totalAmount * 100), // Convert dollars to cents
          currency: 'USD'
        },
        shipping_address: {
          address_line_1: buyer.address,
          locality: buyer.city,
          administrative_district_level_1: buyer.state,
          postal_code: buyer.zip,
          country: 'US'
        },
        buyer_email_address: buyer.email,
        billing_address: {
          address_line_1: buyer.address,
          locality: buyer.city,
          administrative_district_level_1: buyer.state,
          postal_code: buyer.zip,
          country: 'US'
        },
        note: `Order from ${buyer.name}`
      })
    });

    const data = await response.json();

    return {
      statusCode: 200,
      body: JSON.stringify({ success: response.ok, data })
    };
  } catch (error) {
    console.error('Payment error:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ success: false, error: error.message })
    };
  }
};

