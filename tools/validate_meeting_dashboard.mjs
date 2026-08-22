import { createHash, webcrypto } from 'node:crypto';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const htmlPath = path.join(root, '월간 및 주간 회의.html');
const storePath = path.join(root, 'meeting-data-store.js');
const credentialPath = path.join(root, 'meeting-github-credential.js');
const bootstrapPath = path.join(root, 'meeting-data-bootstrap.js');
const statusXlsbPath = path.join(root, 'RawData', '월간 및 주간', '회의_안건_현황.xlsb');
const memoXlsbPath = path.join(root, 'RawData', '월간 및 주간', '회의_요약_메모.xlsb');
const html = await fs.readFile(htmlPath, 'utf8');
const store = await fs.readFile(storePath, 'utf8');
const credential = await fs.readFile(credentialPath, 'utf8');
const bootstrap = await fs.readFile(bootstrapPath, 'utf8');
const [statusBytes, memoBytes] = await Promise.all([fs.readFile(statusXlsbPath), fs.readFile(memoXlsbPath)]);

const inlineScripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map(match => match[1]);
for (const [index, source] of inlineScripts.entries()) {
  try { new Function(source); }
  catch (error) { throw new Error(`inline script ${index + 1} syntax error: ${error.message}`); }
}
new Function(store);
new Function(credential);
const bootstrapWindow = {};
new Function('window', bootstrap)(bootstrapWindow);

const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
const duplicates = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
if (duplicates.length) throw new Error(`duplicate ids: ${duplicates.join(', ')}`);

const requiredLayoutIds = [
  'dashboard-container',
  'year-navigator',
  'prevYearBtn',
  'currentYearSpan',
  'nextYearBtn',
  'year-view',
  'year-grid',
  'month-view',
  'month-view-actions',
  'back-to-year-view-btn',
  'go-to-today-btn',
  'month-view-header',
  'prevMonthBtnInView',
  'month-view-title',
  'nextMonthBtnInView',
  'monthly-card-container',
  'weekly-cards-container'
];
const missingLayoutIds = requiredLayoutIds.filter(id => !ids.includes(id));
if (missingLayoutIds.length) throw new Error(`original layout ids are missing: ${missingLayoutIds.join(', ')}`);
const classTokens = [...html.matchAll(/\bclass="([^"]+)"/g)]
  .flatMap(match => match[1].split(/\s+/).filter(Boolean));
const requiredControlGroups = ['control-btn-group-left', 'control-btn-group-right'];
const missingControlGroups = requiredControlGroups.filter(className => !classTokens.includes(className));
if (missingControlGroups.length) throw new Error(`original side control groups are missing: ${missingControlGroups.join(', ')}`);

