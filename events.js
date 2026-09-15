(() => {
  const EVENTS_ENDPOINT = '/data/events.csv';
  const HAWAII_TZ = 'Pacific/Honolulu';
  const MAX_CARDS = 4;

  const esc = (v = '') => String(v).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));

  function parseCSV(text) {
    const rows = [];
    let row = [], field = '', quoted = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i], n = text[i + 1];
      if (c === '"' && quoted && n === '"') { field += '"'; i++; continue; }
      if (c === '"') { quoted = !quoted; continue; }
      if (c === ',' && !quoted) { row.push(field); field = ''; continue; }
      if ((c === '\n' || c === '\r') && !quoted) {
        if (c === '\r' && n === '\n') i++;
        row.push(field); field = '';
        if (row.some((v) => v.trim() !== '')) rows.push(row);
        row = [];
        continue;
      }
      field += c;
    }
    row.push(field);
    if (row.some((v) => v.trim() !== '')) rows.push(row);
    if (!rows.length) return [];
    const headers = rows.shift().map((h) => h.trim().toLowerCase().replace(/\s+/g, '_'));
    return rows.map((r) => Object.fromEntries(headers.map((h, i) => [h, (r[i] ?? '').trim()])));
  }

  function hawaiiNowParts() {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: HAWAII_TZ,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false
    }).formatToParts(new Date());
    const get = (type) => Number(parts.find((p) => p.type === type)?.value || 0);
    return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour'), minute: get('minute') };
  }

  function dateKey(d) {
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  }

  function parseDate(value) {
    const s = String(value || '').trim();
    if (!s) return null;
    let m;
    if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) {
      return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
    }
    if ((m = s.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})$/))) {
      let y = Number(m[3]);
      if (y < 100) y += 2000;
      return new Date(Date.UTC(y, Number(m[1]) - 1, Number(m[2])));
    }
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) return null;
    return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  }

  function parseTime(value) {
    const s = String(value || '').trim().toLowerCase();
    if (!s) return null;
    const m = s.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
    if (!m) return null;
    let hour = Number(m[1]);
    const minute = Number(m[2] || 0);
    const suffix = m[3];
    if (suffix) {
      if (hour === 12) hour = 0;
      if (suffix === 'pm') hour += 12;
    }
    if (hour > 23 || minute > 59) return null;
    return { hour, minute };
  }

  function isExplicitlyOff(v) {
    return /^(false|no|n|0|off)$/i.test(String(v || '').trim());
  }

  const dayMap = {
    sunday: 0, sun: 0,
    monday: 1, mon: 1,
    tuesday: 2, tue: 2, tues: 2,
    wednesday: 3, wed: 3,
    thursday: 4, thu: 4, thur: 4, thurs: 4,
    friday: 5, fri: 5,
    saturday: 6, sat: 6
  };
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const dayShort = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
  const monthShort = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

  function skipSet(row) {
    const raw = row.skip_dates || row.skip_date || '';
    return new Set(String(raw).split(/[;,|]+/).map((v) => parseDate(v)).filter(Boolean).map(dateKey));
  }

  function nextRecurringDate(row, now) {
    const dayRaw = String(row.day || '').trim().toLowerCase();
    const target = dayMap[dayRaw];
    if (target === undefined) return null;
    const today = new Date(Date.UTC(now.year, now.month - 1, now.day));
    let delta = (target - today.getUTCDay() + 7) % 7;
    const eventTime = parseTime(row.time);
    if (delta === 0 && eventTime) {
      if (now.hour > eventTime.hour || (now.hour === eventTime.hour && now.minute >= eventTime.minute)) delta = 7;
    }
    const skipped = skipSet(row);
    for (let i = 0; i < 16; i++) {
      const d = new Date(today);
      d.setUTCDate(d.getUTCDate() + delta + (i * 7));
      if (!skipped.has(dateKey(d))) return d;
    }
    return null;
  }

  function formatDate(d) {
    return `${dayShort[d.getUTCDay()]} · ${monthShort[d.getUTCMonth()]} ${d.getUTCDate()}`;
  }

  function normalizeEvents(rows) {
    const now = hawaiiNowParts();
    const today = new Date(Date.UTC(now.year, now.month - 1, now.day));
    const recurring = [];
    const oneOff = [];

    rows.forEach((row) => {
      const name = row.event || row.name || row.title;
      if (!name || isExplicitlyOff(row.active)) return;
      const explicitDate = parseDate(row.date);
      if (explicitDate) {
        if (explicitDate < today) return;
        oneOff.push({ ...row, event: name, eventDate: explicitDate, recurring: false });
        return;
      }
      const next = nextRecurringDate(row, now);
      if (!next) return;
      const target = dayMap[String(row.day || '').trim().toLowerCase()];
      recurring.push({ ...row, event: name, eventDate: next, recurring: true, recurringDay: dayNames[target] });
    });

    recurring.sort((a, b) => a.eventDate - b.eventDate);
    oneOff.sort((a, b) => a.eventDate - b.eventDate);

    const chosen = [];
    chosen.push(...recurring.slice(0, 2));
    chosen.push(...oneOff.slice(0, Math.max(0, MAX_CARDS - chosen.length)));
    if (chosen.length < MAX_CARDS) {
      chosen.push(...recurring.slice(2, 2 + (MAX_CARDS - chosen.length)));
    }
    return chosen.sort((a, b) => a.eventDate - b.eventDate).slice(0, MAX_CARDS);
  }

  function injectStyles() {
    if (document.getElementById('howzit-events-styles')) return;
    const style = document.createElement('style');
    style.id = 'howzit-events-styles';
    style.textContent = `
      #events{background:var(--yellow);}
      #events .section-title{color:var(--coral);}
      .event-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:16px;max-width:1300px;margin:auto;}
      .event-card{display:flex;flex-direction:column;min-height:220px;border:var(--border);border-radius:24px;padding:20px;background:var(--white);box-shadow:5px 5px 0 var(--ink);}
      .event-card:nth-child(4n+2){background:var(--pink);}.event-card:nth-child(4n+3){background:var(--aqua);}.event-card:nth-child(4n+4){background:var(--cream);}
      .event-date{font-family:"Archivo Black",Impact,sans-serif;text-transform:uppercase;font-size:.82rem;letter-spacing:.06em;}
      .event-card h3{margin:12px 0 8px;font-family:"Archivo Black",Impact,sans-serif;text-transform:uppercase;line-height:.98;letter-spacing:-.035em;font-size:clamp(1.6rem,2.8vw,2.55rem);}
      .event-time{font-weight:900;text-transform:uppercase;font-size:.92rem;}
      .event-card p{margin:10px 0 0;font-size:.92rem;line-height:1.35;}
      .event-recurs{margin-top:auto;padding-top:18px;font-weight:900;text-transform:uppercase;font-size:.72rem;letter-spacing:.04em;}
      @media(max-width:1000px){.event-grid{grid-template-columns:repeat(2,minmax(0,1fr));}}
      @media(max-width:700px){#events{padding:34px 14px 42px}.event-grid{grid-template-columns:1fr;gap:10px}.event-card{min-height:0;padding:16px;border-radius:18px;box-shadow:3px 3px 0 var(--ink)}.event-card h3{font-size:1.55rem}.event-recurs{padding-top:12px}}
    `;
    document.head.appendChild(style);
  }

  function render(events) {
    if (!events.length || document.getElementById('events')) return;
    injectStyles();
    const section = document.createElement('section');
    section.className = 'section';
    section.id = 'events';
    section.innerHTML = `
      <div class="section-head"><h2 class="display section-title">Events</h2></div>
      <div class="event-grid">${events.map((e) => {
        const recurring = e.recurring ? `<div class="event-recurs">Every ${esc(e.recurringDay)}</div>` : '';
        return `<article class="event-card"><div class="event-date">${esc(formatDate(e.eventDate))}</div><h3>${esc(e.event)}</h3>${e.time ? `<div class="event-time">${esc(e.time)}</div>` : ''}${e.description ? `<p>${esc(e.description)}</p>` : ''}${recurring}</article>`;
      }).join('')}</div>`;

    const taplist = document.getElementById('taplist');
    if (taplist) taplist.insertAdjacentElement('afterend', section);

    const nav = document.querySelector('.topbar nav');
    if (nav && !nav.querySelector('a[href="#events"]')) {
      const visit = nav.querySelector('a[href="#visit"]');
      const a = document.createElement('a');
      a.href = '#events';
      a.textContent = 'Events';
      nav.insertBefore(a, visit || nav.firstChild);
    }
  }

  async function load() {
    try {
      const res = await fetch(`${EVENTS_ENDPOINT}?v=${Date.now()}`, { cache: 'no-store' });
      if (!res.ok) return;
      const text = await res.text();
      if (/^\s*</.test(text)) return;
      render(normalizeEvents(parseCSV(text)));
    } catch (err) {
      console.warn('Howzit events feed unavailable:', err);
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', load);
  else load();
})();
