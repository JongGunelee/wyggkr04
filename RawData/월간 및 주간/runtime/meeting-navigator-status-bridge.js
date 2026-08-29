(function (global) {
    'use strict';

    if (global.MeetingNavigatorStatusBridge) return;

    const VERSION = '1.0.0';
    const STATUS_WRITTEN = '작성';
    const STATUS_SKIPPED = '미작성';
    const DEFAULT_GITHUB = Object.freeze({
        repo: 'JongGunelee/wyggkr04',
        branch: 'main',
        statusPath: 'RawData/월간 및 주간/회의_안건_현황.xlsb',
        memoPath: 'RawData/월간 및 주간/회의_요약_메모.xlsb',
        remoteVaultPath: 'RawData/공정관리/encrypted-pat.json'
    });
    const DEFAULT_REMOTE_SCRIPT = 'https://jonggunelee.github.io/wyggkr04/RawData/%EC%9B%94%EA%B0%84%20%EB%B0%8F%20%EC%A3%BC%EA%B0%84/runtime/meeting-navigator-status-bridge.js';
    const bridgeScriptUrl = (() => {
        const current = global.document && global.document.currentScript;
        try { return new URL(current && current.src ? current.src : DEFAULT_REMOTE_SCRIPT); }
        catch (_) { return new URL(DEFAULT_REMOTE_SCRIPT); }
    })();
    const scriptPromises = new Map();
    let dependenciesPromise = null;
    let storePromise = null;

    function loadScript(url, ready) {
        if (ready()) return Promise.resolve();
        const href = String(url);
        if (scriptPromises.has(href)) return scriptPromises.get(href);
        const promise = new Promise((resolve, reject) => {
            const script = global.document.createElement('script');
            const timeout = global.setTimeout(() => {
                script.remove();
                reject(new Error(`스크립트 로드 시간이 초과되었습니다: ${href}`));
            }, 15000);
            script.src = href;
            script.async = true;
            script.onload = () => {
                global.clearTimeout(timeout);
                if (ready()) resolve();
                else reject(new Error(`스크립트가 필수 API를 제공하지 않습니다: ${href}`));
            };
            script.onerror = () => {
                global.clearTimeout(timeout);
                reject(new Error(`스크립트를 불러오지 못했습니다: ${href}`));
            };
            (global.document.head || global.document.documentElement).appendChild(script);
        });
        const retryablePromise = promise.catch(error => {
            scriptPromises.delete(href);
            throw error;
        });
        scriptPromises.set(href, retryablePromise);
        return retryablePromise;
    }

    async function ensureDependencies() {
        if (dependenciesPromise) return dependenciesPromise;
        dependenciesPromise = (async () => {
            const runtimeBase = new URL('./', bridgeScriptUrl);
            await loadScript(new URL('../vendor/xlsx.full.min.js', runtimeBase), () => Boolean(global.XLSX && global.XLSX.read));
            await loadScript(new URL('meeting-data-store.js', runtimeBase), () => Boolean(global.MeetingDataStore));
            await loadScript(new URL('meeting-github-credential.js', runtimeBase), () => Boolean(global.MeetingGithubCredential));
            // 오프라인 패키지에 함께 배포된 읽기 전용 배틀을 선택적으로 로드한다. 
            // 최신 캐시/아웃박스가 있으면 기존 데이터를 덮어쓰지 않고, 처음 열는 오프라인 패키지에서만 폴백으로 사용한다.
            try {
                await loadScript(new URL('meeting-data-bootstrap.js', runtimeBase), () => Boolean(global.MEETING_DATA_BOOTSTRAP));
            } catch (_) {
                // 원격 배포에 배틀이 없어도 기존 원격/캐시 로직은 계속 사용한다.
            }
        })().catch(error => {
            dependenciesPromise = null;
            throw error;
        });
        return dependenciesPromise;
    }

    function normalizeGithub(options) {
        const supplied = options && options.github ? options.github : {};
        return { ...DEFAULT_GITHUB, ...supplied };
    }

    async function getStore(github) {
        if (!storePromise) {
            storePromise = (async () => {
                await ensureDependencies();
                return global.MeetingDataStore.create({ github });
            })().catch(error => {
                storePromise = null;
                throw error;
            });
        } else {
            await ensureDependencies();
            global.MeetingDataStore.configure({ github });
        }
        return storePromise;
    }

    function normalizeType(type) {
        if (type !== '월간' && type !== '주간') throw new TypeError(`지원하지 않는 회의 유형입니다: ${type}`);
        return type;
    }

    function normalizeStatus(status) {
        if (status !== STATUS_WRITTEN && status !== STATUS_SKIPPED) {
            throw new TypeError(`지원하지 않는 작성 상태입니다: ${status}`);
        }
        return status;
    }

    function publicError(error) {
        return {
            name: error && error.name ? error.name : 'Error',
            code: error && error.code ? error.code : '',
            message: error && error.message ? error.message : String(error || '알 수 없는 오류')
        };
    }

    async function create(options) {
        const settings = options || {};
        const type = normalizeType(settings.type);
        const github = normalizeGithub(settings);
        const source = String(settings.source || `${type} 회의 내비게이션 상태 관리`);
        const store = await getStore(github);
        const credential = global.MeetingGithubCredential.configure({
            tokenConsumer: store,
            defaultPin: settings.defaultPin || '2026xlsb',
            github: {
                repo: github.repo,
                branch: github.branch,
                remoteVaultPath: github.remoteVaultPath
            }
        });
        const listeners = new Set();
        let lastRemoteResult = null;

        const emit = async (reason, detail) => {
            const snapshot = store.getSnapshot();
            const pendingCount = await store.pendingCount('status');
            const payload = Object.freeze({
                reason,
                type,
                rows: snapshot.status.rows.filter(row => row.type === type),
                pendingCount,
                remote: lastRemoteResult,
                ...(detail || {})
            });
            listeners.forEach(listener => {
                try { listener(payload); } catch (error) { global.setTimeout(() => { throw error; }, 0); }
            });
            if (typeof global.CustomEvent === 'function') {
                global.dispatchEvent(new global.CustomEvent('meeting-navigator-status-change', { detail: payload }));
            }
            return payload;
        };

        const rows = () => store.getRows('status').filter(row => row.type === type);

        async function refresh() {
            const results = await store.load({
                dataset: 'status',
                overlayPending: true,
                throwOnError: false
            });
            lastRemoteResult = results.status || null;
            let fallbackApplied = false;
            const bootstrap = global.MEETING_DATA_BOOTSTRAP;
            if (!(lastRemoteResult && lastRemoteResult.ok) && bootstrap && bootstrap.status && Array.isArray(bootstrap.status.rows)) {
                const currentRows = store.getRows('status');
                const pendingCount = await store.pendingCount('status');
                // 전에 성공한 캐시 또는 사용자 편집 아웃박스가 있을 때는 덮어쓰지 않아 무결성을 보장한다.
                if (currentRows.length === 0 && pendingCount === 0) {
                    await store.replaceLocalData({ status: bootstrap.status, memo: bootstrap.memo }, { force: false });
                    fallbackApplied = true;
                    lastRemoteResult = { ok: false, source: 'offline-bundle', reason: 'bootstrap' };
                }
            }
            return emit(fallbackApplied ? 'offline-bundle' : (lastRemoteResult && lastRemoteResult.ok ? 'remote-loaded' : 'offline-cache'), {
                error: lastRemoteResult && lastRemoteResult.error ? publicError(lastRemoteResult.error) : null
            });
        }

        async function setStatus(key, status) {
            const normalizedStatus = normalizeStatus(status);
            const existing = store.getRows('status').find(row => row.key === String(key));
            const changedAt = new Date().toISOString();
            const change = existing
                ? await store.setStatus(String(key), normalizedStatus, { source, changedAt })
                : await store.upsertStatus({
                    key: String(key),
                    status: normalizedStatus,
                    counterIncluded: 'Y',
                    cardVisible: 'Y',
                    source,
                    exceptionCode: '',
                    note: '월간/주간 회의 내비게이션에서 생성'
                }, { source, changedAt });
            await emit('local-change', { key: String(key), status: normalizedStatus, changed: change.changed });
            if (!change.changed) return { ok: true, skipped: true, queued: false, change };

            const token = await credential.ensureToken({ allowPrompt: true, allowSetup: true });
            if (!token) {
                const pendingCount = await store.pendingCount('status');
                await emit('sync-pending', { key: String(key), status: normalizedStatus, pendingCount });
                return { ok: false, queued: true, reason: 'AUTH_CANCELLED', pendingCount, change };
            }
            try {
                const result = await store.syncDataset('status', {
                    token,
                    keys: [String(key)],
                    publishMissing: false,
                    allowRemoteCreate: false,
                    message: `[MeetingData] ${type} 내비게이션 ${key} ${normalizedStatus}`
                });
                lastRemoteResult = { ok: true, source: 'sync' };
                await emit('synced', { key: String(key), status: normalizedStatus, result });
                return { ok: true, queued: false, change, result };
            } catch (error) {
                const pendingCount = await store.pendingCount('status');
                await emit('sync-error', { key: String(key), status: normalizedStatus, pendingCount, error: publicError(error) });
                return { ok: false, queued: true, pendingCount, error: publicError(error), change };
            }
        }

        async function syncPending() {
            const pendingBefore = await store.pendingCount('status');
            if (!pendingBefore) return emit('synced', { skipped: true });
            const token = await credential.ensureToken({ allowPrompt: true, allowSetup: true });
            if (!token) return emit('sync-pending', { reasonCode: 'AUTH_CANCELLED' });
            try {
                const result = await store.syncDataset('status', {
                    token,
                    publishMissing: false,
                    allowRemoteCreate: false,
                    message: `[MeetingData] ${type} 내비게이션 대기 변경 동기화`
                });
                lastRemoteResult = { ok: true, source: 'sync' };
                return emit('synced', { result });
            } catch (error) {
                return emit('sync-error', { error: publicError(error) });
            }
        }

        return Object.freeze({
            version: VERSION,
            type,
            github: Object.freeze({ ...github }),
            refresh,
            setStatus,
            syncPending,
            rows,
            row(key) { return rows().find(item => item.key === String(key)) || null; },
            async pendingCount() { return store.pendingCount('status'); },
            subscribe(listener) {
                if (typeof listener !== 'function') throw new TypeError('listener는 함수여야 합니다.');
                listeners.add(listener);
                return () => listeners.delete(listener);
            }
        });
    }

    global.MeetingNavigatorStatusBridge = Object.freeze({
        version: VERSION,
        statuses: Object.freeze({ written: STATUS_WRITTEN, skipped: STATUS_SKIPPED }),
        create
    });
})(typeof window !== 'undefined' ? window : globalThis);