const forbidden = [
  'hardcoded-memos',
  'hardcoded-skipped',
  'memos.json',
  'skipped.json',
  "mode: 'embedded'",
  'FIVE_WEEK_EXCEPTIONS',
  '브라우저에 저장',
  '오프라인 TXT도 저장했습니다.',
  '회의_요약_등록대기_',
  'exportOfflineTxtBtn'
];
for (const pattern of forbidden) {
  if (html.includes(pattern)) throw new Error(`forbidden legacy pattern remains: ${pattern}`);
}
if (/exportOfflineTxt\s*\(\s*\{[^}]*download\s*:\s*true/i.test(html)) {
  throw new Error('an automatic TXT download path remains in the dashboard');
}
if (store.includes('Export offline TXT') || store.includes('export the offline TXT')) {
  throw new Error('a data-store error still directs the user to TXT fallback');
}

const staleTooltipPatterns = [
  '총 대상: 36건',
  '총 대상: 154건',
  '마지막 작성 (월간): 2026-02',
  '월간 작성: 30건',
  '주간 작성: 124건'
];
for (const pattern of staleTooltipPatterns) {
  if (html.includes(pattern)) throw new Error(`stale static tooltip value remains: ${pattern}`);
}

const required = [
  './vendor/xlsx.full.min.js',
  './meeting-data-store.js',
  './meeting-github-credential.js',
  './meeting-data-bootstrap.js',
  'RawData/월간 및 주간/회의_안건_현황.xlsb',
  'RawData/월간 및 주간/회의_요약_메모.xlsb',
  'memoFocusRegisterBtn',
  'memoFocusSaveBtn',
  'data-memo-action="register"',
  'data-memo-action="save"',
  '내용 입력',
  '웹 저장',
  'PC 저장',
  '오프라인 XLSB 다운로드',
  'downloadPendingXlsbFallback',
  'runWithMeetingGithubCredential',
  'RawData/공정관리/encrypted-pat.json',
  'buildMeetingStatusSummary',
  'isCurrentOfficialWeek',
  '[전체 자료]',
  '[기간·카드 기준]',
  '주간 카드: ${weekly.total}건 (정규 ${summary.regularWeeklyCount} + 보존 특수 ${summary.forcedWeeklyRows.length})',
  '공식 포함 보존 특수 주차',
  '공식 집계·카드 불일치',
  '미도래 · 공식 집계 제외',
  'Counter and card visibility flags must match',
  'rebase-if-remote-empty',
  'local-after-review'
];
for (const pattern of required) {
  if (!html.includes(pattern) && !store.includes(pattern) && !credential.includes(pattern)) throw new Error(`required integration pattern missing: ${pattern}`);
}

const requiredMemoPersistencePatterns = [
  'const memoPersistPromises = new Map()',
  'checkForUnsavedChanges({ autoSync: false })',
  'const activeLocalSave = memoPersistPromises.get(key);',
  'if (activeLocalSave) await activeLocalSave;',
  'function applyStoreSnapshotPreservingMemoDrafts(snapshot = {})'
];
for (const pattern of requiredMemoPersistencePatterns) {
  if (!html.includes(pattern)) throw new Error(`memo persistence safety pattern missing: ${pattern}`);
}

const syncPendingStart = html.indexOf('async function syncPendingChanges(showAlert = false)');
const syncPendingEnd = html.indexOf('const debouncedSync = debounce(', syncPendingStart);
if (syncPendingStart < 0 || syncPendingEnd < 0) throw new Error('syncPendingChanges source block could not be isolated');
const syncPendingSource = html.slice(syncPendingStart, syncPendingEnd);
const syncResultCheck = syncPendingSource.indexOf('if (!result.ok)');
if (syncResultCheck < 0) throw new Error('syncPendingChanges does not validate result.ok before refreshing the dashboard');
for (const refreshPattern of ['refreshDashboardFromStore()', 'applyStoreSnapshotPreservingMemoDrafts(']) {
  const refreshIndex = syncPendingSource.indexOf(refreshPattern);
  if (refreshIndex < 0) throw new Error(`syncPendingChanges refresh path missing: ${refreshPattern}`);
  if (refreshIndex < syncResultCheck) {
    throw new Error(`syncPendingChanges refreshes via ${refreshPattern} before validating result.ok`);
  }
}

const directTokenLiteral = /(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]{20,}/;
if ([html, store, credential].some(source => directTokenLiteral.test(source))) {
  throw new Error('a direct GitHub PAT literal is present in executable source');
}

async function makeCredentialFixture(token, pin) {
  const encoder = new TextEncoder();
  const salt = webcrypto.getRandomValues(new Uint8Array(16));
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const baseKey = await webcrypto.subtle.importKey('raw', encoder.encode(pin), 'PBKDF2', false, ['deriveKey']);
  const key = await webcrypto.subtle.deriveKey({
    name: 'PBKDF2', salt, iterations: 120000, hash: 'SHA-256'
  }, baseKey, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  const cipher = await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(token));
  return {
    v: 1,
    alg: 'AES-GCM',
    kdf: 'PBKDF2-SHA256',
    iterations: 120000,
    salt: Buffer.from(salt).toString('base64'),
    iv: Buffer.from(iv).toString('base64'),
    cipher: Buffer.from(cipher).toString('base64'),
    createdAt: new Date(0).toISOString()
  };
}

const fixtureToken = ['github', 'pat', 'TESTONLY0123456789abcdefghijklmnop'].join('_');
const fixturePin = '26audit';
const fixtureVault = await makeCredentialFixture(fixtureToken, fixturePin);
const credentialStorage = new Map();
let remoteVaultRequests = 0;
let consumerTokenReady = false;
const credentialWindow = {
  crypto: webcrypto,
  TextEncoder,
  TextDecoder,
  Uint8Array,
  AbortController,
  setTimeout,
  clearTimeout,
  btoa: value => Buffer.from(value, 'binary').toString('base64'),
  atob: value => Buffer.from(value, 'base64').toString('binary'),
  localStorage: {
    getItem: key => credentialStorage.has(key) ? credentialStorage.get(key) : null,
    setItem: (key, value) => credentialStorage.set(key, String(value)),
    removeItem: key => credentialStorage.delete(key)
  },
  fetch: async () => {
    remoteVaultRequests += 1;
    return { ok: true, json: async () => fixtureVault };
  }
};
credentialWindow.window = credentialWindow;
credentialWindow.globalThis = credentialWindow;
vm.runInNewContext(credential, credentialWindow, { filename: credentialPath });
const credentialApi = credentialWindow.MeetingGithubCredential.configure({
  tokenConsumer: {
    setSessionToken: token => { consumerTokenReady = token === fixtureToken; },
    clearSessionToken: () => { consumerTokenReady = false; },
    hasSessionToken: () => consumerTokenReady
  },
  remoteVaultUrls: ['https://example.invalid/encrypted-pat.json']
});
const loadedVault = await credentialApi.fetchRemoteTokenVault();
if (!credentialApi.isValidVault(loadedVault) || remoteVaultRequests !== 1) {
  throw new Error('encrypted PAT vault fetch/shape validation regression');
}
await credentialApi.unlockTokenVault(fixturePin, loadedVault);
if (!consumerTokenReady || !credentialApi.hasSessionToken()) {
  throw new Error('encrypted PAT vault did not unlock into session memory');
}
if ([...credentialStorage.values()].some(value => value.includes(fixtureToken))) {
  throw new Error('plaintext PAT leaked into persistent browser storage');
}
credentialApi.clearStoredGithubToken('validator-auth-reset');
if (consumerTokenReady || credentialApi.hasSessionToken()) {
  throw new Error('401/403 credential reset did not clear session memory');
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
const summarizeRows = rows => ({
  total: rows.length,
  written: rows.filter(row => row.status === '작성').length,
  missing: rows.filter(row => row.status === '미작성').length
});
const officialRows = status.rows.filter(row => row.counterIncluded === 'Y' && row.cardVisible === 'Y');
const excludedRows = status.rows.filter(row => row.counterIncluded === 'N' && row.cardVisible === 'N');
const flagMismatchRows = status.rows.filter(row => row.counterIncluded !== row.cardVisible);
const summarize = type => {
  const rows = officialRows.filter(row => row.type === type);
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

const allCounter = summarizeRows(status.rows);
const officialCounter = summarizeRows(officialRows);
const excludedCounter = summarizeRows(excludedRows);
const visibleCounter = summarizeRows(status.rows.filter(row => row.cardVisible === 'Y'));
if (JSON.stringify(allCounter) !== JSON.stringify({ total: 250, written: 190, missing: 60 })) {
  throw new Error(`all-row counter regression: ${JSON.stringify(allCounter)}`);
}
if (JSON.stringify(officialCounter) !== JSON.stringify({ total: 229, written: 190, missing: 39 })) {
  throw new Error(`official Y/Y counter regression: ${JSON.stringify(officialCounter)}`);
}
if (JSON.stringify(visibleCounter) !== JSON.stringify(officialCounter)) {
  throw new Error(`visible-card counter differs from official counter: ${JSON.stringify({ visibleCounter, officialCounter })}`);
}
if (JSON.stringify(excludedCounter) !== JSON.stringify({ total: 21, written: 0, missing: 21 })) {
  throw new Error(`preserved N/N exception regression: ${JSON.stringify(excludedCounter)}`);
}
if (flagMismatchRows.length !== 0) {
  throw new Error(`counter/card flags disagree for ${flagMismatchRows.length} rows: ${flagMismatchRows.map(row => row.key).join(', ')}`);
}

const forcedWeek5Rows = officialRows.filter(row => row.type === '주간' && row.exceptionCode === 'FORCED_WEEK5');
const regularWeeklyRows = officialRows.filter(row => row.type === '주간' && row.exceptionCode !== 'FORCED_WEEK5');
if (regularWeeklyRows.length !== 182 || forcedWeek5Rows.length !== 5) {
  throw new Error(`weekly roster regression: ${JSON.stringify({ regular: regularWeeklyRows.length, forcedWeek5: forcedWeek5Rows.length })}`);
}

const writtenReferenceRange = type => {
  const dates = officialRows
    .filter(row => row.type === type && row.status === '작성' && row.referenceDate)
    .map(row => row.referenceDate)
    .sort();
  return { first: dates[0] || null, last: dates.at(-1) || null };
};
const writtenReferenceRanges = {
  monthly: writtenReferenceRange('월간'),
  weekly: writtenReferenceRange('주간')
};
if (JSON.stringify(writtenReferenceRanges) !== JSON.stringify({
  monthly: { first: '2023-03-01', last: '2026-08-01' },
  weekly: { first: '2023-03-02', last: '2026-08-13' }
})) {
  throw new Error(`written reference-date range regression: ${JSON.stringify(writtenReferenceRanges)}`);
}
if (statusBytes.length > 1024 * 1024 || memoBytes.length > 1024 * 1024) {
  throw new Error('XLSB size regression: workbook exceeds the 1 MiB guardrail');
}

await globalThis.MeetingDataStore.init({ storage: 'memory' });
let mismatchedFlagRejected = false;
try {
  await globalThis.MeetingDataStore.replaceLocalData({
    status: {
      rows: [{ ...status.rows[0], cardVisible: status.rows[0].counterIncluded === 'Y' ? 'N' : 'Y' }],
      history: []
    }
  }, { force: true });
} catch (error) {
  mismatchedFlagRejected = error?.code === 'INVALID_WORKBOOK_SCHEMA';
}
if (!mismatchedFlagRejected) throw new Error('counter/card mismatch was not rejected by the store schema invariant');
await globalThis.MeetingDataStore.replaceLocalData({ memo }, { force: true });
const registerAt = '2026-08-22T06:31:32.000Z';
const saveAt = '2026-08-22T06:32:33.000Z';
await globalThis.MeetingDataStore.setMemo('2026-8-2', '웹 저장 및 PC 저장 이력 검증', {
  source: '웹 저장 · GitHub XLSB',
  changedAt: registerAt,
  forceHistory: true
});
await globalThis.MeetingDataStore.setMemo('2026-8-2', '웹 저장 및 PC 저장 이력 검증', {
  source: 'PC 저장 · 로컬 XLSB',
  changedAt: saveAt,
  forceHistory: true
});
const auditHistory = globalThis.MeetingDataStore.getHistory('memo');
const actionHistory = auditHistory.filter(row => row.key === '2026-8-2');
if (actionHistory.length !== 2
  || actionHistory[0].changedAt !== registerAt
  || actionHistory[0].source !== '웹 저장 · GitHub XLSB'
  || actionHistory[1].changedAt !== saveAt
  || actionHistory[1].source !== 'PC 저장 · 로컬 XLSB') {
  throw new Error(`memo action history regression: ${JSON.stringify(auditHistory)}`);
}
const auditExport = globalThis.MeetingDataStore.exportXlsb('memo');
const auditParsed = await globalThis.MeetingDataStore.parseXlsb('memo', auditExport.bytes);
if (auditParsed.history.length !== memo.history.length + 2 || auditParsed.rows[0]?.revision !== 2) {
  throw new Error('memo action history did not round-trip through XLSB');
}
const auditWorkbook = globalThis.XLSX.read(auditExport.bytes, { type: 'array', cellDates: true, cellNF: true });
if (!auditWorkbook.SheetNames.includes('회의요약') || !auditWorkbook.SheetNames.includes('변경이력')) {
  throw new Error(`generated memo XLSB sheet regression: ${auditWorkbook.SheetNames.join(', ')}`);
}
const historyDateFormat = auditWorkbook.Sheets['변경이력']?.B2?.z;
if (historyDateFormat !== 'yyyy-mm-dd hh:mm:ss') {
  throw new Error(`memo history timestamp format regression: ${historyDateFormat || 'missing'}`);
}
if (auditExport.byteLength > 1024 * 1024) throw new Error('generated memo XLSB exceeds the 1 MiB guardrail');

function jsonResponse(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status >= 200 && status < 300 ? 'OK' : 'ERROR',
    headers: { get: () => null },
    json: async () => payload,
    arrayBuffer: async () => new ArrayBuffer(0)
  };
}

function createGitHubMemoMock(initialBytes, options = {}) {
  let remoteBytes = Uint8Array.from(initialBytes);
  let shaSequence = 1;
  let failPutsRemaining = Number(options.failPuts || 0);
  let acceptThenFailPutsRemaining = Number(options.acceptThenFailPuts || 0);
  const putRequests = [];
  const fetch = async (_url, request = {}) => {
    const method = String(request.method || 'GET').toUpperCase();
    if (method === 'PUT') {
      const body = JSON.parse(request.body || '{}');
      putRequests.push(body);
      if (failPutsRemaining > 0) {
        failPutsRemaining -= 1;
        throw new Error('validator simulated network failure');
      }
      remoteBytes = Uint8Array.from(Buffer.from(body.content, 'base64'));
      shaSequence += 1;
      if (acceptThenFailPutsRemaining > 0) {
        acceptThenFailPutsRemaining -= 1;
        throw new Error('validator simulated accepted response loss');
      }
      return jsonResponse(200, { content: { sha: `memo-sha-${shaSequence}` } });
    }
    return jsonResponse(200, {
      sha: `memo-sha-${shaSequence}`,
      encoding: 'base64',
      content: Buffer.from(remoteBytes).toString('base64')
    });
  };
  return {
    fetch,
    putRequests,
    getRemoteBytes: () => Uint8Array.from(remoteBytes)
  };
}

function createStoreHarness(fetch) {
  const context = {
    XLSX: globalThis.XLSX,
    crypto: webcrypto,
    structuredClone,
    TextEncoder,
    TextDecoder,
    Uint8Array,
    ArrayBuffer,
    DataView,
    Date,
    Blob,
    URL,
    AbortController,
    setTimeout,
    clearTimeout,
    console,
    fetch,
    btoa: value => Buffer.from(value, 'binary').toString('base64'),
    atob: value => Buffer.from(value, 'base64').toString('binary')
  };
  context.window = context;
  context.globalThis = context;
  const harnessStore = store.replace('    const api = {', `    function __validatorSeed(snapshotInput, outboxInput) {
        snapshot = normalizeSnapshot(snapshotInput);
        memoryOutbox = new Map((outboxInput || []).map((event) => [event.eventId, clone(event)]));
        return { snapshot: clone(snapshot), outbox: [...memoryOutbox.values()].map(clone) };
    }

    const api = {
        __validatorSeed,`);
  if (harnessStore === store) throw new Error('validator-only store seeding hook could not be installed');
  vm.runInNewContext(harnessStore, context, { filename: storePath });
  return context.MeetingDataStore;
}

const targetMemoKey = '2026-8-2';
const pendingOtherKey = '2026-8-1';
const remoteOtherKey = '2026-7-4';
const targetSummary = '충돌 복구로 저장할 현재 메모';
const remoteOtherSummary = '깃허브에 존재하는 비관련 원격 메모';
const pendingOtherSummary = '이번 웹 저장 대상이 아닌 로컬 대기 메모';
const remoteOtherRow = {
  key: remoteOtherKey,
  type: '주간',
  year: 2026,
  month: 7,
  week: 4,
  summary: remoteOtherSummary,
  updatedAt: '2026-08-21T01:02:03.000Z',
  source: 'GitHub 기존 메모',
  revision: 4
};
const staleLocalRow = {
  key: targetMemoKey,
  type: '주간',
  year: 2026,
  month: 8,
  week: 2,
  summary: '브라우저에 남은 이전 메모',
  updatedAt: '2026-08-21T02:03:04.000Z',
  source: '브라우저 기존 메모',
  revision: 1
};
const remoteFixture = globalThis.MeetingDataStore.exportXlsb('memo', {
  rows: [remoteOtherRow],
  history: memo.history
});

async function initializeConflictHarness(mock) {
  const api = createStoreHarness(mock.fetch);
  await api.init({
    storage: 'memory',
    fetch: mock.fetch,
    github: {
      repo: 'validator/meeting-data',
      branch: 'main',
      memoPath: 'RawData/월간 및 주간/회의_요약_메모.xlsb',
      statusPath: 'RawData/월간 및 주간/회의_안건_현황.xlsb',
      mutationDelayMs: 0
    }
  });
  await api.replaceLocalData({ memo: { rows: [staleLocalRow], history: [] } }, { force: true });
  await api.setMemo(targetMemoKey, targetSummary, {
    source: '웹 저장 · GitHub XLSB',
    changedAt: '2026-08-22T07:08:09.000Z',
    forceHistory: true
  });
  await api.setMemo(pendingOtherKey, pendingOtherSummary, {
    source: '내부 대기열 범위 검증',
    changedAt: '2026-08-22T07:09:10.000Z',
    forceHistory: true
  });
  api.setSessionToken('validator-session-token');
  return api;
}

const successfulConflictMock = createGitHubMemoMock(remoteFixture.bytes);
const successfulConflictApi = await initializeConflictHarness(successfulConflictMock);
const successfulBeforeSync = await successfulConflictApi.getOutbox('memo');
const successfulIntent = successfulBeforeSync.find(event => event.key === targetMemoKey);
if (!successfulIntent) throw new Error('validator could not capture the target memo intent event');
const successfulConflictResult = await successfulConflictApi.syncDataset('memo', {
  keys: [targetMemoKey],
  intentEventId: successfulIntent.eventId,
  expectedSummary: targetSummary,
  memoConflictStrategy: 'rebase-if-remote-empty',
  message: '[validator] key-scoped memo conflict recovery'
});
if (successfulConflictResult.uploadedEvents !== 1
  || successfulConflictResult.conflictResolution?.rebasedEventIds?.length !== 1
  || successfulConflictMock.putRequests.length !== 1) {
  throw new Error(`key-scoped memo rebase did not upload exactly one recovered event: ${JSON.stringify(successfulConflictResult)}`);
}
const successfulRemoteMemo = await globalThis.MeetingDataStore.parseXlsb('memo', successfulConflictMock.getRemoteBytes());
const successfulTarget = successfulRemoteMemo.rows.find(row => row.key === targetMemoKey);
const preservedRemoteOther = successfulRemoteMemo.rows.find(row => row.key === remoteOtherKey);
const accidentallyUploadedOther = successfulRemoteMemo.rows.find(row => row.key === pendingOtherKey);
if (successfulTarget?.summary !== targetSummary
  || preservedRemoteOther?.summary !== remoteOtherSummary
  || accidentallyUploadedOther) {
  throw new Error(`key-scoped memo merge changed unrelated data: ${JSON.stringify(successfulRemoteMemo.rows)}`);
}
const successfulPending = await successfulConflictApi.getOutbox('memo');
if (successfulPending.length !== 1 || successfulPending[0].key !== pendingOtherKey || successfulPending[0].afterValue !== pendingOtherSummary) {
  throw new Error(`key-scoped sync did not retain unrelated local pending event: ${JSON.stringify(successfulPending)}`);
}

const failedConflictMock = createGitHubMemoMock(remoteFixture.bytes, { failPuts: 1 });
const failedConflictApi = await initializeConflictHarness(failedConflictMock);
const outboxBeforeFailure = await failedConflictApi.getOutbox('memo');
const failedIntent = outboxBeforeFailure.find(event => event.key === targetMemoKey);
if (!failedIntent) throw new Error('validator could not capture the failed-upload target memo intent event');
let simulatedFailure = null;
try {
  await failedConflictApi.syncDataset('memo', {
    keys: [targetMemoKey],
    intentEventId: failedIntent.eventId,
    expectedSummary: targetSummary,
    memoConflictStrategy: 'rebase-if-remote-empty',
    message: '[validator] simulated failed memo upload'
  });
} catch (error) {
  simulatedFailure = error;
}
if (!simulatedFailure || !String(simulatedFailure.message).includes('validator simulated network failure')) {
  throw new Error(`simulated network failure did not reach the caller: ${simulatedFailure?.message || 'no error'}`);
}
const outboxAfterFailure = await failedConflictApi.getOutbox('memo');
if (JSON.stringify(outboxAfterFailure) !== JSON.stringify(outboxBeforeFailure)) {
  throw new Error(`network failure changed or lost the original pending memo outbox: ${JSON.stringify({ outboxBeforeFailure, outboxAfterFailure })}`);
}
const pendingOtherBefore = outboxBeforeFailure.find(event => event.key === pendingOtherKey);
const pendingOtherAfter = outboxAfterFailure.find(event => event.key === pendingOtherKey);
if (JSON.stringify(pendingOtherAfter) !== JSON.stringify(pendingOtherBefore)) {
  throw new Error('network failure mutated an unrelated pending memo event');
}
const retryAfterFailure = await failedConflictApi.syncDataset('memo', {
  keys: [targetMemoKey],
  intentEventId: failedIntent.eventId,
  expectedSummary: targetSummary,
  memoConflictStrategy: 'rebase-if-remote-empty',
  message: '[validator] retry unchanged memo conflict recovery'
});
if (retryAfterFailure.uploadedEvents !== 1 || failedConflictMock.putRequests.length !== 2) {
  throw new Error(`memo conflict recovery was not safely retryable after network failure: ${JSON.stringify(retryAfterFailure)}`);
}
const pendingAfterRetry = await failedConflictApi.getOutbox('memo');
if (pendingAfterRetry.length !== 1 || pendingAfterRetry[0].key !== pendingOtherKey) {
  throw new Error(`network retry acknowledged the wrong pending events: ${JSON.stringify(pendingAfterRetry)}`);
}

const repeatedClickMock = createGitHubMemoMock(remoteFixture.bytes, { failPuts: 1 });
const repeatedClickApi = await initializeConflictHarness(repeatedClickMock);
const repeatedClickInitialOutbox = await repeatedClickApi.getOutbox('memo');
const repeatedClickOldIntent = repeatedClickInitialOutbox.find(event => event.key === targetMemoKey);
if (!repeatedClickOldIntent) throw new Error('validator could not capture the original web-save intent');
let repeatedClickInitialFailure = null;
try {
  await repeatedClickApi.syncDataset('memo', {
    keys: [targetMemoKey],
    intentEventId: repeatedClickOldIntent.eventId,
    expectedSummary: targetSummary,
    memoConflictStrategy: 'rebase-if-remote-empty',
    message: '[validator] first web-save click fails before PUT acceptance'
  });
} catch (error) {
  repeatedClickInitialFailure = error;
}
if (!repeatedClickInitialFailure?.message.includes('validator simulated network failure')
  || repeatedClickMock.putRequests.length !== 1) {
  throw new Error(`first repeated-click PUT failure was not reproduced: ${repeatedClickInitialFailure?.message || 'no error'}`);
}
const repeatedClickNewChange = await repeatedClickApi.setMemo(targetMemoKey, targetSummary, {
  source: '웹 저장 · GitHub XLSB',
  changedAt: '2026-08-22T07:10:11.000Z',
  forceHistory: true
});
const repeatedClickNewIntent = repeatedClickNewChange.event;
if (!repeatedClickNewIntent?.eventId || repeatedClickNewIntent.eventId === repeatedClickOldIntent.eventId) {
  throw new Error('second web-save click did not create a new forceHistory intent event');
}
const repeatedClickBeforeRetry = await repeatedClickApi.getOutbox('memo');
const repeatedClickSelectedIds = repeatedClickBeforeRetry
  .filter(event => event.key === targetMemoKey)
  .map(event => event.eventId);
if (repeatedClickSelectedIds.length !== 2
  || !repeatedClickSelectedIds.includes(repeatedClickOldIntent.eventId)
  || !repeatedClickSelectedIds.includes(repeatedClickNewIntent.eventId)) {
  throw new Error(`second web-save click did not retain both selected intents: ${JSON.stringify(repeatedClickBeforeRetry)}`);
}
const repeatedClickResult = await repeatedClickApi.syncDataset('memo', {
  keys: [targetMemoKey],
  intentEventId: repeatedClickNewIntent.eventId,
  expectedSummary: targetSummary,
  memoConflictStrategy: 'rebase-if-remote-empty',
  message: '[validator] second web-save click with a new forceHistory intent'
});
if (repeatedClickResult.uploadedEvents !== 2 || repeatedClickMock.putRequests.length !== 2) {
  throw new Error(`second web-save click did not upload both selected intents in one retry PUT: ${JSON.stringify(repeatedClickResult)}`);
}
const repeatedClickRemote = await globalThis.MeetingDataStore.parseXlsb('memo', repeatedClickMock.getRemoteBytes());
const repeatedClickRemoteTarget = repeatedClickRemote.rows.find(row => row.key === targetMemoKey);
for (const eventId of [repeatedClickOldIntent.eventId, repeatedClickNewIntent.eventId]) {
  const count = repeatedClickRemote.history.filter(row => row.eventId === eventId).length;
  if (count !== 1) throw new Error(`repeated web-save eventId ${eventId} was not preserved exactly once (count=${count})`);
}
const repeatedClickPending = await repeatedClickApi.getOutbox('memo');
if (repeatedClickRemoteTarget?.summary !== targetSummary
  || repeatedClickPending.length !== 1
  || repeatedClickPending[0].key !== pendingOtherKey
  || repeatedClickPending[0].afterValue !== pendingOtherSummary) {
  throw new Error(`second web-save click changed the final summary or unrelated pending scope: ${JSON.stringify({ repeatedClickRemoteTarget, repeatedClickPending })}`);
}

const multiTargetSummary = '다중 단절 대기열의 명시적 최종 메모';
const multiTargetEventIds = [
  'validator-multi-stale-event-1',
  'validator-multi-stale-event-2',
  'validator-multi-explicit-intent-3'
];
const makeSeededMemoEvent = ({ eventId, sequence, createdAt, key, source, baseSummary, baseRevision, summary, revision }) => {
  const [year, month, week] = key.split('-').map(Number);
  return {
    eventId,
    sequence,
    dataset: 'memo',
    createdAt,
    key,
    type: week ? '주간' : '월간',
    source,
    operation: summary ? 'upsert' : 'delete',
    base: { summary: baseSummary, revision: baseRevision },
    values: summary ? {
      key,
      type: week ? '주간' : '월간',
      year,
      month,
      week: week || null,
      summary,
      updatedAt: createdAt,
      source,
      revision
    } : { summary: '', revision },
    beforeValue: baseSummary,
    afterValue: summary,
    revision
  };
};
const multiTargetEvents = [
  makeSeededMemoEvent({
    eventId: multiTargetEventIds[0],
    sequence: 801,
    createdAt: '2026-08-22T09:00:03.000Z',
    key: targetMemoKey,
    source: '검증용 단절 이력 1',
    baseSummary: '서로 다른 과거 기준 A',
    baseRevision: 1,
    summary: '첫 번째 로컬 초안',
    revision: 2
  }),
  makeSeededMemoEvent({
    eventId: multiTargetEventIds[1],
    sequence: 802,
    createdAt: '2026-08-22T09:00:01.000Z',
    key: targetMemoKey,
    source: '검증용 단절 이력 2',
    baseSummary: '서로 다른 과거 기준 B',
    baseRevision: 4,
    summary: '두 번째 로컬 초안',
    revision: 5
  }),
  makeSeededMemoEvent({
    eventId: multiTargetEventIds[2],
    sequence: 803,
    createdAt: '2026-08-22T09:00:02.000Z',
    key: targetMemoKey,
    source: '웹 저장 · 명시적 최종 의도',
    baseSummary: '서로 다른 과거 기준 C',
    baseRevision: 8,
    summary: multiTargetSummary,
    revision: 9
  })
];
const multiOtherEvent = makeSeededMemoEvent({
  eventId: 'validator-multi-unrelated-local',
  sequence: 804,
  createdAt: '2026-08-22T09:00:04.000Z',
  key: pendingOtherKey,
  source: '검증용 비관련 로컬 대기',
  baseSummary: '',
  baseRevision: 0,
  summary: pendingOtherSummary,
  revision: 1
});
const pendingMemoHistory = event => ({
  eventId: event.eventId,
  changedAt: event.createdAt,
  key: event.key,
  type: event.type,
  beforeValue: event.beforeValue,
  afterValue: event.afterValue,
  source: event.source,
  syncStatus: '대기',
  revision: event.revision
});
const multiSeedSnapshot = {
  id: 'current',
  schemaVersion: 1,
  savedAt: '2026-08-22T09:00:05.000Z',
  status: { rows: [], history: [], remoteSha: null, loadedAt: null },
  memo: {
    rows: [
      {
        key: targetMemoKey,
        type: '주간',
        year: 2026,
        month: 8,
        week: 2,
        summary: multiTargetSummary,
        updatedAt: multiTargetEvents[2].createdAt,
        source: multiTargetEvents[2].source,
        revision: multiTargetEvents[2].revision
      },
      {
        key: pendingOtherKey,
        type: '주간',
        year: 2026,
        month: 8,
        week: 1,
        summary: pendingOtherSummary,
        updatedAt: multiOtherEvent.createdAt,
        source: multiOtherEvent.source,
        revision: multiOtherEvent.revision
      }
    ],
    history: [...multiTargetEvents, multiOtherEvent].map(pendingMemoHistory),
    remoteSha: null,
    loadedAt: null
  }
};
const multiRemoteFixture = globalThis.MeetingDataStore.exportXlsb('memo', {
  rows: [remoteOtherRow],
  history: []
});

async function initializeMultiDiscontinuityHarness(mock) {
  const api = createStoreHarness(mock.fetch);
  await api.init({
    storage: 'memory',
    fetch: mock.fetch,
    github: {
      repo: 'validator/meeting-data',
      branch: 'main',
      memoPath: 'RawData/월간 및 주간/회의_요약_메모.xlsb',
      statusPath: 'RawData/월간 및 주간/회의_안건_현황.xlsb',
      mutationDelayMs: 0
    }
  });
  api.__validatorSeed(multiSeedSnapshot, [...multiTargetEvents, multiOtherEvent]);
  api.setSessionToken('validator-session-token');
  const targetOutboxOrder = (await api.getOutbox('memo')).filter(event => event.key === targetMemoKey).map(event => event.eventId);
  if (targetOutboxOrder.at(-1) === multiTargetEventIds[2]) {
    throw new Error(`timestamp inversion fixture did not place a non-intent event last: ${JSON.stringify(targetOutboxOrder)}`);
  }
  return api;
}

const assertOriginalHistoryExactlyOnce = (parsedMemo, label) => {
  for (const eventId of multiTargetEventIds) {
    const count = parsedMemo.history.filter(row => row.eventId === eventId).length;
    if (count !== 1) throw new Error(`${label} did not preserve original eventId ${eventId} exactly once (count=${count})`);
  }
};

async function assertMultiSyncPreservation(api, mock, label) {
  const parsedRemote = await globalThis.MeetingDataStore.parseXlsb('memo', mock.getRemoteBytes());
  assertOriginalHistoryExactlyOnce(parsedRemote, label);
  const remoteTarget = parsedRemote.rows.find(row => row.key === targetMemoKey);
  const remoteUnrelated = parsedRemote.rows.find(row => row.key === remoteOtherKey);
  const remoteLeakedLocal = parsedRemote.rows.find(row => row.key === pendingOtherKey);
  if (remoteTarget?.summary !== multiTargetSummary
    || remoteUnrelated?.summary !== remoteOtherSummary
    || remoteLeakedLocal) {
    throw new Error(`${label} changed unrelated remote/local scope: ${JSON.stringify(parsedRemote.rows)}`);
  }
  const localSnapshot = api.getSnapshot();
  const localUnrelated = localSnapshot.memo.rows.find(row => row.key === pendingOtherKey);
  const remainingOutbox = await api.getOutbox('memo');
  if (localUnrelated?.summary !== pendingOtherSummary
    || remainingOutbox.length !== 1
    || remainingOutbox[0].eventId !== multiOtherEvent.eventId) {
    throw new Error(`${label} did not preserve only the unrelated local pending change: ${JSON.stringify({ localUnrelated, remainingOutbox })}`);
  }
  return parsedRemote;
}

const multiSuccessMock = createGitHubMemoMock(multiRemoteFixture.bytes);
const multiSuccessApi = await initializeMultiDiscontinuityHarness(multiSuccessMock);
const multiSuccessResult = await multiSuccessApi.syncDataset('memo', {
  keys: [targetMemoKey],
  intentEventId: multiTargetEventIds[2],
  expectedSummary: multiTargetSummary,
  memoConflictStrategy: 'rebase-if-remote-empty',
  message: '[validator] three discontinuities with timestamp inversion'
});
if (multiSuccessResult.uploadedEvents !== 3
  || multiSuccessResult.conflictResolution?.rebasedEventIds?.length !== 3
  || multiSuccessMock.putRequests.length !== 1) {
  throw new Error(`three-event discontinuity recovery did not use one PUT: ${JSON.stringify(multiSuccessResult)}`);
}
await assertMultiSyncPreservation(multiSuccessApi, multiSuccessMock, 'three-event discontinuity recovery');

const responseLossMock = createGitHubMemoMock(multiRemoteFixture.bytes, { acceptThenFailPuts: 1 });
const responseLossApi = await initializeMultiDiscontinuityHarness(responseLossMock);
const responseLossOutboxBefore = await responseLossApi.getOutbox('memo');
let acceptedResponseLoss = null;
try {
  await responseLossApi.syncDataset('memo', {
    keys: [targetMemoKey],
    intentEventId: multiTargetEventIds[2],
    expectedSummary: multiTargetSummary,
    memoConflictStrategy: 'rebase-if-remote-empty',
    message: '[validator] accepted PUT with response loss'
  });
} catch (error) {
  acceptedResponseLoss = error;
}
if (!acceptedResponseLoss?.message.includes('validator simulated accepted response loss')
  || responseLossMock.putRequests.length !== 1) {
  throw new Error(`accepted response-loss fixture did not fail after one accepted PUT: ${acceptedResponseLoss?.message || 'no error'}`);
}
const responseLossOutboxAfter = await responseLossApi.getOutbox('memo');
if (JSON.stringify(responseLossOutboxAfter) !== JSON.stringify(responseLossOutboxBefore)) {
  throw new Error('accepted response loss mutated the original local outbox before acknowledgement');
}
const acceptedRemoteBeforeRetry = Buffer.from(responseLossMock.getRemoteBytes());
const responseLossRetry = await responseLossApi.syncDataset('memo', {
  keys: [targetMemoKey],
  intentEventId: multiTargetEventIds[2],
  expectedSummary: multiTargetSummary,
  memoConflictStrategy: 'rebase-if-remote-empty',
  message: '[validator] retry same explicit intent after accepted response loss'
});
if (!responseLossRetry.skipped
  || responseLossRetry.reason !== 'already-remote'
  || responseLossRetry.uploadedEvents !== 3
  || responseLossMock.putRequests.length !== 1
  || !Buffer.from(responseLossMock.getRemoteBytes()).equals(acceptedRemoteBeforeRetry)) {
  throw new Error(`accepted response-loss retry was not already-remote with zero extra PUT: ${JSON.stringify(responseLossRetry)}`);
}
await assertMultiSyncPreservation(responseLossApi, responseLossMock, 'accepted response-loss retry');

console.log(JSON.stringify({
  ok: true,
  htmlBytes: Buffer.byteLength(html),
  storeBytes: Buffer.byteLength(store),
  credentialBytes: Buffer.byteLength(credential),
  inlineScripts: inlineScripts.length,
  domIds: ids.length,
  duplicateIds: duplicates,
  sourceSha256,
  xlsbBytes: { status: statusBytes.length, memo: memoBytes.length },
  workbookRows: { status: status.rows.length, memo: memo.rows.length },
  memoActionAudit: {
    historyRowsAdded: auditParsed.history.length - memo.history.length,
    revision: auditParsed.rows[0].revision,
    timestampFormat: historyDateFormat,
    generatedBytes: auditExport.byteLength,
    candidateSizes: auditExport.candidateSizes
  },
  credentialAudit: {
    remoteVaultRequests,
    algorithm: loadedVault.alg,
    kdf: loadedVault.kdf,
    iterations: loadedVault.iterations,
    plaintextPersistent: false,
    authResetClearedSession: true
  },
  statusAudit: {
    all: allCounter,
    official: officialCounter,
    visible: visibleCounter,
    monthly: counters.monthly,
    weekly: counters.weekly,
    excluded: excludedCounter,
    flagMismatch: flagMismatchRows.length,
    weeklyRoster: { regular: regularWeeklyRows.length, forcedWeek5: forcedWeek5Rows.length },
    writtenReferenceRanges
  },
  memoConflictAudit: {
    keyScopedUploadedEvents: successfulConflictResult.uploadedEvents,
    rebasedEvents: successfulConflictResult.conflictResolution.rebasedEventIds.length,
    unrelatedRemotePreserved: true,
    unrelatedLocalPendingPreserved: true,
    networkFailureOutboxUnchanged: true,
    networkFailureRetryUploadedEvents: retryAfterFailure.uploadedEvents,
    repeatedWebSaveUploadedEvents: repeatedClickResult.uploadedEvents,
    repeatedWebSaveTotalPutRequests: repeatedClickMock.putRequests.length,
    repeatedWebSaveOriginalAndNewHistoryExactlyOnce: 2,
    multiDiscontinuityEvents: multiSuccessResult.uploadedEvents,
    multiDiscontinuityPutRequests: multiSuccessMock.putRequests.length,
    originalEventIdsPreservedExactlyOnce: multiTargetEventIds.length,
    responseLossRetryReason: responseLossRetry.reason,
    responseLossTotalPutRequests: responseLossMock.putRequests.length
  },
  augustThirdWeek: { status: augustThirdWeek.status, counterIncluded: augustThirdWeek.counterIncluded, cardVisible: augustThirdWeek.cardVisible }
}, null, 2));
