const crypto = require('crypto');
const fetch = require('node-fetch');
const { square } = require('./_merch-square');

const WEB_MERCH_REFERENCE = 'HOWZIT-WEB-MERCH';
const DEFAULT_NOTIFICATION_URL = 'https://www.howzitbrewing.com/.netlify/functions/square-webhook';
const DEFAULT_RECIPIENTS = [
  'justin@howzitbrewing.com',
  'grant@howzitbrewing.com'
];

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store'
    },
    body: JSON.stringify(body)
  };
}

function header(event, name) {
  const headers = event.headers || {};
  return headers[name] || headers[name.toLowerCase()] || headers[name.toUpperCase()] || '';
}

function isValidSquareSignature(rawBody, signature, signatureKey, notificationUrl) {
  if (!rawBody || !signature || !signatureKey || !notificationUrl) return false;

  const expected = crypto
    .createHmac('sha256', signatureKey)
    .update(notificationUrl + rawBody)
    .digest('base64');

  const a = Buffer.from(expected);
  const b = Buffer.from(signature);

  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function money(moneyObject) {
  const amount = Number(moneyObject && moneyObject.amount);
  if (!Number.isFinite(amount)) return '';
  return '$' + (amount / 100).toFixed(2);
}

function shipmentRecipient(order) {
  const fulfillment = ((order && order.fulfillments) || []).find(function (entry) {
    return entry && entry.type === 'SHIPMENT' && entry.shipment_details;
  });

  return fulfillment && fulfillment.shipment_details
    ? fulfillment.shipment_details.recipient || null
    : null;
}

function formatAddress(address) {
  if (!address) return '';

  return [
    address.address_line_1,
    address.address_line_2,
    address.address_line_3,
    [
      address.locality,
      address.administrative_district_level_1,
      address.postal_code
    ].filter(Boolean).join(', ').replace(', ' + (address.postal_code || ''), ' ' + (address.postal_code || '')),
    address.country
  ].filter(Boolean).join('\n');
}

function lineItemText(line) {
  const quantity = line.quantity || '1';
  const variation = line.variation_name ? ' — ' + line.variation_name : '';
  return quantity + ' × ' + (line.name || 'Item') + variation;
}

function buildEmail(order, payment) {
  const recipient = shipmentRecipient(order);
  const address = recipient && recipient.address ? formatAddress(recipient.address) : '';
  const lines = (order.line_items || []).map(lineItemText);
  const orderId = order.id || payment.order_id || '';
  const shortOrderId = orderId ? orderId.slice(-8) : '';
  const total = money(order.total_money || payment.amount_money);

  const subject = 'WEB ORDER' + (shortOrderId ? ' #' + shortOrderId : '') +
    (total ? ' — ' + total : '');

  const text = [
    'NEW HOWZIT WEB ORDER',
    '',
    lines.join('\n'),
    '',
    total ? 'Total: ' + total : '',
    '',
    recipient && recipient.display_name ? 'Ship to: ' + recipient.display_name : 'Ship to: See Square',
    recipient && recipient.email_address ? 'Email: ' + recipient.email_address : '',
    recipient && recipient.phone_number ? 'Phone: ' + recipient.phone_number : '',
    address,
    '',
    'Square order: ' + orderId,
    'Square payment: ' + (payment.id || '')
  ].filter(Boolean).join('\n');

  const itemsHtml = lines.length
    ? '<ul>' + lines.map(function (line) { return '<li>' + escapeHtml(line) + '</li>'; }).join('') + '</ul>'
    : '<p>See Square for order items.</p>';

  const html = [
    '<div style="font-family:Arial,sans-serif;max-width:640px;margin:auto;color:#111">',
    '<h1 style="margin:0 0 18px">New Howzit Web Order</h1>',
    itemsHtml,
    total ? '<p style="font-size:20px"><strong>Total: ' + escapeHtml(total) + '</strong></p>' : '',
    '<hr>',
    '<h2>Ship to</h2>',
    recipient && recipient.display_name ? '<p><strong>' + escapeHtml(recipient.display_name) + '</strong></p>' : '<p><strong>See Square</strong></p>',
    recipient && recipient.email_address ? '<p>Email: ' + escapeHtml(recipient.email_address) + '</p>' : '',
    recipient && recipient.phone_number ? '<p>Phone: ' + escapeHtml(recipient.phone_number) + '</p>' : '',
    address ? '<p style="white-space:pre-line">' + escapeHtml(address) + '</p>' : '',
    '<hr>',
    '<p><strong>Square order:</strong> ' + escapeHtml(orderId) + '<br>',
    '<strong>Square payment:</strong> ' + escapeHtml(payment.id || '') + '</p>',
    '</div>'
  ].join('');

  return { subject, text, html };
}

async function sendEmail(email, paymentId) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error('RESEND_API_KEY is not configured');

  const from = process.env.MERCH_ALERT_FROM_EMAIL ||
    'Howzit Web Orders <orders@howzitbrewing.com>';

  const recipients = String(process.env.MERCH_ALERT_TO_EMAILS || DEFAULT_RECIPIENTS.join(','))
    .split(',')
    .map(function (value) { return value.trim(); })
    .filter(Boolean);

  if (!recipients.length) throw new Error('No merch alert recipients configured');

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + apiKey,
      'Content-Type': 'application/json',
      'Idempotency-Key': 'square-web-order/' + paymentId
    },
    body: JSON.stringify({
      from,
      to: recipients,
      subject: email.subject,
      html: email.html,
      text: email.text
    })
  });

  const data = await response.json().catch(function () { return {}; });

  if (!response.ok) {
    const error = new Error('Resend API ' + response.status);
    error.details = data;
    throw error;
  }

  return data;
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'Method not allowed' });
  }

  const rawBody = event.body || '';
  const signature = header(event, 'x-square-hmacsha256-signature');
  const signatureKey = process.env.SQUARE_WEBHOOK_SIGNATURE_KEY;
  const notificationUrl = process.env.SQUARE_WEBHOOK_NOTIFICATION_URL ||
    DEFAULT_NOTIFICATION_URL;

  if (!isValidSquareSignature(rawBody, signature, signatureKey, notificationUrl)) {
    return json(401, { error: 'Invalid Square signature' });
  }

  let webhook;
  try {
    webhook = JSON.parse(rawBody);
  } catch (error) {
    return json(400, { error: 'Invalid JSON' });
  }

  if (webhook.type !== 'payment.updated') {
    return json(200, { ignored: true });
  }

  const payment = webhook &&
    webhook.data &&
    webhook.data.object &&
    webhook.data.object.payment;

  if (!payment || payment.status !== 'COMPLETED') {
    return json(200, { ignored: true });
  }

  // A refund or later refund-related payment update is not a new order.
  if (Number(payment.refunded_money && payment.refunded_money.amount || 0) > 0) {
    return json(200, { ignored: true, reason: 'Refunded payment update' });
  }

  if (!String(payment.note || '').startsWith('Howzit website merch:')) {
    return json(200, { ignored: true });
  }

  if (!payment.order_id) {
    return json(200, { ignored: true, reason: 'No Square order ID' });
  }

  const token = process.env.SQUARE_ACCESS_TOKEN;
  if (!token) {
    console.error('square-webhook: SQUARE_ACCESS_TOKEN missing');
    return json(500, { error: 'Square access token is not configured' });
  }

  try {
    const orderResponse = await square(
      '/v2/orders/' + encodeURIComponent(payment.order_id),
      token,
      { method: 'GET' }
    );

    const order = orderResponse.order;

    if (!order || order.reference_id !== WEB_MERCH_REFERENCE) {
      return json(200, { ignored: true, reason: 'Not a web merch order' });
    }

    const email = buildEmail(order, payment);
    const emailResult = await sendEmail(email, payment.id);

    return json(200, {
      ok: true,
      emailId: emailResult && emailResult.id ? emailResult.id : null
    });
  } catch (error) {
    console.error('square-webhook fulfillment email failed', {
      message: error && error.message,
      details: error && error.details ? error.details : null,
      eventId: webhook.event_id || null,
      paymentId: payment.id || null,
      orderId: payment.order_id || null
    });

    return json(500, { error: 'Fulfillment alert failed' });
  }
};
