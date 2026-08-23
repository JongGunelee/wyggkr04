import { createHash, webcrypto } from 'node:crypto';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const dataRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.resolve(dataRoot, '..', '..');
const htmlPath = path.join(root, '월간 및 주간 회의.html');
const storePath = path.join(dataRoot, 'runtime', 'meeting-data-store.js');
const credentialPath = path.join(dataRoot, 'runtime', 'meeting-github-credential.js');
const bootstrapPath = path.join(dataRoot, 'runtime', 'meeting-data-bootstrap.js');
const statusXlsbPath = path.join(dataRoot, '회의_안건_현황.xlsb');
const memoXlsbPath = path.join(dataRoot, '회의_요약_메모.xlsb');
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
  './RawData/월간 및 주간/vendor/xlsx.full.min.js',
  './RawData/월간 및 주간/runtime/meeting-data-store.js',
  './RawData/월간 및 주간/runtime/meeting-github-credential.js',
  './RawData/월간 및 주간/runtime/meeting-data-bootstrap.js',
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
  'local-after-review',
  "defaultPin: '2026xlsb'",
  'CREDENTIAL_CANCELLED',
  'GitHub 웹 저장이 취소되었습니다. XLSB는 다운로드하지 않았습니다.',
  '[권위 데이터]',
  'data-read-action="line-height"',
  'data-read-action="width"',
  'data-edit-action="indent"',
  'data-edit-action="outdent"',
  'data-edit-action="bullet"',
  'data-edit-action="number"',
  'data-edit-action="manual-number"',
  'handleMemoEditorKeydown',
  'initializeMemoToolbars',
  'meetingMemoFocusOptionsV1',
  'data-memo-options-toggle="read"',
  'data-memo-options-toggle="edit"',
  'initializeMemoFocusOptionGroups',
  'mobilePortrait: { read: false, edit: false }',
  'batchUpdateStatus',
  'syncPendingStatusChanges',
  "meetingStore.syncDataset('status'",
  'keys: expectedKeys',
  'STATUS_CONFLICT_FIELDS',
  'data-short-label="현황"',
  'data-menu-label="현황 · 작성/미작성 관리"',
  'initializeDraggableControlButtons',
  'meetingControlBubbleLayoutV1',
  'control-btn-slot',
  'bubble-positioned',
  'bubble-ejected',
  'resolveControlBubbleCollisions',
  'restoreControlBubbleGroupDefault',
  'data-bubble-reset-group="left"',
  'data-bubble-reset-group="right"',
  "button.addEventListener('pointerdown'",
  "button.addEventListener('pointermove'",
  "button.addEventListener('pointerup'",
  "button.addEventListener('pointercancel'",
  "button.addEventListener('contextmenu'"
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

const persistMemoActionStart = html.indexOf('async function persistMemoAction(key, action)');
const persistMemoActionEnd = html.indexOf('async function handleSaveAllChanges()', persistMemoActionStart);
if (persistMemoActionStart < 0 || persistMemoActionEnd < 0) throw new Error('persistMemoAction source block could not be isolated');
const persistMemoActionSource = html.slice(persistMemoActionStart, persistMemoActionEnd);
const cancelledGuardIndex = persistMemoActionSource.indexOf("error?.code === 'CREDENTIAL_CANCELLED'");
const fallbackDownloadIndex = persistMemoActionSource.indexOf('downloadPendingXlsbFallback({');
if (cancelledGuardIndex < 0 || fallbackDownloadIndex < 0 || cancelledGuardIndex > fallbackDownloadIndex) {
  throw new Error('credential cancel/Escape can still trigger an XLSB fallback download');
}
if (!credential.includes("defaultPin: '2026xlsb'")
  || !credential.includes("'CREDENTIAL_UNLOCK_FAILED'")) {
  throw new Error('the default combination key or explicit unlock-failure boundary is missing');
}

const openMemoFocusStart = html.indexOf('function openMemoFocus(key, mode)');
const openMemoFocusEnd = html.indexOf('function closeMemoFocus()', openMemoFocusStart);
if (openMemoFocusStart < 0 || openMemoFocusEnd < 0) {
  throw new Error('openMemoFocus source block could not be isolated');
}
const openMemoFocusSource = html.slice(openMemoFocusStart, openMemoFocusEnd);
if (!/const\s+draft\s*=\s*sessionEditedMemoKeys\.has\(key\)\s*\?[\s\S]{0,240}:\s*getConfirmedMemoValue\(key\)/.test(openMemoFocusSource)) {
  throw new Error('openMemoFocus can freeze a stale card/cache value instead of the confirmed GitHub memo');
}

const renderMemoFocusStart = html.indexOf('function renderMemoFocusMode(mode)');
const renderMemoFocusEnd = html.indexOf('function openMemoFocus(key, mode)', renderMemoFocusStart);
const renderMemoFocusSource = html.slice(renderMemoFocusStart, renderMemoFocusEnd);
if (renderMemoFocusStart < 0
  || renderMemoFocusEnd < 0
  || !renderMemoFocusSource.includes('applyMemoFocusOptionState(mode)')) {
  throw new Error('read/edit mode switching no longer restores its viewport-specific option visibility');
}

const finishBubbleDragStart = html.indexOf('const finishDrag = (event, cancelled = false) =>');
const finishBubbleDragEnd = html.indexOf("button.addEventListener('pointerup'", finishBubbleDragStart);
const finishBubbleDragSource = html.slice(finishBubbleDragStart, finishBubbleDragEnd);
const persistDraggedBubbleIndex = finishBubbleDragSource.indexOf('persistControlBubblePosition(button)');
const resolveBubbleCollisionIndex = finishBubbleDragSource.indexOf('resolveControlBubbleCollisions(button, buttons');
if (finishBubbleDragStart < 0
  || finishBubbleDragEnd < 0
  || persistDraggedBubbleIndex < 0
  || resolveBubbleCollisionIndex < persistDraggedBubbleIndex) {
  throw new Error('a dropped control bubble is not persisted before overlapping peer bubbles are ejected');
}

const syncPendingStart = html.indexOf('async function syncPendingChanges(showAlert = false)');
const syncPendingEnd = html.indexOf('async function importOfflineHistory(', syncPendingStart);
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

const batchUpdateStart = html.indexOf('const processBatchUpdate = async (markAsSkip) =>');
const batchUpdateEnd = html.indexOf("document.getElementById('batchMarkSkippedBtn').addEventListener", batchUpdateStart);
if (batchUpdateStart < 0 || batchUpdateEnd < 0) throw new Error('processBatchUpdate source block could not be isolated');
const batchUpdateSource = html.slice(batchUpdateStart, batchUpdateEnd);
const localStatusWrite = batchUpdateSource.indexOf('await meetingStore.setStatus(');
const automaticStatusSync = batchUpdateSource.indexOf('await syncPendingStatusChanges(keysToUpdate, targetStatus)');
const confirmedSuccessMessage = batchUpdateSource.indexOf('GitHub XLSB 저장을 확인했습니다.');
if (localStatusWrite < 0 || automaticStatusSync < localStatusWrite || confirmedSuccessMessage < automaticStatusSync) {
  throw new Error('manual status update can claim completion without the automatic GitHub status sync boundary');
}

