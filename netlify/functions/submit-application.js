const fetch = require('node-fetch');

const QUESTIONS = [
  {
    key: 'beer_scene',
    label: 'What excites you the most in the current beer/brewing scene?'
  },
  {
    key: 'favorite_beer',
    label: 'What is your current favorite beer from any brewery, and why?'
  },
  {
    key: 'favorite_style',
    label: 'What is your favorite style of beer to brew, and why?'
  },
  {
    key: 'favorite_hop',
    label: 'What is your favorite hop, and why?'
  },
  {
    key: 'process_vs_materials',
    label: 'Do you think process or quality of raw materials has a bigger effect on the finished product, and why? And while we all know the real answer is both, you have got to choose one here.'
  },
  {
    key: 'recipe_design',
    label: 'Briefly describe your thought process when designing a recipe for a new beer.'
  },
  {
    key: 'do_more',
    label: 'What would you like to do more of that you cannot at your current or most recent brewery?'
  },
  {
    key: 'efficiency',
    label: 'What ONE THING do you think the average brewery producing under 2,000 bbl/year can do to increase efficiency?'
  }
];

const MAX_FILE_BYTES = 1.5 * 1024 * 1024;
const MAX_TOTAL_FILE_BYTES = 2.5 * 1024 * 1024;
const ALLOWED_EXTENSIONS = new Set(['pdf', 'doc', 'docx']);

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

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function clean(value) {
  return String(value == null ? '' : value).trim();
}

function filenameExtension(filename) {
  const match = clean(filename).toLowerCase().match(/\.([a-z0-9]+)$/);
  return match ? match[1] : '';
}

function safeFilename(filename, fallback) {
  const raw = clean(filename) || fallback;
  return raw
    .replace(/[\\/]+/g, '-')
    .replace(/[^a-zA-Z0-9._() -]+/g, '')
    .slice(0, 160) || fallback;
}

function validateAttachment(file, required, label) {
  if (!file) {
    if (required) throw new Error(label + ' is required.');
    return null;
  }

  const filename = safeFilename(file.filename, label.replace(/\s+/g, '-') + '.pdf');
  const ext = filenameExtension(filename);

  if (!ALLOWED_EXTENSIONS.has(ext)) {
    throw new Error(label + ' must be a PDF, DOC, or DOCX file.');
  }

  const content = clean(file.content);
  if (!content) throw new Error(label + ' file data is missing.');

  let bytes;
  try {
    bytes = Buffer.from(content, 'base64');
  } catch (error) {
    throw new Error(label + ' could not be read.');
  }

  if (!bytes.length) throw new Error(label + ' is empty.');
  if (bytes.length > MAX_FILE_BYTES) {
    throw new Error(label + ' must be 1.5 MB or smaller.');
  }

  const contentTypeByExt = {
    pdf: 'application/pdf',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  };

  return {
    filename,
    content: bytes.toString('base64'),
    content_type: contentTypeByExt[ext],
    bytes: bytes.length
  };
}

function buildEmail(application) {
  const subject = 'BREWER APPLICATION — ' + application.name;

  const text = [
    'BREWER APPLICATION',
    '',
    'Name: ' + application.name,
    'Email: ' + application.email,
    'Phone: ' + application.phone,
    'Current location: ' + application.location,
    '',
    ...QUESTIONS.flatMap(function (question) {
      return [
        question.label,
        application.answers[question.key],
        ''
      ];
    }),
    application.coverLetter ? 'Cover letter: attached' : 'Cover letter: not provided',
    'Resume: attached'
  ].join('\n');

  const answersHtml = QUESTIONS.map(function (question) {
    return [
      '<div style="margin:0 0 26px">',
      '<p style="margin:0 0 7px;font-weight:700">' + escapeHtml(question.label) + '</p>',
      '<div style="white-space:pre-wrap;line-height:1.55">' +
        escapeHtml(application.answers[question.key]) +
      '</div>',
      '</div>'
    ].join('');
  }).join('');

  const html = [
    '<div style="font-family:Arial,sans-serif;max-width:720px;margin:auto;color:#111">',
    '<h1 style="margin:0 0 22px">Brewer Application</h1>',
    '<p><strong>Name:</strong> ' + escapeHtml(application.name) + '<br>',
    '<strong>Email:</strong> ' + escapeHtml(application.email) + '<br>',
    '<strong>Phone:</strong> ' + escapeHtml(application.phone) + '<br>',
    '<strong>Current location:</strong> ' + escapeHtml(application.location) + '</p>',
    '<hr style="margin:28px 0">',
    answersHtml,
    '<hr style="margin:28px 0">',
    '<p><strong>Resume:</strong> attached<br>',
    '<strong>Cover letter:</strong> ' + (application.coverLetter ? 'attached' : 'not provided') + '</p>',
    '</div>'
  ].join('');

  return { subject, text, html };
}

async function sendEmail(application) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error('RESEND_API_KEY is not configured');

  const to = clean(process.env.APPLICATION_TO_EMAIL) || 'justin@howzitbrewing.com';
  const from = clean(process.env.APPLICATION_FROM_EMAIL) ||
    'Howzit Applications <applications@notify.howzitbrewing.com>';

  const email = buildEmail(application);
  const attachments = [
    {
      filename: application.resume.filename,
      content: application.resume.content,
      content_type: application.resume.content_type
    }
  ];

  if (application.coverLetter) {
    attachments.push({
      filename: application.coverLetter.filename,
      content: application.coverLetter.content,
      content_type: application.coverLetter.content_type
    });
  }

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + apiKey,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from,
      to: [to],
      reply_to: application.email,
      subject: email.subject,
      html: email.html,
      text: email.text,
      attachments
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

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (error) {
    return json(400, { error: 'Invalid application data.' });
  }

  // Simple honeypot. Bots that fill hidden fields get a harmless success response.
  if (clean(body.website)) {
    return json(200, { ok: true });
  }

  const name = clean(body.name);
  const email = clean(body.email);
  const phone = clean(body.phone);
  const location = clean(body.location);

  if (!name || !email || !phone || !location) {
    return json(400, { error: 'Please complete all contact fields.' });
  }

  if (!/^\S+@\S+\.\S+$/.test(email)) {
    return json(400, { error: 'Please enter a valid email address.' });
  }

  const answers = {};
  for (const question of QUESTIONS) {
    const answer = clean(body.answers && body.answers[question.key]);
    if (!answer) {
      return json(400, { error: 'Please answer every questionnaire field.' });
    }
    if (answer.length > 6000) {
      return json(400, { error: 'Please keep each response under 6,000 characters.' });
    }
    answers[question.key] = answer;
  }

  let resume;
  let coverLetter;

  try {
    resume = validateAttachment(body.resume, true, 'Resume');
    coverLetter = validateAttachment(body.coverLetter, false, 'Cover letter');
  } catch (error) {
    return json(400, { error: error.message });
  }

  if ((resume.bytes + (coverLetter ? coverLetter.bytes : 0)) > MAX_TOTAL_FILE_BYTES) {
    return json(400, { error: 'Combined attachment size must be 2.5 MB or smaller.' });
  }

  try {
    const result = await sendEmail({
      name,
      email,
      phone,
      location,
      answers,
      resume,
      coverLetter
    });

    return json(200, {
      ok: true,
      emailId: result && result.id ? result.id : null
    });
  } catch (error) {
    console.error('submit-application failed', {
      message: error && error.message,
      details: error && error.details ? error.details : null,
      applicantEmail: email
    });

    return json(502, {
      error: 'We could not send your application right now. Please try again.'
    });
  }
};
