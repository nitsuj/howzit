// netlify/functions/process-payment.js

const { Client, Environment } = require('square');
require('dotenv').config();

const client = new Client({
  environment: Environment.Production,
  accessToken: process.env.SQUARE_ACCESS_TOKEN,
});

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const { nonce, amount, email } = JSON.parse(event.body);

    const response = await client.paymentsApi.createPayment({
      sourceId: nonce,
      amountMoney: {
        amount: parseInt(amount), // amount in cents
        currency: 'USD',
      },
      idempotencyKey: crypto.randomUUID(),
      buyerEmailAddress: email,
    });

    return {
      statusCode: 200,
      body: JSON.stringify({ success: true, payment: response.result }),
    };
  } catch (error) {
    return {
      statusCode: 500,
      body: JSON.stringify({ success: false, error: error.message }),
    };
  }
};
