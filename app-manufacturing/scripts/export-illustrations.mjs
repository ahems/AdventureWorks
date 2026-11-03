import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const endpoint = process.env.API_FUNCTIONS_URL;
const token = process.env.FUNCTIONS_ACCESS_TOKEN;
if (!endpoint || !token) throw new Error('Set API_FUNCTIONS_URL and FUNCTIONS_ACCESS_TOKEN (manufacturing.read scope).');

const fromCsv = process.argv.includes('--csv');
const records = [];
if (fromCsv) {
  const directory = path.join(repo, 'seed-job/sql');
  const files = (await readdir(directory)).filter(name => /^Illustration(?:-ai)?\.csv$/.test(name)).sort();
  for (const name of files) {
    const content = await readFile(path.join(directory, name), 'utf8');
    for (const record of content.split('&|').filter(record => record.trim())) {
      const fields = record.trim().split('+|');
      if (fields.length !== 3 || !/^[1-9]\d*$/.test(fields[0])) throw new Error(`Invalid record in ${name}.`);
      records.push({ illustrationId: Number(fields[0]), diagram: fields[1] });
    }
  }
  if (new Set(records.map(record => record.illustrationId)).size !== records.length) throw new Error('Duplicate illustration IDs in seed files.');
}
const response = await fetch(`${endpoint.replace(/\/$/, '')}/api/manufacturing/illustrations/export`, {
  method: fromCsv ? 'POST' : 'GET',
  headers: { Authorization: `Bearer ${token}`, ...(fromCsv ? { 'Content-Type': 'application/json' } : {}) },
  ...(fromCsv ? { body: JSON.stringify(records) } : {}),
});
if (!response.ok) throw new Error(`Illustration export failed (${response.status}): ${await response.text()}`);
const { illustrations } = await response.json();
if (!Array.isArray(illustrations) || illustrations.length === 0) throw new Error('The API returned no illustrations.');
const ids = new Set();
for (const item of illustrations) {
  if (!Number.isSafeInteger(item.illustrationId) || item.illustrationId <= 0 || ids.has(item.illustrationId) ||
      item.fileName !== `illustration-${item.illustrationId}.svg` || typeof item.svg !== 'string' ||
      !item.svg.startsWith('<svg') || !item.svg.includes('http://www.w3.org/2000/svg')) {
    throw new Error('The API returned an invalid illustration asset.');
  }
  ids.add(item.illustrationId);
}
const destination = path.join(repo, 'app-manufacturing/public/illustrations');
await mkdir(destination, { recursive: true });
for (const item of illustrations) {
  await writeFile(path.join(destination, item.fileName), item.svg + '\n');
  console.log(`Bundled ${item.fileName}`);
}
