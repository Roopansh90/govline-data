// GovLine data updater — runs daily in GitHub Actions (free).
// Checks Microsoft's official emergency-numbers table and updates helplines.json.
//
// Rules (safe by design — this is emergency data):
//  • New numbers found on the official page are ADDED automatically.
//  • Numbers missing from the official page are NEVER deleted automatically;
//    they are listed in the run summary for you to review by hand.
//  • If the page can't be read properly (layout changed, too few rows),
//    the run FAILS and nothing is changed. GitHub emails you about failed runs.
//
// Usage: node scripts/update.mjs [--dry-run] [--source <file-or-url>]

import { readFile, writeFile, appendFile } from 'node:fs/promises';

const SOURCE_URL = 'https://learn.microsoft.com/en-us/microsoftteams/emergency-numbers-reference';
const DATA_FILE = new URL('../helplines.json', import.meta.url);
const MIN_ROWS = 150;          // sanity check: the page has ~240 rows
const MAX_ADDS_PER_RUN = 40;   // sanity check: more than this smells like a parsing bug

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const srcArg = args.includes('--source') ? args[args.indexOf('--source') + 1] : SOURCE_URL;
const today = new Date().toISOString().slice(0, 10);

const decode = s => s
  .replace(/<br\s*\/?>/gi, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"')
  .replace(/\s+/g, ' ').trim();

const flagOf = code => /^[A-Z]{2}$/.test(code)
  ? String.fromCodePoint(...[...code].map(c => 0x1F1E6 + c.charCodeAt(0) - 65)) : '🏳️';

async function getSource() {
  if (/^https?:/.test(srcArg)) {
    const r = await fetch(srcArg, { headers: { 'User-Agent': 'govline-data-bot (+https://github.com)' } });
    if (!r.ok) throw new Error(`Fetch failed: HTTP ${r.status}`);
    return r.text();
  }
  return readFile(srcArg, 'utf8');
}

// Find the table whose header has "ISO" + "Emergency Numbers", return {CODE: {name, numbers[]}}
function parseTable(html) {
  const tables = html.match(/<table[\s\S]*?<\/table>/gi) || [];
  for (const t of tables) {
    const rows = t.match(/<tr[\s\S]*?<\/tr>/gi) || [];
    if (!rows.length) continue;
    const header = (rows[0].match(/<t[hd][\s\S]*?<\/t[hd]>/gi) || []).map(decode).map(h => h.toLowerCase());
    const iCountry = header.findIndex(h => h.startsWith('country'));
    const iCode = header.findIndex(h => h.includes('iso'));
    const iNums = header.findIndex(h => h === 'emergency numbers');
    if (iCountry < 0 || iCode < 0 || iNums < 0) continue;

    const out = {};
    for (const row of rows.slice(1)) {
      const cells = (row.match(/<td[\s\S]*?<\/td>/gi) || []).map(decode);
      if (cells.length <= Math.max(iCountry, iCode, iNums)) continue;
      const code = cells[iCode].toUpperCase();
      if (!/^[A-Z]{2}$/.test(code)) continue;
      const numbers = cells[iNums].split(/[\s,;/]+/).filter(n => /^\d{2,6}$/.test(n));
      if (!numbers.length) continue;
      out[code] = { name: cells[iCountry], numbers: [...new Set(numbers)] };
    }
    return out;
  }
  throw new Error('Could not find the emergency numbers table — page layout may have changed.');
}

const official = parseTable(await getSource());
const officialCount = Object.keys(official).length;
if (officialCount < MIN_ROWS) throw new Error(`Only ${officialCount} rows parsed (expected ≥ ${MIN_ROWS}). Aborting, no changes made.`);

const data = JSON.parse(await readFile(DATA_FILE, 'utf8'));
const byCode = Object.fromEntries(data.countries.map(c => [c.code, c]));
const added = [], review = [], newCountries = [];
const CORE = ['emergency', 'police', 'fire', 'ambulance'];

for (const [code, off] of Object.entries(official)) {
  let country = byCode[code];
  if (!country) {
    country = { code, name: off.name, flag: flagOf(code), helplines: [] };
    data.countries.push(country);
    byCode[code] = country;
    newCountries.push(`${off.name} (${code})`);
  }
  const have = new Set(country.helplines.map(h => String(h.number).replace(/\D/g, '')));

  for (const n of off.numbers) {
    if (have.has(n)) continue;
    country.helplines.push({
      category: 'Emergency',
      name: `Emergency - ${n}`,
      number: n,
      email: '',
      description: `Emergency for ${country.name} - Microsoft`,
      verified: today
    });
    added.push(`${country.name}: ${n}`);
  }

  for (const h of country.helplines) {
    const n = String(h.number).replace(/\D/g, '');
    if (off.numbers.includes(n)) h.verified = today;
    else if (CORE.includes(String(h.category).toLowerCase())) review.push(`${country.name}: ${h.number} (${h.category}) not on Microsoft list`);
  }
}

if (added.length > MAX_ADDS_PER_RUN) throw new Error(`${added.length} additions in one run looks wrong. Aborting, no changes made.`);

data.countries.sort((a, b) => a.name.localeCompare(b.name));
data.total_countries = data.countries.length;
data.last_updated = today;

const summary = [
  `## GovLine data check — ${today}`,
  `Official rows read: **${officialCount}** · Countries in file: **${data.countries.length}**`,
  '',
  `### Added (${added.length})`, ...(added.length ? added.map(a => `- ${a}`) : ['- none']),
  newCountries.length ? `\n### New countries (${newCountries.length})\n${newCountries.map(c => `- ${c}`).join('\n')}` : '',
  '',
  `### Review by hand (${review.length}) — kept, not deleted`,
  ...(review.length ? review.map(r => `- ${r}`) : ['- none']),
].join('\n');

console.log(summary);
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summary + '\n');
if (!DRY) await writeFile(DATA_FILE, JSON.stringify(data, null, 2) + '\n');
else console.log('\n(dry run — helplines.json not written)');
