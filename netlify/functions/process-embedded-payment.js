const fetch = require('node-fetch');

exports.handler = async function (event) {
  try {
    // Ensure the request is a POST request
    if (event.httpMethod !== 'POST') {
      return {
        statusCode: 405,
        body: JSON.stringify({ success: false, error: 'Method Not Allowed' }),
      };
    }

    // Parse the request body
    const { cart, buyer, shippingCost } = JSON.parse(event.body);

    // Validate required fields
    if (!cart || !Array.isArray(cart) || cart.length === 0) {
      return {
        statusCode: 400,
        body: JSON.stringify({ success: false, error: 'Cart is empty or invalid' }),
      };
    }

    if (!buyer || !buyer.name || !buyer.email || !buyer.address || !buyer.city || !buyer.state || !buyer.zip) {
      return {
        statusCode: 400,
        body: JSON.stringify({ success: false, error: 'Missing or invalid buyer information' }),
      };
    }

    if (shippingCost === undefined) {
      return {
        statusCode: 400,
        body: JSON.stringify({ success: false, error: 'Missing shipping cost' }),
      };
    }

    // Validate Square credentials
    const SQUARE_ACCESS_TOKEN = process.env.SQUARE_ACCESS_TOKEN;
    const SQUARE_LOCATION_ID = process.env.SQUARE_LOCATION_ID;
    const SQUARE_ENV = process.env.SQUARE_ENV || 'sandbox'; // Default to sandbox if not set

    if (!SQUARE_ACCESS_TOKEN || !SQUARE_LOCATION_ID) {
      return {
        statusCode: 500,
        body: JSON.stringify({ success: false, error: 'Square credentials are not configured' }),
      };
    }

    // Determine the Square API base URL based on the environment
    const SQUARE_API_BASE_URL =
      SQUARE_ENV === 'production'
        ? 'https://connect.squareup.com'
        : 'https://connect.squareupsandbox.com';

    // Map cart items to Square line items
    const lineItems = cart.map(item => {
      if (!item.name || !item.price || !item.quantity) {
        throw new Error('Invalid cart item format');
      }
      return {
        name: item.name,
        quantity: item.quantity.toString(),
        base_price_money: {
          amount: Math.round(item.price * 100), // Convert to cents
          currency: 'USD',
        },
      };
    });

    // Add shipping cost as a line item
    if (shippingCost) {
      lineItems.push({
        name: 'Shipping',
        quantity: '1',
        base_price_money: {
          amount: Math.round(shippingCost * 100), // Convert to cents
          currency: 'USD',
        },
      });
    }

    // Create a checkout link
    const response = await fetch(`${SQUARE_API_BASE_URL}/v2/online-checkout/payment-links`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${SQUARE_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        idempotency_key: `checkout-${Date.now()}`,
        order: {
          location_id: SQUARE_LOCATION_ID,
          line_items: lineItems,
        },
        checkout_options: {
          redirect_url: 'https://nimble-daifuku-613b4c.netlify.app/thank-you', // Replace with your thank-you page URL
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
      console.error('Square API Error:', data);
      return {
        statusCode: response.status,
        body: JSON.stringify({ success: false, error: data.errors || 'Failed to create checkout link' }),
      };
    }

    // Return the checkout URL
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
