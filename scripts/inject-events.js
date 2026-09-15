const fs = require('fs');
const path = require('path');

const file = path.join(process.cwd(), 'index.html');
let html = fs.readFileSync(file, 'utf8');
const tag = '<script src="/events.js" defer></script>';

if (!html.includes(tag)) {
  html = html.replace('</body>', `  ${tag}\n</body>`);
  fs.writeFileSync(file, html);
}
