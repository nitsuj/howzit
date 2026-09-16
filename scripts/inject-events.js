const fs = require('fs');
const path = require('path');

const file = path.join(process.cwd(), 'index.html');
let html = fs.readFileSync(file, 'utf8');
const tag = '<script src="/events.js" defer></script>';

if (!html.includes(tag)) {
  html = html.replace('</body>', `  ${tag}\n</body>`);
}

const aboutStyles = `
    #about { background:var(--pink); }
    #about .about-grid { display:grid;grid-template-columns:.7fr 1.3fr;gap:clamp(28px,6vw,90px);align-items:start;max-width:1300px;margin:auto; }
    #about .section-title { color:var(--purple); }
    .about-copy { background:var(--white);border:var(--border);border-radius:24px;box-shadow:6px 6px 0 var(--ink);padding:clamp(24px,4vw,42px);font-size:clamp(1.1rem,1.8vw,1.45rem);font-weight:700;line-height:1.5; }
    .about-copy p { margin:0; }
    @media (max-width:700px) {
      #about { padding:34px 14px 42px; }
      #about .about-grid { grid-template-columns:1fr;gap:18px; }
      #about .section-title { font-size:clamp(2.8rem,14vw,4.4rem);line-height:.9; }
      .about-copy { padding:18px;border-radius:18px;box-shadow:3px 3px 0 var(--ink);font-size:.95rem; }
    }
`;

if (!html.includes('#about { background:var(--pink); }')) {
  html = html.replace('  </style>', `${aboutStyles}  </style>`);
}

const aboutSection = `
    <section class="section" id="about">
      <div class="about-grid">
        <h2 class="display section-title">About</h2>
        <div class="about-copy">
          <p>Howzit is a small craft brewery and community hub in the heart of Kakaʻako, Honolulu. We keep things fresh with a constantly rotating lineup of beers, along with a regular mix of events and community happenings. Stop by before, during, or after whatever brings you to the neighborhood and soak up some craft beer and good vibes.</p>
        </div>
      </div>
    </section>

`;

if (!html.includes('id="about"')) {
  html = html.replace('    <section id="visit">', `${aboutSection}    <section id="visit">`);
}

if (!html.includes('href="#about"')) {
  html = html.replace('      <a href="#visit">Visit</a>', '      <a href="#about">About</a>\n      <a href="#visit">Visit</a>');
}

fs.writeFileSync(file, html);
