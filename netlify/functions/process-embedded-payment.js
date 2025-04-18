const fetch = require('node-fetch');

exports.handler = async function (event) {
  try {
    // Ensure the request is a POST
    if (event.httpMethod !== 'POST') {
      return {
        statusCode: 405,
        body: JSON.stringify({ success: false, error: 'Method Not Allowed' }),
      };
    }

    // Parse the request body
    const { token, cart, buyer } = JSON.parse(event.body);

    // Validate input data
    if (!token || !cart || !buyer) {
      return {
        statusCode: 400,
        body: JSON.stringify({ success: false, error: 'Missing required fields' }),
      };
    }

    if (!Array.isArray(cart) || cart.length === 0) {
      return {
        statusCode: 400,
        body: JSON.stringify({ success: false, error: 'Cart is empty' }),
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

    // Calculate total cart amount
    const totalAmount = cart.reduce((sum, item) => {
      if (!item.price || !item.quantity) {
        throw new Error('Invalid cart item format');
      }
      return sum + item.price * item.quantity;
    }, 0);

    if (totalAmount <= 0) {
      return {
        statusCode: 400,
        body: JSON.stringify({ success: false, error: 'Total amount must be greater than zero' }),
      };
    }

    // Make the payment request to Square
    const response = await fetch('https://connect.squareup.com/v2/payments', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${SQUARE_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        source_id: token,
        idempotency_key: `payment-${Date.now()}`,
        location_id: SQUARE_LOCATION_ID,
        amount_money: {
          amount: Math.round(totalAmount * 100), // Convert dollars to cents
          currency: 'USD',
        },
        shipping_address: {
          address_line_1: buyer.address,
          locality: buyer.city,
          administrative_district_level_1: buyer.state,
          postal_code: buyer.zip,
          country: 'US',
        },
        buyer_email_address: buyer.email,
        billing_address: {
          address_line_1: buyer.address,
          locality: buyer.city,
          administrative_district_level_1: buyer.state,
          postal_code: buyer.zip,
          country: 'US',
        },
        note: `Order from ${buyer.name}`,
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('Square API Error:', data);
      return {
        statusCode: response.status,
        body: JSON.stringify({ success: false, error: data.errors || 'Payment failed' }),
      };
    }

    // Return success response
    return {
      statusCode: 200,
      body: JSON.stringify({ success: true, data }),
    };
  } catch (error) {
    console.error('Payment processing error:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ success: false, error: error.message }),
    };
  }
};
