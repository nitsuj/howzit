const fetch = require('node-fetch');

exports.handler = async function(event) {
  const { token } = JSON.parse(event.body);
  const SQUARE_TOKEN = process.env.SQUARE_TOKEN;
  const SQUARE_LOCATION_ID = process.env.SQUARE_LOCATION_ID;

  const response = await fetch('https://connect.squareup.com/v2/payments', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SQUARE_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      source_id: token,
      idempotency_key: `payment-${Date.now()}`,
      amount_money: { amount: 3090, currency: "USD" },
      location_id: SQUARE_LOCATION_ID
    })
  });

  const data = await response.json();
  return {
    statusCode: 200,
    body: JSON.stringify({ success: response.ok, data })
  };
};

