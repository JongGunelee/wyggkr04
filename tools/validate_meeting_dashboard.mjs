import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const htmlPath = path.join(root, '월간 및 주간 회의.html');
const storePath = path.join(root, 'meeting-data-store.js');
const bootstrapPath = path.join(root, 'meeting-data-bootstrap.js');
const statusXlsbPath = path.join(root, 'RawData', '월간 및 주간', '회의_안건_현황.xlsb');
const memoXlsbPath = path.join(root, 'RawData', '월간 및 주간', '회의_요약_메모.xlsb');
const html = await fs.readFile(htmlPath, 'utf8');
const store = await fs.readFile(storePath, 'utf8');
const bootstrap = await fs.readFile(bootstrapPath, 'utf8');
const [statusBytes, memoBytes] = await Promise.all([fs.readFile(statusXlsbPath), fs.readFile(memoXlsbPath)]);

const inlineScripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map(match => match[1]);
for (const [index, source] of inlineScripts.entries()) {
  try { new Function(source); }
  catch (error) { throw new Error(`inline script ${index + 1} syntax error: ${error.message}`); }
}
new Function(store);
const bootstrapWindow = {};
new Function('window', bootstrap)(bootstrapWindow);

const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
const duplicates = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
if (duplicates.length) throw new Error(`duplicate ids: ${duplicates.join(', ')}`);

const forbidden = [
  'hardcoded-memos',
  'hardcoded-skipped',
  'memos.json',
  'skipped.json',
  "mode: 'embedded'",
  'FIVE_WEEK_EXCEPTIONS'
];
for (const pattern of forbidden) {
  if (html.includes(pattern)) throw new Error(`forbidden legacy pattern remains: ${pattern}`);
}

const required = [
  './vendor/xlsx.full.min.js',
  './meeting-data-store.js',
  './meeting-data-bootstrap.js',
  'RawData/월간 및 주간/회의_안건_현황.xlsb',
  'RawData/월간 및 주간/회의_요약_메모.xlsb'
];
for (const pattern of required) {
  if (!html.includes(pattern) && !store.includes(pattern)) throw new Error(`required integration pattern missing: ${pattern}`);
}

const require = createRequire(import.meta.url);
globalThis.XLSX = require(path.join(root, 'vendor', 'xlsx.full.min.js'));
require(storePath);
const [status, memo] = await Promise.all([
  globalThis.MeetingDataStore.parseXlsb('status', statusBytes),
  globalThis.MeetingDataStore.parseXlsb('memo', memoBytes)
]);
const sourceSha256 = createHash('sha256').update(statusBytes).update(memoBytes).digest('hex');
const bootstrapData = bootstrapWindow.MEETING_DATA_BOOTSTRAP;
if (!bootstrapData || bootstrapData.sourceSha256 !== sourceSha256) {
  throw new Error('meeting-data-bootstrap.js is not synchronized with the XLSB sources');
}
if (JSON.stringify(bootstrapData.status.rows) !== JSON.stringify(status.rows)
  || JSON.stringify(bootstrapData.status.history) !== JSON.stringify(status.history)
  || JSON.stringify(bootstrapData.memo.rows) !== JSON.stringify(memo.rows)
  || JSON.stringify(bootstrapData.memo.history) !== JSON.stringify(memo.history)) {
  throw new Error('bootstrap rows/history differ from the XLSB source');
}

const augustThirdWeek = status.rows.find(row => row.key === '2026-8-3');
if (!augustThirdWeek || augustThirdWeek.status !== '미작성' || augustThirdWeek.counterIncluded !== 'Y' || augustThirdWeek.cardVisible !== 'Y') {
  throw new Error('2026-8-3 must remain a visible, counter-included missing weekly agenda');
}
const activeRows = status.rows.filter(row => row.counterIncluded === 'Y');
const summarize = type => {
  const rows = activeRows.filter(row => row.type === type);
  return {
    total: rows.length,
    written: rows.filter(row => row.status === '작성').length,
    missing: rows.filter(row => row.status === '미작성').length
  };
};
const counters = { monthly: summarize('월간'), weekly: summarize('주간') };
if (JSON.stringify(counters) !== JSON.stringify({
  monthly: { total: 42, written: 42, missing: 0 },
  weekly: { total: 187, written: 148, missing: 39 }
})) throw new Error(`counter regression: ${JSON.stringify(counters)}`);

const excludedRows = status.rows.filter(row => row.counterIncluded !== 'Y').length;
if (excludedRows !== 21) throw new Error(`expected 21 preserved counter exceptions, found ${excludedRows}`);
if (statusBytes.length > 1024 * 1024 || memoBytes.length > 1024 * 1024) {
  throw new Error('XLSB size regression: workbook exceeds the 1 MiB guardrail');
}

console.log(JSON.stringify({
  ok: true,
  htmlBytes: Buffer.byteLength(html),
  storeBytes: Buffer.byteLength(store),
  inlineScripts: inlineScripts.length,
  domIds: ids.length,
  duplicateIds: duplicates,
  sourceSha256,
  xlsbBytes: { status: statusBytes.length, memo: memoBytes.length },
  workbookRows: { status: status.rows.length, memo: memo.rows.length },
  counters,
  excludedRows,
  augustThirdWeek: { status: augustThirdWeek.status, counterIncluded: augustThirdWeek.counterIncluded, cardVisible: augustThirdWeek.cardVisible }
}, null, 2));
