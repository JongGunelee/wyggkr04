import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const XLSX = require('../../RawData/월간 및 주간/vendor/xlsx.full.min.js');
const repositoryRoot = process.cwd();
const statusPath = 'RawData/월간 및 주간/회의_안건_현황.xlsb';
const memoPath = 'RawData/월간 및 주간/회의_요약_메모.xlsb';
const bootstrapPath = 'RawData/월간 및 주간/runtime/meeting-data-bootstrap.js';
const MIN_RETAINED_RATIO = 0.75;
const phase = process.argv.includes('--post') ? 'post' : 'preflight';

function fail(message, details = {}) {
    console.error(JSON.stringify({ ok: false, phase, error: message, ...details }, null, 2));
    process.exitCode = 1;
}

function sha256(bytes) {
    return createHash('sha256').update(bytes).digest('hex');
}

function readWorkingTree(relativePath) {
    const absolutePath = path.join(repositoryRoot, relativePath);
    if (!fs.existsSync(absolutePath)) throw new Error(`필수 파일이 없습니다: ${relativePath}`);
    return fs.readFileSync(absolutePath);
}

function readParent(relativePath) {
    try {
        return execFileSync('git', ['show', `HEAD^:${relativePath}`], { cwd: repositoryRoot, encoding: 'buffer' });
    } catch (_) {
        return null;
    }
}

function rowsFor(workbook, sheetName) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) throw new Error(`필수 시트가 없습니다: ${sheetName}`);
    return XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: false });
}

function hasHeader(rows, names, sheetName) {
    const header = (rows[0] || []).map(value => String(value).trim());
    for (const name of names) {
        if (!header.includes(name)) throw new Error(`${sheetName} 시트에 필수 열이 없습니다: ${name}`);
    }
}

function inspectWorkbook(bytes, kind, label = kind, allowEmpty = false) {
    if (bytes.length < 1024) throw new Error(`${label} 파일 크기가 비정상적으로 작습니다: ${bytes.length} bytes`);
    let workbook;
    try {
        workbook = XLSX.read(bytes, { type: 'buffer' });
    } catch (error) {
        throw new Error(`${label} XLSB 파싱 실패: ${error.message}`);
    }
    const requiredSheets = kind === 'status'
        ? ['요약', '안건현황', '변경이력', '데이터사전']
        : ['요약', '회의요약', '변경이력', '사용안내'];
    for (const sheetName of requiredSheets) {
        if (!workbook.SheetNames.includes(sheetName)) throw new Error(`${label} 필수 시트 누락: ${sheetName}`);
    }
    const dataSheetName = kind === 'status' ? '안건현황' : '회의요약';
    const historySheetName = '변경이력';
    const dataRows = rowsFor(workbook, dataSheetName);
    const historyRows = rowsFor(workbook, historySheetName);
    hasHeader(dataRows, kind === 'status' ? ['안건키', '상태'] : ['안건키', '회의요약'], dataSheetName);
    hasHeader(historyRows, ['이력ID'], `${label}.${historySheetName}`);
    const dataCount = Math.max(0, dataRows.length - 1);
    const historyCount = Math.max(0, historyRows.length - 1);
    if (kind === 'status' && dataCount === 0 && !allowEmpty) throw new Error('status 데이터 행이 0개입니다. 빈/축소된 XLSB를 차단합니다.');
    return { label, bytes: bytes.length, sha256: sha256(bytes), dataCount, historyCount };
}

function compareWithParent(current, parent, label) {
    if (!parent) return { baseline: null, ratio: null };
    const ratio = current.dataCount / Math.max(1, parent.dataCount);
    const historyRatio = current.historyCount / Math.max(1, parent.historyCount);
    if (parent.dataCount > 0 && ratio < MIN_RETAINED_RATIO) {
        throw new Error(`${label} 데이터 행 급감: ${parent.dataCount} → ${current.dataCount} (${(ratio * 100).toFixed(1)}%)`);
    }
    if (parent.historyCount > 0 && historyRatio < MIN_RETAINED_RATIO) {
        throw new Error(`${label} 변경이력 급감: ${parent.historyCount} → ${current.historyCount} (${(historyRatio * 100).toFixed(1)}%)`);
    }
    return { baseline: parent, ratio, historyRatio };
}

function readBootstrap() {
    const text = fs.readFileSync(path.join(repositoryRoot, bootstrapPath), 'utf8');
    const match = text.match(/window\.MEETING_DATA_BOOTSTRAP=Object\.freeze\((\{[\s\S]*\})\);\s*$/);
    if (!match) throw new Error('meeting-data-bootstrap.js의 부트스트랩 형식을 해석할 수 없습니다.');
    return JSON.parse(match[1]);
}

function validateBootstrap(bootstrap, status, memo) {
    if (bootstrap.schemaVersion !== 1) throw new Error(`지원하지 않는 부트스트랩 schemaVersion: ${bootstrap.schemaVersion}`);
    const combinedSha = sha256(Buffer.concat([Buffer.from(readWorkingTree(statusPath)), Buffer.from(readWorkingTree(memoPath))]));
    if (bootstrap.sourceSha256 !== combinedSha) {
        throw new Error(`부트스트랩 sourceSha256 불일치: ${bootstrap.sourceSha256} != ${combinedSha}`);
    }
    for (const [label, current] of [['status', status], ['memo', memo]]) {
        const descriptor = bootstrap.sourceFiles?.[label];
        if (!descriptor || descriptor.sha256 !== current.sha256 || Number(descriptor.byteLength) !== current.bytes) {
            throw new Error(`${label} 부트스트랩 파일 지문이 현재 XLSB와 일치하지 않습니다.`);
        }
        const rows = bootstrap[label]?.rows;
        const history = bootstrap[label]?.history;
        if (!Array.isArray(rows) || !Array.isArray(history)) throw new Error(`${label} 부트스트랩 rows/history 형식 오류`);
        if (rows.length !== current.dataCount || history.length !== current.historyCount) {
            throw new Error(`${label} 부트스트랩 행 수 불일치: rows ${rows.length}/${current.dataCount}, history ${history.length}/${current.historyCount}`);
        }
    }
}

try {
    const statusBytes = readWorkingTree(statusPath);
    const memoBytes = readWorkingTree(memoPath);
    const status = inspectWorkbook(statusBytes, 'status');
    const memo = inspectWorkbook(memoBytes, 'memo');
    const statusParentBytes = readParent(statusPath);
    const memoParentBytes = readParent(memoPath);
    const statusParent = statusParentBytes ? inspectWorkbook(statusParentBytes, 'status', 'status(parent)', true) : null;
    const memoParent = memoParentBytes ? inspectWorkbook(memoParentBytes, 'memo', 'memo(parent)', true) : null;
    const statusComparison = compareWithParent(status, statusParent, 'status');
    const memoComparison = compareWithParent(memo, memoParent, 'memo');
    if (phase === 'post') validateBootstrap(readBootstrap(), status, memo);
    console.log(JSON.stringify({
        ok: true,
        phase,
        repository: 'JongGunelee/wyggkr04',
        status,
        memo,
        parent: { status: statusComparison, memo: memoComparison },
        bootstrapChecked: phase === 'post'
    }, null, 2));
} catch (error) {
    fail(error.message);
}
