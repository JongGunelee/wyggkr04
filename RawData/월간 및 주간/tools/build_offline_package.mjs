#!/usr/bin/env node
/**
 * 월간/주간 회의용 오프라인 패키지를 만든다.
 *
 * 예:
 *   node tools/build_offline_package.mjs \
 *     --html-root="C:/Users/PC/Downloads/01 코딩/02 월간 및 주간" \
 *     --out="C:/Users/PC/Downloads/01 코딩/02 월간 및 주간/offline-package"
 *
 * 기본값은 GitHub의 런타임 파일을 내려받고(--source=github), HTML은
 * --html-root에서 복사한다. 네트워크가 이미 차단된 경우 --source=local로
 * 같은 저장소의 런타임 파일을 사용해 패키지를 만들 수 있다.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const defaultHtmlRoot = path.resolve(repoRoot, '..', '..', '..', '..', '01 코딩', '02 월간 및 주간');
const githubRoot = 'https://raw.githubusercontent.com/JongGunelee/wyggkr04/main/RawData/%EC%9B%94%EA%B0%84%20%EB%B0%8F%20%EC%A3%BC%EA%B0%84';

const args = Object.fromEntries(process.argv.slice(2).map((arg) => {
    const match = arg.match(/^--([^=]+)(?:=(.*))?$/);
    return match ? [match[1], match[2] ?? 'true'] : [arg, 'true'];
}));

const source = String(args.source || 'github').toLowerCase();
if (!['github', 'local'].includes(source)) throw new Error('--source는 github 또는 local이어야 합니다.');
const htmlRoot = path.resolve(String(args['html-root'] || defaultHtmlRoot));
const outDir = path.resolve(String(args.out || path.join(htmlRoot, 'offline-package')));
const shouldVerify = args.verify === 'true';

const assets = [
    { remote: 'runtime/meeting-navigator-status-bridge.js', local: 'runtime/meeting-navigator-status-bridge.js', packagePath: 'offline-runtime/meeting-navigator-status-bridge.js' },
    { remote: 'runtime/meeting-data-store.js', local: 'runtime/meeting-data-store.js', packagePath: 'offline-runtime/meeting-data-store.js' },
    { remote: 'runtime/meeting-github-credential.js', local: 'runtime/meeting-github-credential.js', packagePath: 'offline-runtime/meeting-github-credential.js' },
    { remote: 'runtime/meeting-data-bootstrap.js', local: 'runtime/meeting-data-bootstrap.js', packagePath: 'offline-runtime/meeting-data-bootstrap.js' },
    { remote: 'vendor/xlsx.full.min.js', local: 'vendor/xlsx.full.min.js', packagePath: 'vendor/xlsx.full.min.js' },
    { remote: '회의_안건_현황.xlsb', local: '회의_안건_현황.xlsb', packagePath: 'data/회의_안건_현황.xlsb' },
    { remote: '회의_요약_메모.xlsb', local: '회의_요약_메모.xlsb', packagePath: 'data/회의_요약_메모.xlsb' }
];
const htmlFiles = ['월간 회의.html', '주간 회의.html'];

async function sha256(filePath) {
    const data = await fs.readFile(filePath);
    return { sha256: crypto.createHash('sha256').update(data).digest('hex'), bytes: data.byteLength };
}

async function ensureParent(filePath) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
}

async function copyLocal(sourcePath, targetPath) {
    await ensureParent(targetPath);
    await fs.copyFile(sourcePath, targetPath);
}

async function fetchRemote(url, targetPath) {
    const response = await fetch(url, { redirect: 'follow' });
    if (!response.ok) throw new Error(`다운로드 실패 (${response.status}): ${url}`);
    await ensureParent(targetPath);
    await fs.writeFile(targetPath, Buffer.from(await response.arrayBuffer()));
}

async function assertFile(filePath, label) {
    try { await fs.access(filePath); }
    catch { throw new Error(`${label} 파일을 찾을 수 없습니다: ${filePath}`); }
}

async function build() {
    if (shouldVerify) return verify();
    await fs.rm(outDir, { recursive: true, force: true });
    await fs.mkdir(outDir, { recursive: true });

    const manifestFiles = [];
    for (const fileName of htmlFiles) {
        const sourcePath = path.join(htmlRoot, fileName);
        await assertFile(sourcePath, 'HTML');
        const targetPath = path.join(outDir, fileName);
        await copyLocal(sourcePath, targetPath);
        const digest = await sha256(targetPath);
        manifestFiles.push({ path: fileName, source: `local:${sourcePath}`, ...digest });
    }
    for (const asset of assets) {
        const targetPath = path.join(outDir, asset.packagePath);
        const localPath = path.join(repoRoot, asset.local);
        if (source === 'local') {
            await assertFile(localPath, '런타임');
            await copyLocal(localPath, targetPath);
        } else {
            await fetchRemote(`${githubRoot}/${asset.remote}`, targetPath);
        }
        const digest = await sha256(targetPath);
        manifestFiles.push({ path: asset.packagePath, source: source === 'local' ? `local:${localPath}` : `${githubRoot}/${asset.remote}`, ...digest });
    }

    const contentHash = crypto.createHash('sha256')
        .update(manifestFiles.map((file) => `${file.path}\0${file.sha256}\0${file.bytes}`).join('\n'))
        .digest('hex');
    const manifest = {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        source,
        htmlFiles,
        files: manifestFiles,
        contentHash,
        instructions: '같은 폴더 구조를 유지한 채 HTML을 열면, 온라인 실패 시 offline-runtime의 읽기 전용 상태 스냅샷을 사용합니다.'
    };
    await fs.writeFile(path.join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    const offlineReadme = [
        '# 월간/주간 회의 오프라인 패키지',
        '',
        '- `월간 회의.html` 또는 `주간 회의.html`을 이 폴더에서 엽니다.',
        '- `offline-runtime/`과 `vendor/`는 HTML과 같은 위치에 있어야 합니다.',
        '- 온라인에서 동기화한 브라우저 캐시가 우선이며, 최초 오프라인 실행에는 `offline-runtime/meeting-data-bootstrap.js`의 읽기 전용 스냅샷이 사용됩니다.',
        '- `manifest.json`의 SHA-256으로 파일 변조/누락을 확인할 수 있습니다.',
        '- 검증: `node tools/build_offline_package.mjs --out=... --verify`',
        ''
    ].join('\n');
    await fs.writeFile(path.join(outDir, 'README-offline.md'), offlineReadme, 'utf8');
    console.log(`오프라인 패키지 생성 완료: ${outDir}`);
    console.log(`파일 ${manifestFiles.length}개 · contentHash ${contentHash}`);
}

async function verify() {
    const manifestPath = path.join(outDir, 'manifest.json');
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    const results = [];
    for (const expected of manifest.files || []) {
        const targetPath = path.join(outDir, expected.path);
        try {
            const actual = await sha256(targetPath);
            results.push({ path: expected.path, ok: actual.sha256 === expected.sha256 && actual.bytes === expected.bytes });
        } catch {
            results.push({ path: expected.path, ok: false });
        }
    }
    const failed = results.filter((result) => !result.ok);
    if (failed.length) throw new Error(`오프라인 패키지 검증 실패: ${failed.map((result) => result.path).join(', ')}`);
    console.log(`오프라인 패키지 검증 통과: ${results.length}개 파일`);
}

build().catch((error) => { console.error(error.message || error); process.exitCode = 1; });
