import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const dataRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = path.resolve(dataRoot, '..', '..');
const workbookPath = path.join(dataRoot, '회의_안건_현황.xlsb');
const sourceName = 'GitHub 회의록 파일 자동 점검';
const manualStatusSourcePattern = /(?:수동|원클릭|직접|사용자|로컬\s*XLSB|오프라인|원격\s*확인\s*후|카드)/;
const args = new Set(process.argv.slice(2));
const writeChanges = args.has('--write');
const checkOnly = args.has('--check');
const forceGitHub = args.has('--github');
const asOfArgument = [...args].find(value => value.startsWith('--as-of='));

globalThis.XLSX = require(path.join(dataRoot, 'vendor', 'xlsx.full.min.js'));
require(path.join(dataRoot, 'runtime', 'meeting-data-store.js'));
const store = globalThis.MeetingDataStore;
assert.ok(store, 'MeetingDataStore API를 불러오지 못했습니다.');

function pad2(value) {
    return String(value).padStart(2, '0');
}

function koreaToday() {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Seoul',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).formatToParts(new Date()).filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)]));
    return { year: parts.year, month: parts.month, day: parts.day };
}

function parseAsOfDate() {
    if (!asOfArgument) return koreaToday();
    const match = /^--as-of=(\d{4})-(\d{2})-(\d{2})$/.exec(asOfArgument);
    if (!match) throw new Error('--as-of는 YYYY-MM-DD 형식이어야 합니다.');
    return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

function getWeekInfoUtc(date) {
    const currentDay = date.getUTCDay() === 0 ? 7 : date.getUTCDay();
    const monday = new Date(date);
    monday.setUTCDate(date.getUTCDate() - (currentDay - 1));
    const thursday = new Date(monday);
    thursday.setUTCDate(monday.getUTCDate() + 3);
    return {
        key: `${thursday.getUTCFullYear()}-${thursday.getUTCMonth() + 1}-${Math.ceil(thursday.getUTCDate() / 7)}`,
        referenceDate: `${thursday.getUTCFullYear()}-${pad2(thursday.getUTCMonth() + 1)}-${pad2(thursday.getUTCDate())}`
    };
}

function buildMonthlyTimeline(asOf) {
    const rows = new Map();
    for (let year = 2014; year <= asOf.year; year += 1) {
        const lastMonth = year === asOf.year ? asOf.month : 12;
        for (let month = 1; month <= lastMonth; month += 1) {
            rows.set(`${year}-${month}`, `${year}-${pad2(month)}-01`);
        }
    }
    return rows;
}

function buildWeeklyTimeline(asOf) {
    const rows = new Map();
    const cursor = new Date(Date.UTC(2023, 1, 27)); // 2023년 3월 1주차가 속한 월요일
    const limit = new Date(Date.UTC(asOf.year, asOf.month - 1, asOf.day));
    while (cursor <= limit) {
        const info = getWeekInfoUtc(cursor);
        rows.set(info.key, info.referenceDate);
        cursor.setUTCDate(cursor.getUTCDate() + 7);
    }
    return rows;
}

function listLocalTree(repoPath) {
    const output = execFileSync('git', ['-C', repoPath, 'ls-tree', '-r', '--name-only', 'HEAD'], { encoding: 'utf8' });
    return {
        source: `local:${repoPath}`,
        revision: execFileSync('git', ['-C', repoPath, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
        paths: output.split(/\r?\n/).filter(Boolean)
    };
}

async function listGitHubTree(repo) {
    const headers = {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'meeting-status-reconciler'
    };
    if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    const response = await fetch(`https://api.github.com/repos/${repo}/git/trees/main?recursive=1`, { headers });
    if (!response.ok) throw new Error(`${repo} 파일 목록 조회 실패: HTTP ${response.status}`);
    const payload = await response.json();
    if (payload.truncated) throw new Error(`${repo} 파일 목록이 잘려 있어 안전하게 반영할 수 없습니다.`);
    return {
        source: `github:${repo}`,
        revision: payload.sha,
        paths: payload.tree.filter(item => item.type === 'blob').map(item => item.path)
    };
}

async function loadSourceTree(repo) {
    const localPath = path.resolve(repositoryRoot, '..', repo.split('/')[1]);
    if (!forceGitHub) {
        try {
            await fs.access(path.join(localPath, '.git'));
            return listLocalTree(localPath);
        } catch (_) { /* GitHub API 폴백 */ }
    }
    return listGitHubTree(repo);
}

function collectMeetingFiles(paths, type) {
    const pattern = type === '월간'
        ? /^(\d{4})\/(\d{4})_(\d{2})_회의록\.(html|pdf)$/i
        : /^(\d{4})\/(\d{4})_(\d{2})_(\d{2})_회의록\.(html|pdf)$/i;
    const files = new Map();
    for (const filePath of paths) {
        const match = pattern.exec(filePath);
        if (!match) continue;
        assert.equal(match[1], match[2], `폴더 연도와 파일 연도가 다릅니다: ${filePath}`);
        const key = type === '월간'
            ? `${Number(match[2])}-${Number(match[3])}`
            : `${Number(match[2])}-${Number(match[3])}-${Number(match[4])}`;
        if (files.has(key)) throw new Error(`동일 회의 키의 파일이 중복됩니다: ${key} (${files.get(key)}, ${filePath})`);
        files.set(key, filePath);
    }
    return files;
}

function parseKey(key) {
    const parts = key.split('-').map(Number);
    return { year: parts[0], month: parts[1], week: parts[2] || null };
}

function virtualWeeklyReferenceDate(key) {
    const { year, month, week } = parseKey(key);
    const day = Math.min(new Date(Date.UTC(year, month, 0)).getUTCDate(), Math.max(1, (week - 1) * 7));
    return `${year}-${pad2(month)}-${pad2(day)}`;
}

function buildExpectations(type, existingRows, files, timeline) {
    const keys = new Set([...existingRows.map(row => row.key), ...files.keys(), ...timeline.keys()]);
    return [...keys].sort((left, right) => {
        const a = parseKey(left);
        const b = parseKey(right);
        return a.year - b.year || a.month - b.month || Number(a.week || 0) - Number(b.week || 0);
    }).map(key => ({
        key,
        type,
        status: files.has(key) ? '작성' : '미작성',
        filePath: files.get(key) || '',
        referenceDate: timeline.get(key) || (type === '월간'
            ? `${parseKey(key).year}-${pad2(parseKey(key).month)}-01`
            : virtualWeeklyReferenceDate(key)),
        outsideTimeline: !timeline.has(key)
    }));
}

function auditRows(rows, files, expectations, type) {
    const byKey = new Map(rows.filter(row => row.type === type).map(row => [row.key, row]));
    const isAutomaticTarget = key => !isManualStatusOverride(byKey.get(key));
    return {
        fileButNotWritten: [...files.keys()].filter(key => isAutomaticTarget(key) && byKey.get(key)?.status !== '작성'),
        writtenWithoutFile: [...byKey.values()].filter(row => !isManualStatusOverride(row) && row.status === '작성' && !files.has(row.key)).map(row => row.key),
        missingManagedRows: expectations.filter(item => !byKey.has(item.key)).map(item => item.key),
        statusMismatches: expectations.filter(item => byKey.get(item.key) && !isManualStatusOverride(byKey.get(item.key)) && byKey.get(item.key).status !== item.status)
            .map(item => ({ key: item.key, expected: item.status, actual: byKey.get(item.key).status }))
    };
}

function isManualStatusOverride(row) {
    if (!row) return false;
    const source = String(row.source || '');
    return manualStatusSourcePattern.test(source);
}

assert.equal(isManualStatusOverride({ source: sourceName }), false, '자동 점검 행은 자동 관리 대상이어야 합니다.');
assert.equal(isManualStatusOverride({ source: '월간 회의 내비게이션 수동 상태 관리' }), true, '수동 지정 행을 식별해야 합니다.');

const asOf = parseAsOfDate();
const [monthlyTree, weeklyTree] = await Promise.all([
    loadSourceTree('JongGunelee/wyggkr'),
    loadSourceTree('JongGunelee/wyggkr03')
]);
const monthlyFiles = collectMeetingFiles(monthlyTree.paths, '월간');
const weeklyFiles = collectMeetingFiles(weeklyTree.paths, '주간');
const monthlyTimeline = buildMonthlyTimeline(asOf);
const weeklyTimeline = buildWeeklyTimeline(asOf);

const originalBytes = await fs.readFile(workbookPath);
const originalState = await store.parseXlsb('status', originalBytes);
const originalRowsByKey = new Map(originalState.rows.map(row => [row.key, structuredClone(row)]));
const originalHistoryById = new Map(originalState.history.map(row => [row.eventId, structuredClone(row)]));
const monthlyExpectations = buildExpectations('월간', originalState.rows.filter(row => row.type === '월간'), monthlyFiles, monthlyTimeline);
const weeklyExpectations = buildExpectations('주간', originalState.rows.filter(row => row.type === '주간'), weeklyFiles, weeklyTimeline);
const beforeAudit = {
    monthly: auditRows(originalState.rows, monthlyFiles, monthlyExpectations, '월간'),
    weekly: auditRows(originalState.rows, weeklyFiles, weeklyExpectations, '주간')
};

await store.create({ storage: 'memory' });
await store.replaceLocalData({ status: originalState }, { force: true });
const changedAt = new Date().toISOString();
const changedKeys = new Set();
const createdEventIds = new Set();

for (const expected of [...monthlyExpectations, ...weeklyExpectations]) {
    const current = originalRowsByKey.get(expected.key) || null;
    // 사용자가 화면에서 명시적으로 지정한 상태는 자동 파일 점검보다 우선한다.
    // 나머지 행은 기존과 동일하게 실제 회의록 파일 존재 여부로 자동 정합화한다.
    if (isManualStatusOverride(current)) continue;
    if (current?.status === expected.status) continue;
    const desired = current ? { ...current, status: expected.status } : {
        key: expected.key,
        status: expected.status,
        counterIncluded: 'Y',
        cardVisible: 'Y',
        referenceDate: expected.referenceDate,
        exceptionCode: expected.type === '주간' && expected.status === '작성' && expected.outsideTimeline ? 'FORCED_WEEK5' : '',
        note: expected.filePath ? `실제 회의록 파일 확인: ${expected.filePath}` : `${asOf.year}-${pad2(asOf.month)}-${pad2(asOf.day)} 기준 회의록 파일 없음`
    };
    if (current && expected.status === '작성' && current.counterIncluded === 'N') {
        desired.counterIncluded = 'Y';
        desired.cardVisible = 'Y';
        desired.exceptionCode = expected.type === '주간' && expected.outsideTimeline ? 'FORCED_WEEK5' : '';
        desired.note = expected.filePath ? `실제 회의록 파일 확인: ${expected.filePath}` : '';
    }
    const result = await store.upsertStatus({ ...desired, source: sourceName }, { source: sourceName, changedAt });
    assert.equal(result.changed, true, `${expected.key} 상태 변경이 생성되어야 합니다.`);
    changedKeys.add(expected.key);
    createdEventIds.add(result.event.eventId);
}

const reconciledState = store.getSnapshot().status;
for (const historyRow of reconciledState.history) {
    if (createdEventIds.has(historyRow.eventId)) historyRow.syncStatus = '완료';
}
for (const [key, before] of originalRowsByKey) {
    if (!changedKeys.has(key)) assert.deepEqual(reconciledState.rows.find(row => row.key === key), before, `변경 대상이 아닌 행 보존: ${key}`);
}
for (const [eventId, before] of originalHistoryById) {
    assert.deepEqual(reconciledState.history.find(row => row.eventId === eventId), before, `기존 변경이력 보존: ${eventId}`);
}
assert.equal(new Set(reconciledState.rows.map(row => row.key)).size, reconciledState.rows.length, '현재값 키 중복 금지');
assert.equal(new Set(reconciledState.history.map(row => row.eventId)).size, reconciledState.history.length, '변경이력 ID 중복 금지');

const generated = store.exportXlsb('status', reconciledState);
const roundTrip = await store.parseXlsb('status', generated.bytes);
const afterAudit = {
    monthly: auditRows(roundTrip.rows, monthlyFiles, monthlyExpectations, '월간'),
    weekly: auditRows(roundTrip.rows, weeklyFiles, weeklyExpectations, '주간')
};
for (const [type, audit] of Object.entries(afterAudit)) {
    for (const [name, values] of Object.entries(audit)) assert.equal(values.length, 0, `${type} ${name} 불일치`);
}

if (writeChanges && changedKeys.size) await fs.writeFile(workbookPath, generated.bytes);
const counts = Object.fromEntries(['월간', '주간'].map(type => {
    const rows = roundTrip.rows.filter(row => row.type === type);
    return [type, {
        sourceFiles: type === '월간' ? monthlyFiles.size : weeklyFiles.size,
        managedRows: rows.length,
        written: rows.filter(row => row.status === '작성').length,
        unwritten: rows.filter(row => row.status === '미작성').length
    }];
}));
const report = {
    asOf: `${asOf.year}-${pad2(asOf.month)}-${pad2(asOf.day)}`,
    sources: {
        monthly: { source: monthlyTree.source, revision: monthlyTree.revision },
        weekly: { source: weeklyTree.source, revision: weeklyTree.revision }
    },
    counts,
    changedKeys: [...changedKeys],
    beforeAudit,
    afterAudit,
    wroteWorkbook: writeChanges && changedKeys.size > 0,
    workbookBytes: generated.byteLength
};
console.log(JSON.stringify(report, null, 2));
if (checkOnly && changedKeys.size) process.exitCode = 1;
