const fetch = require('node-fetch');

const TAPLIST_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vQEukzGVD6WDGAlK8qHFchTCs9oMs9LKbwkXRSzJBDa_vjMCxLWJhPKJvNTbQakGVPn9uZO5_Zi4wpd/pub?gid=0&single=true&output=csv';

exports.handler = async function () {
  try {
    const response = await fetch(`${TAPLIST_URL}&_=${Date.now()}`, {
      headers: { 'User-Agent': 'HowzitBrewing/1.0' },
    });

    if (!response.ok) {
      return {
        statusCode: response.status,
        headers: { 'Cache-Control': 'no-store, max-age=0' },
        body: `Google Sheet returned HTTP ${response.status}`,
      };
    }

    let csv = await response.text();

    // Keep the team-facing sheet forgiving. The website currently expects
    // the internal field name `to_go`, but the sheet may use the clearer
    // heading `cans`. A handful of obvious variants are accepted too.
    const lineBreak = csv.indexOf('\n');
    const headerLine = lineBreak >= 0 ? csv.slice(0, lineBreak) : csv;
    const rest = lineBreak >= 0 ? csv.slice(lineBreak) : '';

    const headers = headerLine.split(',');
    const hasToGo = headers.some((h) => h.trim().toLowerCase() === 'to_go');

    if (!hasToGo) {
      const aliases = new Set([
        'cans',
        'can',
        'cans_available',
        'cans available',
        'to go',
        'togo',
      ]);

      const normalized = headers.map((header) => {
        const clean = header.trim().toLowerCase();
        return aliases.has(clean) ? 'to_go' : header;
      });
      csv = normalized.join(',') + rest;
    }

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Cache-Control': 'no-store, max-age=0',
      },
      body: csv,
    };
  } catch (error) {
    console.error('Taplist proxy failed:', error);
    return {
      statusCode: 502,
      headers: { 'Cache-Control': 'no-store, max-age=0' },
      body: 'Unable to load tap list.',
    };
  }
};