const initializeMeetingStart = html.indexOf('async function initializeMeetingData()');
const initializeMeetingEnd = html.indexOf('function initializeDashboard()', initializeMeetingStart);
if (initializeMeetingStart < 0 || initializeMeetingEnd < 0) {
  throw new Error('initializeMeetingData source block could not be isolated');
}
const initializeMeetingSource = html.slice(initializeMeetingStart, initializeMeetingEnd);
const remoteStatusMissingDeclaration = initializeMeetingSource.indexOf('const remoteStatusMissing = mode === \'api\'');
const guardedStatusFallback = initializeMeetingSource.indexOf("if (!remoteStatusMissing && !snapshot.status.rows.length) fallbackDatasets.push('status');");
const guardedBootstrapFallback = initializeMeetingSource.indexOf('if (!remoteStatusMissing && !snapshot.status.rows.length && window.MEETING_DATA_BOOTSTRAP');
const explicitMissingFailure = initializeMeetingSource.indexOf('if (remoteStatusMissing)');
if (!initializeMeetingSource.includes('overlayPending: false')) {
  throw new Error('startup GitHub load is not configured as the authoritative view');
}
if (remoteStatusMissingDeclaration < 0
  || guardedStatusFallback < remoteStatusMissingDeclaration
  || guardedBootstrapFallback < guardedStatusFallback
  || explicitMissingFailure < guardedBootstrapFallback) {
  throw new Error('status 404 can fall back to cached/local data and resurrect a deleted remote workbook');
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
globalThis.XLSX = require(path.join(dataRoot, 'vendor', 'xlsx.full.min.js'));
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
const actionHistory = auditHistory.filter(row => row.key === '2026-8-2'
  && (row.changedAt === registerAt || row.changedAt === saveAt));
if (actionHistory.length !== 2
  || actionHistory[0].changedAt !== registerAt
  || actionHistory[0].source !== '웹 저장 · GitHub XLSB'
  || actionHistory[1].changedAt !== saveAt
  || actionHistory[1].source !== 'PC 저장 · 로컬 XLSB') {
  throw new Error(`memo action history regression: ${JSON.stringify(auditHistory)}`);
}
const auditExport = globalThis.MeetingDataStore.exportXlsb('memo');
const auditParsed = await globalThis.MeetingDataStore.parseXlsb('memo', auditExport.bytes);
const originalMemoRevision = Number(memo.rows.find(row => row.key === '2026-8-2')?.revision || 0);
if (auditParsed.history.length !== memo.history.length + 2
  || auditParsed.rows.find(row => row.key === '2026-8-2')?.revision !== originalMemoRevision + 2) {
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

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createGitHubMemoMock(initialBytes, options = {}) {
  let remoteBytes = Uint8Array.from(initialBytes);
  let shaSequence = 1;
  let failPutsRemaining = Number(options.failPuts || 0);
  let acceptThenFailPutsRemaining = Number(options.acceptThenFailPuts || 0);
  const putRequests = [];
  const fetch = async (_url, request = {}) => {
    const method = String(request.method || 'GET').toUpperCase();
    if (method === 'GET' && options.missing === true) {
      return jsonResponse(404, { message: 'Not Found' });
    }
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
    getRemoteBytes: () => Uint8Array.from(remoteBytes),
    setRemoteBytes: bytes => {
      remoteBytes = Uint8Array.from(bytes);
      shaSequence += 1;
    }
  };
}

function createMemoPutLoadRaceMock(initialBytes) {
  let remoteBytes = Uint8Array.from(initialBytes);
  let shaSequence = 1;
  let getCount = 0;
  const putRequests = [];
  const putStarted = deferred();
  const releasePut = deferred();
  const lateGetStarted = deferred();
  const releaseLateGet = deferred();
  const fetch = async (_url, request = {}) => {
    const method = String(request.method || 'GET').toUpperCase();
    if (method === 'PUT') {
      const body = JSON.parse(request.body || '{}');
      putRequests.push(body);
      putStarted.resolve();
      await releasePut.promise;
      remoteBytes = Uint8Array.from(Buffer.from(body.content, 'base64'));
      shaSequence += 1;
      return jsonResponse(200, { content: { sha: `memo-race-sha-${shaSequence}` } });
    }
    getCount += 1;
    const capturedBytes = Uint8Array.from(remoteBytes);
    const capturedSha = `memo-race-sha-${shaSequence}`;
    if (getCount === 2) {
      lateGetStarted.resolve();
      await releaseLateGet.promise;
    }
    return jsonResponse(200, {
      sha: capturedSha,
      encoding: 'base64',
      content: Buffer.from(capturedBytes).toString('base64')
    });
  };
  return {
    fetch,
    putRequests,
    putStarted,
    releasePut,
    lateGetStarted,
    releaseLateGet,
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

const restartStatusKey = '2026-7-4';
const restartStatusSource = status.rows.find(row => row.key === restartStatusKey);
if (!restartStatusSource || restartStatusSource.status !== '작성') {
  throw new Error(`${restartStatusKey} must be a written weekly row for the restart status regression fixture`);
}
const restartStatusMock = createGitHubMemoMock(statusBytes);
const initializeStatusRestartHarness = async () => {
  const api = createStoreHarness(restartStatusMock.fetch);
  await api.init({
    storage: 'memory',
    fetch: restartStatusMock.fetch,
    github: {
      repo: 'validator/meeting-data',
      branch: 'main',
      memoPath: 'RawData/월간 및 주간/회의_요약_메모.xlsb',
      statusPath: 'RawData/월간 및 주간/회의_안건_현황.xlsb',
      mutationDelayMs: 0
    }
  });
  const loaded = await api.load({ dataset: 'status', overlayPending: false, throwOnError: true });
  if (!loaded.status?.ok || !loaded.status.exists) throw new Error('status restart fixture could not load its GitHub XLSB');
  return api;
};

const statusWriterApi = await initializeStatusRestartHarness();
const missingChange = await statusWriterApi.setStatus(restartStatusKey, '미작성', {
  source: '검증용 다른 주 미작성 자동 저장',
  changedAt: '2026-08-23T01:02:03.000Z'
});
if (!missingChange.changed || !missingChange.event) throw new Error('status restart fixture did not create a missing-status event');
statusWriterApi.setSessionToken('validator-session-token');
const missingSync = await statusWriterApi.syncDataset('status', {
  publishMissing: false,
  allowRemoteCreate: false,
  message: '[validator] persist missing status across restart'
});
if (!missingSync.ok || missingSync.uploadedEvents !== 1 || restartStatusMock.putRequests.length !== 1) {
  throw new Error(`missing status did not upload exactly once: ${JSON.stringify(missingSync)}`);
}

const freshMissingApi = await initializeStatusRestartHarness();
const freshMissingRow = freshMissingApi.getSnapshot().status.rows.find(row => row.key === restartStatusKey);
if (freshMissingRow?.status !== '미작성' || await freshMissingApi.pendingCount('status') !== 0) {
  throw new Error(`fresh restart did not preserve the GitHub missing status: ${JSON.stringify(freshMissingRow)}`);
}
const restoredChange = await freshMissingApi.setStatus(restartStatusKey, '작성', {
  source: '검증용 다른 주 작성 복원 자동 저장',
  changedAt: '2026-08-23T01:03:04.000Z'
});
freshMissingApi.setSessionToken('validator-session-token');
const restoredSync = await freshMissingApi.syncDataset('status', {
  publishMissing: false,
  allowRemoteCreate: false,
  message: '[validator] restore written status across restart'
});
if (!restoredChange.changed || !restoredSync.ok || restoredSync.uploadedEvents !== 1 || restartStatusMock.putRequests.length !== 2) {
  throw new Error(`written status restore did not upload exactly once: ${JSON.stringify(restoredSync)}`);
}

const freshRestoredApi = await initializeStatusRestartHarness();
const freshRestoredSnapshot = freshRestoredApi.getSnapshot();
const freshRestoredRow = freshRestoredSnapshot.status.rows.find(row => row.key === restartStatusKey);
const restartEventIds = new Set([missingChange.event.eventId, restoredChange.event.eventId]);
const restartHistory = freshRestoredSnapshot.status.history.filter(row => restartEventIds.has(row.eventId));
if (freshRestoredRow?.status !== '작성'
  || restartHistory.length !== 2
  || new Set(restartHistory.map(row => row.eventId)).size !== 2
  || restartHistory.some(row => row.syncStatus !== '완료')
  || await freshRestoredApi.pendingCount('status') !== 0) {
  throw new Error(`second fresh restart did not preserve the restored status/history: ${JSON.stringify({ freshRestoredRow, restartHistory })}`);
}

const metadataConflictKey = '2026-8-2';
const unrelatedPendingStatusKey = '2026-7-4';
const metadataConflictMock = createGitHubMemoMock(statusBytes);
const metadataConflictApi = createStoreHarness(metadataConflictMock.fetch);
await metadataConflictApi.init({
  storage: 'memory',
  fetch: metadataConflictMock.fetch,
  github: {
    repo: 'validator/meeting-data',
    branch: 'main',
    memoPath: 'RawData/월간 및 주간/회의_요약_메모.xlsb',
    statusPath: 'RawData/월간 및 주간/회의_안건_현황.xlsb',
    mutationDelayMs: 0
  }
});
await metadataConflictApi.load({ dataset: 'status', overlayPending: false, throwOnError: true });
const metadataTargetChange = await metadataConflictApi.setStatus(metadataConflictKey, '미작성', {
  source: '검증용 현재 화면 상태 변경',
  changedAt: '2026-08-23T01:04:05.000Z'
});
const unrelatedPendingStatusChange = await metadataConflictApi.setStatus(unrelatedPendingStatusKey, '미작성', {
  source: '검증용 비관련 로컬 상태 대기',
  changedAt: '2026-08-23T01:04:06.000Z'
});
if (!metadataTargetChange.changed || !unrelatedPendingStatusChange.changed) {
  throw new Error('status metadata-conflict fixture did not create both pending events');
}
const metadataRemoteState = {
  rows: status.rows.map(row => row.key === metadataConflictKey
    ? { ...row, source: '검증용 다른 사용자의 원격 수정경로', updatedAt: '2026-08-23T01:04:04.000Z' }
    : { ...row }),
  history: status.history.map(row => ({ ...row }))
};
const metadataRemoteWorkbook = globalThis.MeetingDataStore.exportXlsb('status', metadataRemoteState);
metadataConflictMock.setRemoteBytes(metadataRemoteWorkbook.bytes);
metadataConflictApi.setSessionToken('validator-session-token');
const metadataConflictResult = await metadataConflictApi.syncDataset('status', {
  keys: [metadataConflictKey],
  publishMissing: false,
  allowRemoteCreate: false,
  message: '[validator] ignore audit-source-only divergence and scope status sync'
});
const metadataConflictRemote = await globalThis.MeetingDataStore.parseXlsb('status', metadataConflictMock.getRemoteBytes());
const metadataConflictRemoteTarget = metadataConflictRemote.rows.find(row => row.key === metadataConflictKey);
const metadataConflictRemoteOther = metadataConflictRemote.rows.find(row => row.key === unrelatedPendingStatusKey);
const metadataConflictOutbox = await metadataConflictApi.getOutbox('status');
if (!metadataConflictResult.ok
  || metadataConflictResult.uploadedEvents !== 1
  || metadataConflictMock.putRequests.length !== 1
  || metadataConflictRemoteTarget?.status !== '미작성'
  || metadataConflictRemoteOther?.status !== '작성'
  || metadataConflictRemote.history.filter(row => row.eventId === metadataTargetChange.event.eventId).length !== 1
  || metadataConflictOutbox.length !== 1
  || metadataConflictOutbox[0].eventId !== unrelatedPendingStatusChange.event.eventId) {
  throw new Error(`status metadata-only divergence or scoped upload regressed: ${JSON.stringify({
    metadataConflictResult,
    putRequests: metadataConflictMock.putRequests.length,
    target: metadataConflictRemoteTarget,
    other: metadataConflictRemoteOther,
    outbox: metadataConflictOutbox
  })}`);
}

const semanticConflictMock = createGitHubMemoMock(statusBytes);
const semanticConflictApi = createStoreHarness(semanticConflictMock.fetch);
await semanticConflictApi.init({
  storage: 'memory',
  fetch: semanticConflictMock.fetch,
  github: {
    repo: 'validator/meeting-data',
    branch: 'main',
    memoPath: 'RawData/월간 및 주간/회의_요약_메모.xlsb',
    statusPath: 'RawData/월간 및 주간/회의_안건_현황.xlsb',
    mutationDelayMs: 0
  }
});
await semanticConflictApi.load({ dataset: 'status', overlayPending: false, throwOnError: true });
const semanticLocalChange = await semanticConflictApi.upsertStatus(metadataConflictKey, {
  status: '미작성',
  note: '검증용 현재 화면의 실제 비고'
}, {
  source: '검증용 실제 필드 충돌 로컬 변경',
  changedAt: '2026-08-23T01:04:07.000Z'
});
const semanticRemoteState = {
  rows: status.rows.map(row => row.key === metadataConflictKey
    ? { ...row, note: '검증용 다른 사용자의 실제 비고', source: '검증용 다른 사용자', updatedAt: '2026-08-23T01:04:06.500Z' }
    : { ...row }),
  history: status.history.map(row => ({ ...row }))
};
semanticConflictMock.setRemoteBytes(globalThis.MeetingDataStore.exportXlsb('status', semanticRemoteState).bytes);
semanticConflictApi.setSessionToken('validator-session-token');
let semanticConflictError = null;
try {
  await semanticConflictApi.syncDataset('status', {
    keys: [metadataConflictKey],
    publishMissing: false,
    allowRemoteCreate: false,
    message: '[validator] preserve true status field conflicts'
  });
} catch (error) {
  semanticConflictError = error;
}
const semanticConflictOutbox = await semanticConflictApi.getOutbox('status');
if (!semanticLocalChange.changed
  || semanticConflictError?.code !== 'DATA_CONFLICT'
  || !semanticConflictError.conflicts?.some(conflict => conflict.fields?.some(field => field.field === 'note'))
  || semanticConflictMock.putRequests.length !== 0
  || semanticConflictOutbox.length !== 1
  || semanticConflictOutbox[0].eventId !== semanticLocalChange.event.eventId) {
  throw new Error(`a true status field conflict was not kept for user review: ${JSON.stringify({
    code: semanticConflictError?.code,
    conflicts: semanticConflictError?.conflicts,
    putRequests: semanticConflictMock.putRequests.length,
    outbox: semanticConflictOutbox
  })}`);
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
  history: memo.history.filter(row => row.key === '전체')
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
  await api.replaceLocalData({ memo: { rows: [], history: [] } }, { force: true });
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
  || successfulConflictResult.conflictResolution
  || successfulConflictMock.putRequests.length !== 1) {
  throw new Error(`new key-scoped memo did not upload exactly one event: ${JSON.stringify(successfulConflictResult)}`);
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

const harnessGithubConfig = {
  repo: 'validator/meeting-data',
  branch: 'main',
  memoPath: 'RawData/월간 및 주간/회의_요약_메모.xlsb',
  statusPath: 'RawData/월간 및 주간/회의_안건_현황.xlsb',
  mutationDelayMs: 0
};

async function initializeSeededMemoHarness(mock, seededSnapshot, seededOutbox) {
  const api = createStoreHarness(mock.fetch);
  api.__validatorSeed(seededSnapshot, seededOutbox);
  await api.init({
    storage: 'memory',
    fetch: mock.fetch,
    github: harnessGithubConfig
  });
  return api;
}

const restartSnapshot = {
  id: 'current',
  schemaVersion: 1,
  savedAt: '2026-08-22T08:59:58.000Z',
  status: { rows: [], history: [], remoteSha: null, loadedAt: null },
  memo: {
    rows: [remoteOtherRow],
    history: [],
    remoteSha: 'cached-memo-sha',
    loadedAt: '2026-08-22T08:59:58.000Z'
  }
};
const legacyRestartEvent = makeSeededMemoEvent({
  eventId: 'validator-restart-legacy-event',
  sequence: 701,
  createdAt: '2026-08-22T09:00:00.000Z',
  key: targetMemoKey,
  source: '이전 브라우저 세션 대기 메모',
  baseSummary: '',
  baseRevision: 0,
  summary: '재시작 시 화면에 재생되면 안 되는 레거시 메모',
  revision: 1
});

const authoritativeLoadMock = createGitHubMemoMock(remoteFixture.bytes);
const authoritativeLoadApi = await initializeSeededMemoHarness(
  authoritativeLoadMock,
  restartSnapshot,
  [legacyRestartEvent]
);
const snapshotImmediatelyAfterRestart = authoritativeLoadApi.getSnapshot();
if (snapshotImmediatelyAfterRestart.memo.rows.some(row => row.key === targetMemoKey)
  || snapshotImmediatelyAfterRestart.memo.history.some(row => row.eventId === legacyRestartEvent.eventId)) {
  throw new Error('store init replayed a legacy outbox event into the authoritative browser snapshot');
}
const restartOutbox = await authoritativeLoadApi.getOutbox('memo');
if (restartOutbox.length !== 1 || restartOutbox[0].eventId !== legacyRestartEvent.eventId) {
  throw new Error(`store init lost or changed the isolated legacy outbox event: ${JSON.stringify(restartOutbox)}`);
}
const authoritativeLoad = await authoritativeLoadApi.load({
  dataset: 'memo',
  overlayPending: false,
  throwOnError: true
});
const authoritativeSnapshot = authoritativeLoadApi.getSnapshot();
const authoritativePending = await authoritativeLoadApi.getOutbox('memo');
if (!authoritativeLoad.memo?.ok
  || authoritativeLoad.memo.pendingCount !== 1
  || authoritativeLoad.memo.acknowledgedCount !== 0
  || authoritativeSnapshot.memo.rows.some(row => row.key === targetMemoKey)
  || authoritativeSnapshot.memo.rows.find(row => row.key === remoteOtherKey)?.summary !== remoteOtherSummary
  || authoritativePending.length !== 1
  || authoritativePending[0].eventId !== legacyRestartEvent.eventId
  || authoritativeLoadMock.putRequests.length !== 0) {
  throw new Error(`startup GitHub XLSB did not remain authoritative over a legacy outbox: ${JSON.stringify({ authoritativeLoad, authoritativeSnapshot, authoritativePending })}`);
}

const remoteLatestEvent = makeSeededMemoEvent({
  eventId: 'validator-remote-latest-event',
  sequence: 702,
  createdAt: '2026-08-22T09:00:01.000Z',
  key: targetMemoKey,
  source: '다른 사용자 GitHub 최신 메모',
  baseSummary: legacyRestartEvent.afterValue,
  baseRevision: 1,
  summary: '다른 사용자가 확정한 GitHub 최신 메모',
  revision: 2
});
const memoHistoryFromSeededEvent = event => ({
  eventId: event.eventId,
  changedAt: event.createdAt,
  key: event.key,
  type: event.type,
  beforeValue: event.beforeValue,
  afterValue: event.afterValue,
  source: event.source,
  syncStatus: '완료',
  revision: event.revision
});
const exactDuplicateRemoteFixture = globalThis.MeetingDataStore.exportXlsb('memo', {
  rows: [remoteLatestEvent.values],
  history: [legacyRestartEvent, remoteLatestEvent].map(memoHistoryFromSeededEvent)
});
const exactDuplicateMock = createGitHubMemoMock(exactDuplicateRemoteFixture.bytes);
const exactDuplicateApi = await initializeSeededMemoHarness(
  exactDuplicateMock,
  restartSnapshot,
  [legacyRestartEvent]
);
const exactDuplicateLoad = await exactDuplicateApi.load({
  dataset: 'memo',
  overlayPending: false,
  throwOnError: true
});
const exactDuplicateSnapshot = exactDuplicateApi.getSnapshot();
const exactDuplicatePending = await exactDuplicateApi.getOutbox('memo');
if (exactDuplicateLoad.memo?.acknowledgedCount !== 1
  || exactDuplicateLoad.memo.pendingCount !== 0
  || exactDuplicateLoad.memo.conflicts.length !== 0
  || exactDuplicateSnapshot.memo.rows.find(row => row.key === targetMemoKey)?.summary !== remoteLatestEvent.afterValue
  || exactDuplicateSnapshot.memo.history.filter(row => row.eventId === legacyRestartEvent.eventId).length !== 1
  || exactDuplicatePending.length !== 0
  || exactDuplicateMock.putRequests.length !== 0) {
  throw new Error(`an exact remote duplicate was not acknowledged without replaying stale content: ${JSON.stringify({ exactDuplicateLoad, exactDuplicateSnapshot, exactDuplicatePending })}`);
}

const mismatchedDuplicateEvent = structuredClone(legacyRestartEvent);
mismatchedDuplicateEvent.afterValue = '같은 eventId를 사용한 다른 내용';
mismatchedDuplicateEvent.values.summary = mismatchedDuplicateEvent.afterValue;
const mismatchedDuplicateMock = createGitHubMemoMock(exactDuplicateRemoteFixture.bytes);
const mismatchedDuplicateApi = await initializeSeededMemoHarness(
  mismatchedDuplicateMock,
  restartSnapshot,
  [mismatchedDuplicateEvent]
);
const mismatchedDuplicateLoad = await mismatchedDuplicateApi.load({
  dataset: 'memo',
  overlayPending: false,
  throwOnError: true
});
const mismatchedDuplicatePending = await mismatchedDuplicateApi.getOutbox('memo');
if (mismatchedDuplicateLoad.memo?.acknowledgedCount !== 0
  || mismatchedDuplicateLoad.memo.pendingCount !== 1
  || !mismatchedDuplicateLoad.memo.conflicts.some(conflict => conflict.reason === 'EVENT_ID_HISTORY_MISMATCH')
  || mismatchedDuplicateApi.getSnapshot().memo.rows.find(row => row.key === targetMemoKey)?.summary !== remoteLatestEvent.afterValue
  || mismatchedDuplicatePending.length !== 1
  || mismatchedDuplicatePending[0].eventId !== mismatchedDuplicateEvent.eventId
  || mismatchedDuplicateMock.putRequests.length !== 0) {
  throw new Error(`a semantic eventId mismatch was incorrectly acknowledged or overlaid: ${JSON.stringify({ mismatchedDuplicateLoad, mismatchedDuplicatePending })}`);
}

const missingRemoteMock = createGitHubMemoMock(remoteFixture.bytes, { missing: true });
const missingRemoteApi = await initializeSeededMemoHarness(
  missingRemoteMock,
  restartSnapshot,
  [legacyRestartEvent]
);
const missingRemoteLoad = await missingRemoteApi.load({
  dataset: 'memo',
  overlayPending: false,
  throwOnError: true
});
const missingRemoteSnapshot = missingRemoteApi.getSnapshot();
const missingRemotePending = await missingRemoteApi.getOutbox('memo');
if (!missingRemoteLoad.memo?.ok
  || missingRemoteLoad.memo.exists !== false
  || missingRemoteLoad.memo.pendingCount !== 1
  || missingRemoteSnapshot.memo.rows.length !== 0
  || missingRemoteSnapshot.memo.history.length !== 0
  || missingRemoteSnapshot.memo.remoteSha !== null
  || missingRemotePending.length !== 1
  || missingRemotePending[0].eventId !== legacyRestartEvent.eventId
  || missingRemoteMock.putRequests.length !== 0) {
  throw new Error(`GitHub 404 resurrected a cached memo snapshot or mutated its outbox: ${JSON.stringify({ missingRemoteLoad, missingRemoteSnapshot, missingRemotePending })}`);
}

const missingStatusMock = createGitHubMemoMock(statusBytes, { missing: true });
const cachedStatusSnapshot = structuredClone(restartSnapshot);
cachedStatusSnapshot.status.rows = [status.rows[0]];
cachedStatusSnapshot.status.remoteSha = 'cached-status-sha';
cachedStatusSnapshot.status.loadedAt = '2026-08-22T08:59:58.000Z';
const missingStatusApi = await initializeSeededMemoHarness(missingStatusMock, cachedStatusSnapshot, []);
const missingStatusLoad = await missingStatusApi.load({
  dataset: 'status',
  overlayPending: false,
  throwOnError: true
});
const missingStatusSnapshot = missingStatusApi.getSnapshot();
if (!missingStatusLoad.status?.ok
  || missingStatusLoad.status.exists !== false
  || missingStatusSnapshot.status.rows.length !== 0
  || missingStatusSnapshot.status.history.length !== 0
  || missingStatusSnapshot.status.remoteSha !== null
  || missingStatusMock.putRequests.length !== 0) {
  throw new Error(`GitHub status 404 resurrected cached agenda rows: ${JSON.stringify({ missingStatusLoad, missingStatusSnapshot })}`);
}

const raceSummary = 'PUT 완료 뒤에도 유지되어야 하는 최신 메모';
const putLoadRaceMock = createMemoPutLoadRaceMock(remoteFixture.bytes);
const putLoadRaceApi = createStoreHarness(putLoadRaceMock.fetch);
await putLoadRaceApi.init({
  storage: 'memory',
  fetch: putLoadRaceMock.fetch,
  github: harnessGithubConfig
});
await putLoadRaceApi.replaceLocalData({ memo: { rows: [], history: [] } }, { force: true });
const raceMemoChange = await putLoadRaceApi.setMemo(targetMemoKey, raceSummary, {
  source: '검증용 PUT/GET 경합',
  changedAt: '2026-08-22T09:00:02.000Z',
  forceHistory: true
});
putLoadRaceApi.setSessionToken('validator-session-token');
const putLoadRaceSync = putLoadRaceApi.syncDataset('memo', {
  keys: [targetMemoKey],
  intentEventId: raceMemoChange.event.eventId,
  expectedSummary: raceSummary,
  memoConflictStrategy: 'rebase-if-remote-empty',
  message: '[validator] invalidate GET started during PUT'
});
await putLoadRaceMock.putStarted.promise;
const lateMemoLoad = putLoadRaceApi.load({
  dataset: 'memo',
  overlayPending: false,
  throwOnError: true
});
await putLoadRaceMock.lateGetStarted.promise;
putLoadRaceMock.releasePut.resolve();
const putLoadRaceResult = await putLoadRaceSync;
putLoadRaceMock.releaseLateGet.resolve();
const lateMemoLoadResult = await lateMemoLoad;
const putLoadRaceSnapshot = putLoadRaceApi.getSnapshot();
const putLoadRacePending = await putLoadRaceApi.getOutbox('memo');
const putLoadRaceRemote = await globalThis.MeetingDataStore.parseXlsb('memo', putLoadRaceMock.getRemoteBytes());
if (!lateMemoLoadResult.memo?.stale
  || lateMemoLoadResult.memo.skipped !== true
  || putLoadRaceResult.uploadedEvents !== 1
  || putLoadRaceMock.putRequests.length !== 1
  || putLoadRacePending.length !== 0
  || putLoadRaceSnapshot.memo.rows.find(row => row.key === targetMemoKey)?.summary !== raceSummary
  || putLoadRaceRemote.rows.find(row => row.key === targetMemoKey)?.summary !== raceSummary) {
  throw new Error(`a GET started during PUT replaced the committed memo snapshot: ${JSON.stringify({
    lateMemoLoadResult,
    putLoadRaceResult,
    putRequests: putLoadRaceMock.putRequests.length,
    putLoadRacePending,
    snapshotRows: putLoadRaceSnapshot.memo.rows,
    remoteRows: putLoadRaceRemote.rows
  })}`);
}

const multiTargetEvents = [
  makeSeededMemoEvent({
    eventId: multiTargetEventIds[0],
    sequence: 801,
    createdAt: '2026-08-22T09:00:03.000Z',
    key: targetMemoKey,
    source: '검증용 단절 이력 1',
    baseSummary: '',
    baseRevision: 0,
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

const deletedRemoteBaseSummary = '원격에서 row와 history가 삭제된 과거 메모';
const deletedRemoteLocalSummary = '삭제 사실 검토 뒤에만 복원할 로컬 메모';
const deletedRemotePendingEvent = makeSeededMemoEvent({
  eventId: 'validator-deleted-remote-pending-event',
  sequence: 790,
  createdAt: '2026-08-22T09:00:02.500Z',
  key: targetMemoKey,
  source: '삭제된 원격 기준의 로컬 편집',
  baseSummary: deletedRemoteBaseSummary,
  baseRevision: 7,
  summary: deletedRemoteLocalSummary,
  revision: 8
});
const deletedRemoteSeedSnapshot = {
  id: 'current',
  schemaVersion: 1,
  savedAt: '2026-08-22T09:00:02.500Z',
  status: { rows: [], history: [], remoteSha: null, loadedAt: null },
  memo: {
    rows: [deletedRemotePendingEvent.values],
    history: [pendingMemoHistory(deletedRemotePendingEvent)],
    remoteSha: 'memo-sha-before-remote-deletion',
    loadedAt: '2026-08-22T09:00:02.500Z'
  }
};
const deletedRemoteMock = createGitHubMemoMock(remoteFixture.bytes);
const deletedRemoteApi = await initializeSeededMemoHarness(
  deletedRemoteMock,
  deletedRemoteSeedSnapshot,
  [deletedRemotePendingEvent]
);
deletedRemoteApi.setSessionToken('validator-session-token');
const deletedRemoteOutboxBefore = await deletedRemoteApi.getOutbox('memo');
const deletedRemoteSnapshotBefore = deletedRemoteApi.getSnapshot();
let deletedRemoteConflict = null;
try {
  await deletedRemoteApi.syncDataset('memo', {
    keys: [targetMemoKey],
    intentEventId: deletedRemotePendingEvent.eventId,
    expectedSummary: deletedRemoteLocalSummary,
    memoConflictStrategy: 'rebase-if-remote-empty',
    message: '[validator] deleted remote memo must not auto-resurrect'
  });
} catch (error) {
  deletedRemoteConflict = error;
}
const deletedRemoteConflictDetail = deletedRemoteConflict?.conflicts?.find(conflict => conflict.key === targetMemoKey);
const deletedRemoteOutboxAfterConflict = await deletedRemoteApi.getOutbox('memo');
const deletedRemoteSnapshotAfterConflict = deletedRemoteApi.getSnapshot();
if (deletedRemoteConflict?.code !== 'DATA_CONFLICT'
  || !deletedRemoteConflictDetail
  || deletedRemoteMock.putRequests.length !== 0
  || JSON.stringify(deletedRemoteOutboxAfterConflict) !== JSON.stringify(deletedRemoteOutboxBefore)
  || JSON.stringify(deletedRemoteSnapshotAfterConflict) !== JSON.stringify(deletedRemoteSnapshotBefore)) {
  throw new Error(`a deleted remote memo was automatically resurrected from a non-empty local base: ${JSON.stringify({
    errorCode: deletedRemoteConflict?.code,
    conflicts: deletedRemoteConflict?.conflicts,
    putRequests: deletedRemoteMock.putRequests.length,
    outboxBefore: deletedRemoteOutboxBefore,
    outboxAfter: deletedRemoteOutboxAfterConflict,
    snapshotBefore: deletedRemoteSnapshotBefore.memo,
    snapshotAfter: deletedRemoteSnapshotAfterConflict.memo
  })}`);
}
const reviewedDeletedRemoteResult = await deletedRemoteApi.syncDataset('memo', {
  keys: [targetMemoKey],
  intentEventId: deletedRemotePendingEvent.eventId,
  expectedSummary: deletedRemoteLocalSummary,
  memoConflictStrategy: 'local-after-review',
  reviewedRemoteSha: deletedRemoteConflictDetail.remoteSha,
  reviewedRemoteFingerprint: deletedRemoteConflictDetail.remoteFingerprint,
  message: '[validator] explicitly reviewed deleted remote memo restoration'
});
const deletedRemoteAfterReview = await globalThis.MeetingDataStore.parseXlsb('memo', deletedRemoteMock.getRemoteBytes());
const deletedRemoteOutboxAfterReview = await deletedRemoteApi.getOutbox('memo');
if (reviewedDeletedRemoteResult.uploadedEvents !== 1
  || reviewedDeletedRemoteResult.conflictResolution?.strategy !== 'local-after-review'
  || reviewedDeletedRemoteResult.conflictResolution?.rebasedEventIds?.length !== 1
  || deletedRemoteMock.putRequests.length !== 1
  || deletedRemoteOutboxAfterReview.length !== 0
  || deletedRemoteAfterReview.rows.find(row => row.key === targetMemoKey)?.summary !== deletedRemoteLocalSummary) {
  throw new Error(`an explicitly reviewed deleted memo was not restored exactly once: ${JSON.stringify({
    reviewedDeletedRemoteResult,
    putRequests: deletedRemoteMock.putRequests.length,
    outbox: deletedRemoteOutboxAfterReview,
    rows: deletedRemoteAfterReview.rows
  })}`);
}

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
  if (localUnrelated
    || remainingOutbox.length !== 1
    || remainingOutbox[0].eventId !== multiOtherEvent.eventId) {
    throw new Error(`${label} did not keep the unrelated draft isolated in the outbox: ${JSON.stringify({ localUnrelated, remainingOutbox })}`);
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
  || multiSuccessResult.conflictResolution?.rebasedEventIds?.length !== 2
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

const stableEventJson = value => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableEventJson).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableEventJson(value[key])}`).join(',')}}`;
};

// PC XLSB must include the unrelated outbox-only memo left behind by a key-scoped web save.
const scopedPortableExport = await successfulConflictApi.exportPendingXlsb('memo');
const scopedPortableWorkbook = globalThis.XLSX.read(scopedPortableExport.bytes, { type: 'array' });
if (!scopedPortableWorkbook.SheetNames.includes('로컬대기이력')) {
  throw new Error('PC XLSB omitted the local pending-history sheet');
}
const scopedPendingSheet = scopedPortableWorkbook.Sheets['로컬대기이력'];
const scopedPendingRange = globalThis.XLSX.utils.decode_range(scopedPendingSheet['!ref']);
if (scopedPendingRange.e.r !== 1 || scopedPendingRange.e.c !== 16) {
  throw new Error(`one pending event expanded the local pending sheet unexpectedly: ${scopedPendingSheet['!ref']}`);
}
const scopedPortableParsed = await globalThis.MeetingDataStore.parseXlsb('memo', scopedPortableExport.bytes);
const scopedPortableRow = scopedPortableParsed.rows.find(row => row.key === pendingOtherKey);
const scopedPortableHistoryCount = scopedPortableParsed.history.filter(row => row.eventId === successfulPending[0].eventId).length;
const scopedPortablePending = scopedPortableParsed.pendingEvents.find(event => event.eventId === successfulPending[0].eventId);
if (scopedPortableExport.pendingCount !== 1
  || scopedPortableRow?.summary !== pendingOtherSummary
  || scopedPortableHistoryCount !== 1
  || !scopedPortablePending
  || stableEventJson(scopedPortablePending) !== stableEventJson(successfulPending[0])) {
  throw new Error(`PC XLSB did not preserve the scoped-sync remainder exactly: ${JSON.stringify({
    pendingCount: scopedPortableExport.pendingCount,
    scopedPortableRow,
    scopedPortableHistoryCount,
    pendingEventIds: scopedPortableParsed.pendingEvents.map(event => event.eventId)
  })}`);
}

// Normal exports and GitHub PUT payloads must remain authoritative workbooks without a local queue sheet.
const scopedNormalExport = successfulConflictApi.exportXlsb('memo');
const scopedNormalWorkbook = globalThis.XLSX.read(scopedNormalExport.bytes, { type: 'array' });
if (scopedNormalWorkbook.SheetNames.includes('로컬대기이력')) {
  throw new Error('normal exportXlsb leaked the local pending-history sheet');
}
const scopedPutBytes = Uint8Array.from(Buffer.from(successfulConflictMock.putRequests[0].content, 'base64'));
const scopedPutWorkbook = globalThis.XLSX.read(scopedPutBytes, { type: 'array' });
if (scopedPutWorkbook.SheetNames.includes('로컬대기이력')) {
  throw new Error('GitHub PUT payload leaked the local pending-history sheet');
}

// A portable workbook must not silently discard its queue, and an explicit queue import must restore exact IDs/payloads.
const portableImportApi = createStoreHarness(async () => jsonResponse(404, { message: 'Not Found' }));
await portableImportApi.init({ storage: 'memory' });
let portableDiscardGuard = null;
try {
  await portableImportApi.importLocalFile('memo', scopedPortableExport.bytes, { queueForSync: false });
} catch (error) {
  portableDiscardGuard = error;
}
if (portableDiscardGuard?.code !== 'PENDING_EVENTS_REQUIRE_QUEUE_IMPORT'
  || (await portableImportApi.getOutbox('memo')).length !== 0) {
  throw new Error(`portable XLSB pending-event discard was not blocked atomically: ${portableDiscardGuard?.code || 'no error'}`);
}
const portableImportResult = await portableImportApi.importLocalFile('memo', scopedPortableExport.bytes, { queueForSync: true });
const restoredPortableOutbox = await portableImportApi.getOutbox('memo');
if (!portableImportResult.portable
  || portableImportResult.queued !== 1
  || restoredPortableOutbox.length !== 1
  || restoredPortableOutbox[0].eventId !== successfulPending[0].eventId
  || stableEventJson(restoredPortableOutbox[0]) !== stableEventJson(successfulPending[0])) {
  throw new Error(`portable XLSB did not restore the original event identity and payload: ${JSON.stringify({ portableImportResult, restoredPortableOutbox })}`);
}

// A stale-base pending memo over a newer remote revision needs an export-only head, not mutation of the original event.
const higherRemoteSummary = '다른 사용자가 저장한 리비전 12 메모';
const oldBaseLocalSummary = 'PC XLSB에 보존할 최종 로컬 메모';
const higherRemoteChangedAt = '2026-08-22T10:00:00.000Z';
const higherRemoteSource = '다른 사용자 GitHub 리비전 12';
const oldBasePendingEvent = makeSeededMemoEvent({
  eventId: 'validator-portable-old-base-event',
  sequence: 901,
  createdAt: '2026-08-22T09:30:00.000Z',
  key: targetMemoKey,
  source: 'PC 저장 검증용 오래된 기준 편집',
  baseSummary: '로컬이 마지막으로 보았던 리비전 2 메모',
  baseRevision: 2,
  summary: oldBaseLocalSummary,
  revision: 3
});
const higherRevisionSnapshot = {
  id: 'current',
  schemaVersion: 1,
  savedAt: higherRemoteChangedAt,
  status: { rows: [], history: [], remoteSha: null, loadedAt: null },
  memo: {
    rows: [{
      key: targetMemoKey,
      type: '주간',
      year: 2026,
      month: 8,
      week: 2,
      summary: higherRemoteSummary,
      updatedAt: higherRemoteChangedAt,
      source: higherRemoteSource,
      revision: 12
    }],
    history: [{
      eventId: 'validator-higher-remote-head',
      changedAt: higherRemoteChangedAt,
      key: targetMemoKey,
      type: '주간',
      beforeValue: '',
      afterValue: higherRemoteSummary,
      source: higherRemoteSource,
      syncStatus: '완료',
      revision: 12
    }],
    remoteSha: 'validator-higher-remote-sha',
    loadedAt: higherRemoteChangedAt
  }
};
const oldBasePortableApi = createStoreHarness(async () => jsonResponse(404, { message: 'Not Found' }));
await oldBasePortableApi.init({ storage: 'memory' });
oldBasePortableApi.__validatorSeed(higherRevisionSnapshot, [oldBasePendingEvent]);
const oldBaseSnapshotBeforeExport = oldBasePortableApi.getSnapshot();
const oldBaseOutboxBeforeExport = await oldBasePortableApi.getOutbox('memo');
const oldBasePortableExport = await oldBasePortableApi.exportPendingXlsb('memo');
const oldBasePortableParsed = await globalThis.MeetingDataStore.parseXlsb('memo', oldBasePortableExport.bytes);
const oldBaseProjectedRow = oldBasePortableParsed.rows.find(row => row.key === targetMemoKey);
const oldBaseKeyHistory = oldBasePortableParsed.history
  .filter(row => row.key === targetMemoKey)
  .sort((left, right) => Number(left.revision) - Number(right.revision)
    || String(left.changedAt).localeCompare(String(right.changedAt))
    || String(left.eventId).localeCompare(String(right.eventId)));
const oldBaseProjectedHead = oldBaseKeyHistory.at(-1);
const oldBaseOriginalHistoryCount = oldBaseKeyHistory.filter(row => row.eventId === oldBasePendingEvent.eventId).length;
const oldBaseEmbeddedEvent = oldBasePortableParsed.pendingEvents.find(event => event.eventId === oldBasePendingEvent.eventId);
const oldBaseSnapshotAfterExport = oldBasePortableApi.getSnapshot();
const oldBaseOutboxAfterExport = await oldBasePortableApi.getOutbox('memo');
if (oldBasePortableExport.exportHeadEventIds.length !== 1
  || !oldBasePortableExport.projectionConflicts.some(conflict => conflict.reason === 'MEMO_BASE_DIVERGED')
  || oldBaseProjectedRow?.summary !== oldBaseLocalSummary
  || oldBaseProjectedRow.revision !== oldBaseProjectedHead?.revision
  || oldBaseProjectedRow.updatedAt !== oldBaseProjectedHead?.changedAt
  || oldBaseProjectedRow.source !== oldBaseProjectedHead?.source
  || oldBaseOriginalHistoryCount !== 1
  || !oldBaseEmbeddedEvent
  || stableEventJson(oldBaseEmbeddedEvent) !== stableEventJson(oldBasePendingEvent)
  || stableEventJson(oldBaseSnapshotAfterExport) !== stableEventJson(oldBaseSnapshotBeforeExport)
  || stableEventJson(oldBaseOutboxAfterExport) !== stableEventJson(oldBaseOutboxBeforeExport)) {
  throw new Error(`old-base portable XLSB projection lost intent, history identity, or memo-head consistency: ${JSON.stringify({
    exportHeadEventIds: oldBasePortableExport.exportHeadEventIds,
    projectionConflicts: oldBasePortableExport.projectionConflicts,
    oldBaseProjectedRow,
    oldBaseProjectedHead,
    oldBaseOriginalHistoryCount
  })}`);
}

const compactPendingSize = Math.min(
  scopedPortableExport.candidateSizes.inline,
  scopedPortableExport.candidateSizes.sharedStrings
);
const portableGrowthBytes = scopedPortableExport.byteLength - scopedNormalExport.byteLength;
if (scopedPortableExport.byteLength !== compactPendingSize
  || scopedPortableExport.byteLength >= 50 * 1024 * 1024
  || portableGrowthBytes > 512 * 1024) {
  throw new Error(`portable XLSB size guard failed: ${JSON.stringify({
    portableBytes: scopedPortableExport.byteLength,
    normalBytes: scopedNormalExport.byteLength,
    portableGrowthBytes,
    candidateSizes: scopedPortableExport.candidateSizes
  })}`);
}

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
  statusRestartAudit: {
    key: restartStatusKey,
    missingAfterFreshRestart: freshMissingRow.status,
    restoredAfterSecondRestart: freshRestoredRow.status,
    completedHistoryEvents: restartHistory.length,
    putRequests: restartStatusMock.putRequests.length,
    pendingAfterRestart: await freshRestoredApi.pendingCount('status')
  },
  statusConflictAudit: {
    key: metadataConflictKey,
    auditSourceOnlyDivergenceMerged: metadataConflictRemoteTarget.status === '미작성',
    scopedUploadedEvents: metadataConflictResult.uploadedEvents,
    unrelatedRemoteStatusPreserved: metadataConflictRemoteOther.status,
    unrelatedLocalPendingPreserved: metadataConflictOutbox.length,
    targetHistoryExactlyOnce: metadataConflictRemote.history.filter(row => row.eventId === metadataTargetChange.event.eventId).length,
    trueSemanticConflictProtected: semanticConflictError.code === 'DATA_CONFLICT',
    trueSemanticConflictPutRequests: semanticConflictMock.putRequests.length
  },
  startupMappingAudit: {
    authoritativePendingIsolated: authoritativeLoad.memo.pendingCount,
    exactDuplicateAcknowledged: exactDuplicateLoad.memo.acknowledgedCount,
    semanticMismatchRetained: mismatchedDuplicateLoad.memo.pendingCount,
    missingRemoteExists: missingRemoteLoad.memo.exists,
    missingRemoteRows: missingRemoteSnapshot.memo.rows.length,
    missingStatusRows: missingStatusSnapshot.status.rows.length,
    implicitPutRequests: authoritativeLoadMock.putRequests.length
      + exactDuplicateMock.putRequests.length
      + mismatchedDuplicateMock.putRequests.length
      + missingRemoteMock.putRequests.length
      + missingStatusMock.putRequests.length,
    status404FallbackGuarded: true
  },
  memoConflictAudit: {
    keyScopedUploadedEvents: successfulConflictResult.uploadedEvents,
    rebasedEvents: successfulConflictResult.conflictResolution?.rebasedEventIds?.length || 0,
    unrelatedRemotePreserved: true,
    unrelatedLocalPendingPreserved: true,
    networkFailureOutboxUnchanged: true,
    networkFailureRetryUploadedEvents: retryAfterFailure.uploadedEvents,
    repeatedWebSaveUploadedEvents: repeatedClickResult.uploadedEvents,
    repeatedWebSaveTotalPutRequests: repeatedClickMock.putRequests.length,
    repeatedWebSaveOriginalAndNewHistoryExactlyOnce: 2,
    putLoadRaceLateLoadStale: lateMemoLoadResult.memo.stale,
    putLoadRacePutRequests: putLoadRaceMock.putRequests.length,
    deletedRemoteAutoRestoreBlocked: deletedRemoteConflict.code === 'DATA_CONFLICT',
    deletedRemoteReviewedRestoreUploadedEvents: reviewedDeletedRemoteResult.uploadedEvents,
    multiDiscontinuityEvents: multiSuccessResult.uploadedEvents,
    multiDiscontinuityPutRequests: multiSuccessMock.putRequests.length,
    originalEventIdsPreservedExactlyOnce: multiTargetEventIds.length,
    responseLossRetryReason: responseLossRetry.reason,
    responseLossTotalPutRequests: responseLossMock.putRequests.length
  },
  portableXlsbAudit: {
    scopedPendingCount: scopedPortableExport.pendingCount,
    originalEventIdPreserved: scopedPortablePending.eventId,
    normalExportPendingSheet: scopedNormalWorkbook.SheetNames.includes('로컬대기이력'),
    githubPutPendingSheet: scopedPutWorkbook.SheetNames.includes('로컬대기이력'),
    restoredEventId: restoredPortableOutbox[0].eventId,
    discardGuardCode: portableDiscardGuard.code,
    oldBaseProjectedRevision: oldBaseProjectedRow.revision,
    oldBaseHeadRevision: oldBaseProjectedHead.revision,
    portableBytes: scopedPortableExport.byteLength,
    normalBytes: scopedNormalExport.byteLength,
    portableGrowthBytes
  },
  augustThirdWeek: { status: augustThirdWeek.status, counterIncluded: augustThirdWeek.counterIncluded, cardVisible: augustThirdWeek.cardVisible }
}, null, 2));
