import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const dataRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bridgePath = path.join(dataRoot, 'runtime', 'meeting-navigator-status-bridge.js');
const source = await fs.readFile(bridgePath, 'utf8');
new vm.Script(source, { filename: bridgePath });

let statusRows = [{ key: '2026-8', type: '월간', status: '작성', cardVisible: 'Y', counterIncluded: 'Y' }];
let pending = 0;
const store = {
    configure() {},
    getSnapshot() { return { status: { rows: statusRows }, memo: { rows: [] } }; },
    getRows(kind) { assert.equal(kind, 'status'); return structuredClone(statusRows); },
    async pendingCount(kind) { assert.equal(kind, 'status'); return pending; },
    async load(options) {
        assert.equal(options.dataset, 'status');
        assert.equal(options.overlayPending, true);
        return { status: { ok: true, exists: true, pendingCount: pending } };
    },
    async setStatus(key, status) {
        statusRows = statusRows.map(row => row.key === key ? { ...row, status } : row);
        pending += 1;
        return { changed: true, row: statusRows.find(row => row.key === key), event: { eventId: 'test-event' } };
    },
    async upsertStatus(row) {
        statusRows.push({ ...row, type: row.key.split('-').length === 2 ? '월간' : '주간' });
        pending += 1;
        return { changed: true, row, event: { eventId: 'test-event-new' } };
    },
    async syncDataset() { throw new Error('인증 취소 경로에서는 호출되면 안 됩니다.'); }
};

const windowObject = {
    XLSX: { read() {} },
    MeetingDataStore: {
        async create() { return store; },
        configure() {}
    },
    MeetingGithubCredential: {
        configure() { return { async ensureToken() { return ''; } }; }
    },
    document: {
        currentScript: { src: 'https://example.test/runtime/meeting-navigator-status-bridge.js' },
        createElement() { throw new Error('이미 제공된 의존성을 다시 로드하면 안 됩니다.'); }
    },
    setTimeout,
    clearTimeout,
    dispatchEvent() {},
    CustomEvent: class CustomEvent {
        constructor(type, options) { this.type = type; this.detail = options?.detail; }
    }
};
const context = vm.createContext({
    window: windowObject,
    globalThis: windowObject,
    URL,
    Map,
    Set,
    Promise,
    Object,
    Array,
    Number,
    String,
    Boolean,
    Date,
    TypeError,
    Error,
    console,
    structuredClone
});
new vm.Script(source, { filename: bridgePath }).runInContext(context);

const bridge = windowObject.MeetingNavigatorStatusBridge;
assert.ok(bridge, 'bridge API가 노출되어야 합니다.');
assert.equal(bridge.statuses.written, '작성');
assert.equal(bridge.statuses.skipped, '미작성');

const client = await bridge.create({ type: '월간', source: '검증' });
const refreshPayload = await client.refresh();
assert.equal(refreshPayload.rows.length, 1);
assert.equal(refreshPayload.rows[0].status, '작성');

const queuedResult = await client.setStatus('2026-8', '미작성');
assert.equal(queuedResult.ok, false);
assert.equal(queuedResult.queued, true);
assert.equal(client.row('2026-8').status, '미작성');
assert.equal(await client.pendingCount(), 1);

await assert.rejects(() => bridge.create({ type: '일간' }), /지원하지 않는 회의 유형/);
await assert.rejects(() => client.setStatus('2026-8', '보류'), /지원하지 않는 작성 상태/);

if (/github_pat_[A-Za-z0-9_]+|ghp_[A-Za-z0-9]+/.test(source)) {
    throw new Error('브리지 소스에 GitHub 토큰 형태의 문자열이 포함되어 있습니다.');
}

console.log('navigator status bridge validation passed');
