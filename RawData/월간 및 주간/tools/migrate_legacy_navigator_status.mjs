import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const dataRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workbookPath = path.join(dataRoot, '회의_안건_현황.xlsb');
const storePath = path.join(dataRoot, 'runtime', 'meeting-data-store.js');
const xlsxPath = path.join(dataRoot, 'vendor', 'xlsx.full.min.js');
const XLSX = require(xlsxPath);

globalThis.XLSX = XLSX;
require(storePath);
const store = globalThis.MeetingDataStore;
assert.ok(store, 'MeetingDataStore API를 불러오지 못했습니다.');

const legacyMonthlyKeys = [];
for (let year = 2014; year <= 2022; year += 1) {
    for (let month = 1; month <= 12; month += 1) legacyMonthlyKeys.push(`${year}-${month}`);
}
legacyMonthlyKeys.push('2023-1', '2023-2');
assert.equal(legacyMonthlyKeys.length, 110, '월간 기존 하드코딩 키 수가 110건이어야 합니다.');

const originalBytes = await fs.readFile(workbookPath);
const originalState = await store.parseXlsb('status', originalBytes);
const originalRowsByKey = new Map(originalState.rows.map(row => [row.key, structuredClone(row)]));
const originalHistoryById = new Map(originalState.history.map(row => [row.eventId, structuredClone(row)]));
const existingLegacyRows = legacyMonthlyKeys.filter(key => originalRowsByKey.has(key));

if (existingLegacyRows.length && existingLegacyRows.length !== legacyMonthlyKeys.length) {
    throw new Error(`부분 이관 상태가 감지되어 중단합니다: ${existingLegacyRows.length}/110`);
}

if (existingLegacyRows.length === legacyMonthlyKeys.length) {
    for (const key of legacyMonthlyKeys) {
        const row = originalRowsByKey.get(key);
        assert.equal(row.type, '월간', `${key} 구분`);
        assert.equal(row.status, '미작성', `${key} 상태`);
        assert.equal(row.counterIncluded, 'N', `${key} 카운터포함`);
        assert.equal(row.cardVisible, 'N', `${key} 카드표시`);
    }
    console.log('legacy navigator status migration already complete');
    process.exit(0);
}

await store.create({ storage: 'memory' });
await store.replaceLocalData({ status: originalState }, { force: true });

const changedAt = new Date().toISOString();
const createdEventIds = new Set();
for (const key of legacyMonthlyKeys) {
    const result = await store.upsertStatus({
        key,
        status: '미작성',
        counterIncluded: 'N',
        cardVisible: 'N',
        source: '기존 월간 HTML 하드코딩 마이그레이션',
        exceptionCode: 'LEGACY_NAVIGATOR_ONLY',
        note: '월간 회의.html 기존 미작성 월 폴백 이관 · 내비게이션 전용'
    }, {
        source: '기존 월간 HTML 하드코딩 마이그레이션',
        changedAt
    });
    assert.equal(result.changed, true, `${key} 신규 행이 생성되어야 합니다.`);
    assert.ok(result.event?.eventId, `${key} 변경이력이 생성되어야 합니다.`);
    createdEventIds.add(result.event.eventId);
}

const migratedState = store.getSnapshot().status;
for (const historyRow of migratedState.history) {
    if (createdEventIds.has(historyRow.eventId)) historyRow.syncStatus = '완료';
}

assert.equal(migratedState.rows.length, originalState.rows.length + 110, '현재값 행 증가량');
assert.equal(migratedState.history.length, originalState.history.length + 110, '변경이력 행 증가량');
assert.equal(new Set(migratedState.rows.map(row => row.key)).size, migratedState.rows.length, '현재값 키 중복 금지');
assert.equal(new Set(migratedState.history.map(row => row.eventId)).size, migratedState.history.length, '변경이력 ID 중복 금지');

for (const [key, before] of originalRowsByKey) {
    assert.deepEqual(migratedState.rows.find(row => row.key === key), before, `기존 현재값 보존: ${key}`);
}
for (const [eventId, before] of originalHistoryById) {
    assert.deepEqual(migratedState.history.find(row => row.eventId === eventId), before, `기존 변경이력 보존: ${eventId}`);
}
for (const key of legacyMonthlyKeys) {
    const row = migratedState.rows.find(item => item.key === key);
    assert.ok(row, `${key} 이관 행 누락`);
    assert.equal(row.type, '월간', `${key} 구분`);
    assert.equal(row.status, '미작성', `${key} 상태`);
    assert.equal(row.counterIncluded, 'N', `${key} 카운터포함`);
    assert.equal(row.cardVisible, 'N', `${key} 카드표시`);
    assert.equal(row.exceptionCode, 'LEGACY_NAVIGATOR_ONLY', `${key} 예외코드`);
}

const generated = store.exportXlsb('status', migratedState);
const roundTrip = await store.parseXlsb('status', generated.bytes);
assert.equal(roundTrip.rows.length, migratedState.rows.length, 'XLSB 재파싱 현재값 행 수');
assert.equal(roundTrip.history.length, migratedState.history.length, 'XLSB 재파싱 변경이력 행 수');
for (const key of legacyMonthlyKeys) {
    const row = roundTrip.rows.find(item => item.key === key);
    assert.equal(row?.status, '미작성', `XLSB 재파싱 상태: ${key}`);
}

await fs.writeFile(workbookPath, generated.bytes);
console.log(JSON.stringify({
    migrated: legacyMonthlyKeys.length,
    beforeRows: originalState.rows.length,
    afterRows: roundTrip.rows.length,
    beforeHistory: originalState.history.length,
    afterHistory: roundTrip.history.length,
    byteLength: generated.byteLength
}, null, 2));
