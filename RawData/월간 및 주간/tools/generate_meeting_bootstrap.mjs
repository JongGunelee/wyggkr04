import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const dataRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const statusPath = resolve(dataRoot, '회의_안건_현황.xlsb');
const memoPath = resolve(dataRoot, '회의_요약_메모.xlsb');
const bootstrapPath = resolve(dataRoot, 'runtime', 'meeting-data-bootstrap.js');

globalThis.XLSX = require(resolve(dataRoot, 'vendor', 'xlsx.full.min.js'));
require(resolve(dataRoot, 'runtime', 'meeting-data-store.js'));

const [statusBytes, memoBytes] = await Promise.all([readFile(statusPath), readFile(memoPath)]);
await globalThis.MeetingDataStore.create({ storage: 'memory' });
const [status, memo] = await Promise.all([
    globalThis.MeetingDataStore.parseXlsb('status', statusBytes),
    globalThis.MeetingDataStore.parseXlsb('memo', memoBytes)
]);

const sha256 = createHash('sha256')
    .update(statusBytes)
    .update(memoBytes)
    .digest('hex');
const data = {
    schemaVersion: globalThis.MeetingDataStore.schemaVersion,
    generatedFrom: 'RawData/월간 및 주간/*.xlsb',
    sourceSha256: sha256,
    status: { rows: status.rows, history: status.history },
    memo: { rows: memo.rows, history: memo.history }
};

const json = JSON.stringify(data, null, 2).replaceAll('<', '\\u003c');
const output = `/* XLSB에서 자동 생성된 직접 파일 실행용 읽기 전용 폴백입니다. 수동 편집하지 마세요. */\nwindow.MEETING_DATA_BOOTSTRAP=Object.freeze(${json});\n`;
if (process.argv.includes('--write')) {
    await writeFile(bootstrapPath, output, 'utf8');
    process.stdout.write(`${bootstrapPath}\n`);
} else {
    process.stdout.write(output);
}
