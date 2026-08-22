(function attachMeetingDataStore(global) {
    'use strict';

    const SCHEMA_VERSION = 1;
    const JSONL_FORMAT = 'meeting-data-store-jsonl';
    const SNAPSHOT_ID = 'current';
    const DATASET_STATUS = 'status';
    const DATASET_MEMO = 'memo';
    const VALID_DATASETS = new Set([DATASET_STATUS, DATASET_MEMO]);
    const MAX_GITHUB_CONFLICT_RETRIES = 3;
    const MAX_EXCEL_CELL_CHARACTERS = 32767;
    const MAX_XLSB_BYTES = 50 * 1024 * 1024;

    const STATUS_HEADERS = [
        '안건키', '구분', '연도', '월', '주차', '상태', '카운터포함', '카드표시', '기준일', '수정일시', '수정경로', '예외코드', '비고'
    ];
    const STATUS_HISTORY_HEADERS = [
        '이력ID', '변경일시', '안건키', '구분', '이전값', '변경값', '변경경로', '동기화상태'
    ];
    const MEMO_HEADERS = [
        '안건키', '구분', '연도', '월', '주차', '회의요약', '수정일시', '수정경로', '리비전'
    ];
    const MEMO_HISTORY_HEADERS = [
        '이력ID', '변경일시', '안건키', '구분', '이전요약', '변경요약', '변경경로', '동기화상태', '리비전'
    ];

    const DEFAULT_CONFIG = Object.freeze({
        dbName: 'monthly-weekly-meeting-data',
        dbVersion: 1,
        storage: 'auto',
        github: {
            repo: 'JongGunelee/wyggkr04',
            branch: 'main',
            statusPath: 'RawData/월간 및 주간/회의_안건_현황.xlsb',
            memoPath: 'RawData/월간 및 주간/회의_요약_메모.xlsb',
            apiVersion: '2022-11-28',
            mutationDelayMs: 1000
        }
    });

    class MeetingDataStoreError extends Error {
        constructor(message, code, details) {
            super(message);
            this.name = 'MeetingDataStoreError';
            this.code = code || 'MEETING_DATA_STORE_ERROR';
            if (details !== undefined) this.details = details;
        }
    }

    class SchemaError extends MeetingDataStoreError {
        constructor(message, details) {
            super(message, 'INVALID_WORKBOOK_SCHEMA', details);
            this.name = 'SchemaError';
        }
    }

    class GitHubError extends MeetingDataStoreError {
        constructor(message, status, details) {
            super(message, 'GITHUB_ERROR', details);
            this.name = 'GitHubError';
            this.status = status || 0;
        }
    }

    class ConflictError extends MeetingDataStoreError {
        constructor(message, conflicts) {
            super(message, 'DATA_CONFLICT', { conflicts });
            this.name = 'ConflictError';
            this.conflicts = conflicts || [];
        }
    }

    let config = clone(DEFAULT_CONFIG);
    let sessionToken = '';
    let databasePromise = null;
    let initialized = false;
    let snapshot = createEmptySnapshot();
    let memoryOutbox = new Map();
    let localOperationChain = Promise.resolve();
    let syncChain = Promise.resolve();
    let fetchImplementation = null;
    let lastEventSequence = 0;
    const loadGeneration = { status: 0, memo: 0 };
    const listeners = new Set();

    function clone(value) {
        if (value === undefined) return undefined;
        if (typeof global.structuredClone === 'function') {
            try { return global.structuredClone(value); } catch (_) { /* JSON fallback */ }
        }
        return JSON.parse(JSON.stringify(value));
    }

    function createDatasetState() {
        return { rows: [], history: [], remoteSha: null, loadedAt: null };
    }

    function createEmptySnapshot() {
        return {
            id: SNAPSHOT_ID,
            schemaVersion: SCHEMA_VERSION,
            savedAt: null,
            status: createDatasetState(),
            memo: createDatasetState()
        };
    }

    function normalizeSnapshot(value) {
        const empty = createEmptySnapshot();
        if (!value || typeof value !== 'object') return empty;
        for (const kind of VALID_DATASETS) {
            const incoming = value[kind] || {};
            empty[kind] = {
                rows: Array.isArray(incoming.rows) ? incoming.rows : [],
                history: Array.isArray(incoming.history) ? incoming.history : [],
                remoteSha: typeof incoming.remoteSha === 'string' ? incoming.remoteSha : null,
                loadedAt: typeof incoming.loadedAt === 'string' ? incoming.loadedAt : null
            };
        }
        empty.savedAt = typeof value.savedAt === 'string' ? value.savedAt : null;
        return empty;
    }

    function assertInitialized() {
        if (!initialized) {
            throw new MeetingDataStoreError('MeetingDataStore.init() must complete first.', 'NOT_INITIALIZED');
        }
    }

    function assertDataset(kind) {
        if (!VALID_DATASETS.has(kind)) {
            throw new MeetingDataStoreError(`Unknown dataset: ${kind}`, 'INVALID_DATASET');
        }
    }

    function getXlsx() {
        const xlsx = global.XLSX || (typeof XLSX !== 'undefined' ? XLSX : null);
        if (!xlsx || !xlsx.read || !xlsx.write || !xlsx.utils) {
            throw new MeetingDataStoreError('SheetJS global XLSX is not loaded.', 'XLSX_NOT_LOADED');
        }
        return xlsx;
    }

    function nowIso() {
        return new Date().toISOString();
    }

    function emit(type, detail) {
        const payload = Object.freeze({ type, ...(detail || {}) });
        for (const listener of listeners) {
            try { listener(payload); } catch (error) { setTimeout(() => { throw error; }, 0); }
        }
        if (typeof global.dispatchEvent === 'function' && typeof global.CustomEvent === 'function') {
            global.dispatchEvent(new global.CustomEvent('meeting-data-store-change', { detail: payload }));
        }
    }

    function subscribe(listener) {
        if (typeof listener !== 'function') throw new TypeError('listener must be a function');
        listeners.add(listener);
        return () => listeners.delete(listener);
    }

    function serializeLocal(operation) {
        const execute = async () => {
            if (initialized && !shouldUseMemoryStorage()) {
                const stored = await readStoredSnapshot();
                if (stored) snapshot = normalizeSnapshot(stored);
            }
            return operation();
        };
        const executeWithCrossTabLock = () => {
            const locks = global.navigator && global.navigator.locks;
            if (!shouldUseMemoryStorage() && locks && typeof locks.request === 'function') {
                return locks.request(`meeting-data-store:${config.dbName}`, { mode: 'exclusive' }, execute);
            }
            return execute();
        };
        const task = localOperationChain.then(executeWithCrossTabLock, executeWithCrossTabLock);
        localOperationChain = task.catch(() => undefined);
        return task;
    }

    function requestPromise(request) {
        return new Promise((resolve, reject) => {
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error || new Error('IndexedDB request failed.'));
        });
    }

    function transactionPromise(transaction) {
        return new Promise((resolve, reject) => {
            transaction.oncomplete = () => resolve();
            transaction.onerror = () => reject(transaction.error || new Error('IndexedDB transaction failed.'));
            transaction.onabort = () => reject(transaction.error || new Error('IndexedDB transaction aborted.'));
        });
    }

    function shouldUseMemoryStorage() {
        return config.storage === 'memory';
    }

    function openDatabase() {
        if (shouldUseMemoryStorage()) return Promise.resolve(null);
        if (typeof global.indexedDB === 'undefined') {
            return Promise.reject(new MeetingDataStoreError('IndexedDB is unavailable. Export offline TXT before leaving this page.', 'INDEXEDDB_UNAVAILABLE'));
        }
        if (databasePromise) return databasePromise;
        databasePromise = new Promise((resolve, reject) => {
            const request = global.indexedDB.open(config.dbName, config.dbVersion);
            request.onupgradeneeded = () => {
                const db = request.result;
                if (!db.objectStoreNames.contains('snapshots')) {
                    db.createObjectStore('snapshots', { keyPath: 'id' });
                }
                if (!db.objectStoreNames.contains('outbox')) {
                    const store = db.createObjectStore('outbox', { keyPath: 'eventId' });
                    store.createIndex('dataset', 'dataset', { unique: false });
                    store.createIndex('createdAt', 'createdAt', { unique: false });
                }
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error || new Error('IndexedDB open failed.'));
            request.onblocked = () => reject(new MeetingDataStoreError('IndexedDB upgrade is blocked by another tab.', 'INDEXEDDB_BLOCKED'));
        });
        return databasePromise;
    }

    async function readStoredSnapshot() {
        const db = await openDatabase();
        if (!db) return clone(snapshot);
        const transaction = db.transaction('snapshots', 'readonly');
        return requestPromise(transaction.objectStore('snapshots').get(SNAPSHOT_ID));
    }

    async function readOutboxInternal() {
        const db = await openDatabase();
        let rows;
        if (!db) {
            rows = [...memoryOutbox.values()].map(clone);
        } else {
            const transaction = db.transaction('outbox', 'readonly');
            rows = await requestPromise(transaction.objectStore('outbox').getAll());
        }
        return rows.sort(compareEvents);
    }

    async function persistAtomically(nextSnapshot, eventsToPut, eventIdsToDelete) {
        const normalized = normalizeSnapshot(nextSnapshot);
        normalized.savedAt = nowIso();
        const puts = Array.isArray(eventsToPut) ? eventsToPut : [];
        const deletes = Array.isArray(eventIdsToDelete) ? eventIdsToDelete : [];
        const db = await openDatabase();
        if (!db) {
            for (const event of puts) memoryOutbox.set(event.eventId, clone(event));
            for (const eventId of deletes) memoryOutbox.delete(eventId);
            snapshot = clone(normalized);
            return;
        }
        const transaction = db.transaction(['snapshots', 'outbox'], 'readwrite');
        const done = transactionPromise(transaction);
        transaction.objectStore('snapshots').put(clone(normalized));
        const outboxStore = transaction.objectStore('outbox');
        for (const event of puts) outboxStore.put(clone(event));
        for (const eventId of deletes) outboxStore.delete(eventId);
        await done;
        snapshot = clone(normalized);
    }

    function configure(options) {
        const input = options || {};
        if (initialized && (input.dbName || input.dbVersion || input.storage)) {
            throw new MeetingDataStoreError('Storage configuration cannot change after init().', 'CONFIG_LOCKED');
        }
        if (input.dbName) config.dbName = String(input.dbName);
        if (input.dbVersion) config.dbVersion = Number(input.dbVersion);
        if (input.storage) {
            if (!['auto', 'memory', 'indexeddb'].includes(input.storage)) throw new TypeError('storage must be auto, memory, or indexeddb');
            config.storage = input.storage;
        }
        const github = {
            ...Object.fromEntries(['repo', 'branch', 'statusPath', 'memoPath', 'apiVersion', 'mutationDelayMs']
                .filter((key) => input[key] !== undefined)
                .map((key) => [key, input[key]])),
            ...(input.github || {})
        };
        for (const key of ['repo', 'branch', 'statusPath', 'memoPath', 'apiVersion']) {
            if (github[key] !== undefined) config.github[key] = String(github[key]);
        }
        if (github.mutationDelayMs !== undefined) {
            config.github.mutationDelayMs = Math.max(0, Number(github.mutationDelayMs) || 0);
        }
        if (typeof input.fetch === 'function') fetchImplementation = input.fetch;
        return getConfig();
    }

    function getConfig() {
        return clone(config);
    }

    async function init(options) {
        if (options) configure(options);
        if (config.storage !== 'memory' && typeof global.indexedDB === 'undefined') {
            throw new MeetingDataStoreError('IndexedDB is unavailable.', 'INDEXEDDB_UNAVAILABLE');
        }
        const initializeStorage = async () => {
            const stored = await readStoredSnapshot();
            snapshot = normalizeSnapshot(stored);
            const pendingEvents = await readOutboxInternal();
            for (const kind of VALID_DATASETS) {
                const events = pendingEvents.filter((event) => event.dataset === kind);
                if (!events.length) continue;
                const recovered = applyEvents(snapshot[kind], events, { strict: false, syncStatus: '대기', reapplyDuplicates: true });
                snapshot[kind] = recovered.state;
            }
            if (pendingEvents.length) await persistAtomically(snapshot, [], []);
            return pendingEvents;
        };
        const locks = global.navigator && global.navigator.locks;
        const pending = !shouldUseMemoryStorage() && locks && typeof locks.request === 'function'
            ? await locks.request(`meeting-data-store:${config.dbName}`, { mode: 'exclusive' }, initializeStorage)
            : await initializeStorage();
        initialized = true;
        emit('initialized', { pendingCount: pending.length });
        return getSnapshot();
    }

    function getSnapshot() {
        return clone(snapshot);
    }

    function getRows(kind) {
        assertDataset(kind);
        return clone(snapshot[kind].rows);
    }

    function getHistory(kind) {
        assertDataset(kind);
        return clone(snapshot[kind].history);
    }

    async function getOutbox(kind) {
        assertInitialized();
        if (kind !== undefined) assertDataset(kind);
        const events = await readOutboxInternal();
        return clone(kind ? events.filter((event) => event.dataset === kind) : events);
    }

    function setSessionToken(token) {
        sessionToken = String(token || '').trim();
        emit('token-changed', { available: Boolean(sessionToken) });
        return Boolean(sessionToken);
    }

    function clearSessionToken() {
        sessionToken = '';
        emit('token-changed', { available: false });
    }

    function hasSessionToken() {
        return Boolean(sessionToken);
    }

    function makeEventId() {
        const cryptoObject = global.crypto;
        if (cryptoObject && typeof cryptoObject.randomUUID === 'function') return cryptoObject.randomUUID();
        const random = Math.random().toString(16).slice(2);
        return `evt-${Date.now().toString(36)}-${random}`;
    }

    function nextEventSequence() {
        lastEventSequence = Math.max(Date.now() * 1000, lastEventSequence + 1);
        return lastEventSequence;
    }

    function parseMeetingKey(key) {
        const text = String(key || '').trim();
        const match = /^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?$/.exec(text);
        if (!match) throw new MeetingDataStoreError(`Invalid meeting key: ${text}`, 'INVALID_MEETING_KEY');
        const year = Number(match[1]);
        const month = Number(match[2]);
        const week = match[3] ? Number(match[3]) : null;
        if (month < 1 || month > 12 || (week !== null && (week < 1 || week > 6))) {
            throw new MeetingDataStoreError(`Invalid meeting key: ${text}`, 'INVALID_MEETING_KEY');
        }
        return { key: `${year}-${month}${week === null ? '' : `-${week}`}`, year, month, week, type: week === null ? '월간' : '주간' };
    }

    function sameValue(left, right) {
        if (left === undefined) left = null;
        if (right === undefined) right = null;
        return JSON.stringify(left) === JSON.stringify(right);
    }

    function stableStringify(value) {
        if (value === null || typeof value !== 'object') return JSON.stringify(value);
        if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
        return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
    }

    function eventSignature(event) {
        return stableStringify({
            eventId: event.eventId,
            dataset: event.dataset,
            createdAt: event.createdAt,
            sequence: Number.isFinite(Number(event.sequence)) ? Number(event.sequence) : null,
            key: event.key,
            type: event.type,
            source: event.source,
            operation: event.operation,
            base: event.base,
            values: event.values,
            beforeValue: event.beforeValue,
            afterValue: event.afterValue,
            revision: event.dataset === DATASET_MEMO ? Number(event.revision) : null
        });
    }

    function compareEvents(left, right) {
        const byTime = String(left.createdAt || '').localeCompare(String(right.createdAt || ''));
        if (byTime) return byTime;
        const leftSequence = Number(left.sequence);
        const rightSequence = Number(right.sequence);
        if (Number.isFinite(leftSequence) && Number.isFinite(rightSequence) && leftSequence !== rightSequence) return leftSequence - rightSequence;
        if (Number.isFinite(leftSequence) !== Number.isFinite(rightSequence)) return Number.isFinite(leftSequence) ? 1 : -1;
        return String(left.eventId || '').localeCompare(String(right.eventId || ''));
    }

    function sortStatusRows(rows) {
        return rows.sort((left, right) => {
            const typeLeft = left.type === '월간' ? 0 : 1;
            const typeRight = right.type === '월간' ? 0 : 1;
            return Number(left.year) - Number(right.year) || Number(left.month) - Number(right.month) || typeLeft - typeRight || Number(left.week || 0) - Number(right.week || 0) || left.key.localeCompare(right.key);
        });
    }

    function sortMemoRows(rows) {
        return sortStatusRows(rows);
    }

    function sortHistory(rows) {
        return rows.sort((left, right) => String(left.changedAt || '').localeCompare(String(right.changedAt || '')) || String(left.eventId || '').localeCompare(String(right.eventId || '')));
    }

    function cleanString(value) {
        return value === null || value === undefined ? '' : String(value);
    }

    function normalizeInteger(value, fallback) {
        if (value === null || value === undefined || value === '') return fallback;
        const number = Number(value);
        return Number.isFinite(number) ? Math.trunc(number) : fallback;
    }

    function pad2(value) {
        return String(value).padStart(2, '0');
    }

    function excelSerialToParts(value) {
        const xlsx = getXlsx();
        if (xlsx.SSF && typeof xlsx.SSF.parse_date_code === 'function') return xlsx.SSF.parse_date_code(Number(value));
        return null;
    }

    function normalizeDateOnly(value) {
        if (value === null || value === undefined || value === '') return null;
        if (value instanceof Date && !Number.isNaN(value.getTime())) {
            return `${value.getFullYear()}-${pad2(value.getMonth() + 1)}-${pad2(value.getDate())}`;
        }
        if (typeof value === 'number') {
            const parts = excelSerialToParts(value);
            if (parts) return `${parts.y}-${pad2(parts.m)}-${pad2(parts.d)}`;
        }
        const text = String(value).trim();
        const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
        if (match) return `${match[1]}-${match[2]}-${match[3]}`;
        const date = new Date(text);
        if (!Number.isNaN(date.getTime())) return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
        return text;
    }

    function normalizeDateTime(value) {
        if (value === null || value === undefined || value === '') return null;
        if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
        if (typeof value === 'number') {
            const parts = excelSerialToParts(value);
            if (parts) {
                return new Date(parts.y, parts.m - 1, parts.d, parts.H || 0, parts.M || 0, Math.floor(parts.S || 0)).toISOString();
            }
        }
        const text = String(value).trim();
        const date = new Date(text);
        return Number.isNaN(date.getTime()) ? text : date.toISOString();
    }

    function dateOnlyToCell(value) {
        const normalized = normalizeDateOnly(value);
        if (!normalized) return null;
        const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(normalized);
        return match ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12, 0, 0) : normalized;
    }

    function dateTimeToCell(value) {
        if (!value) return null;
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? String(value) : date;
    }

    const STATUS_FIELDS = new Set(['key', 'type', 'year', 'month', 'week', 'status', 'counterIncluded', 'cardVisible', 'referenceDate', 'updatedAt', 'source', 'exceptionCode', 'note']);
    const STATUS_MUTABLE_FIELDS = ['type', 'year', 'month', 'week', 'status', 'counterIncluded', 'cardVisible', 'referenceDate', 'source', 'exceptionCode', 'note'];

    function assertExcelCellText(value, field) {
        const text = cleanString(value);
        if (text.length > MAX_EXCEL_CELL_CHARACTERS) {
            throw new MeetingDataStoreError(`${field} exceeds Excel's ${MAX_EXCEL_CELL_CHARACTERS}-character cell limit.`, 'EXCEL_CELL_TOO_LONG');
        }
        return text;
    }

    function assertKeyFields(input, parsed, strict) {
        const expectations = { type: parsed.type, year: parsed.year, month: parsed.month, week: parsed.week };
        for (const [field, expected] of Object.entries(expectations)) {
            const supplied = input[field];
            const blank = supplied === null || supplied === undefined || supplied === '';
            if (blank) {
                if (strict && expected !== null) throw new SchemaError(`Blank ${field} for ${parsed.key}.`);
                continue;
            }
            const actual = field === 'type' ? cleanString(supplied).trim() : normalizeInteger(supplied, NaN);
            if (!sameValue(actual, expected)) {
                throw new SchemaError(`${field} does not match meeting key ${parsed.key}.`, { field, expected, actual });
            }
        }
    }

    function normalizeFlag(value, fallback, field, strict) {
        const text = cleanString(value).trim();
        if (!text) {
            if (strict) throw new SchemaError(`Blank ${field} is not allowed.`);
            return fallback;
        }
        if (!['Y', 'N'].includes(text)) throw new SchemaError(`${field} must be Y or N.`);
        return text;
    }

    function normalizeStatusRow(input, options) {
        const settings = options || {};
        const parsed = parseMeetingKey(input.key);
        assertKeyFields(input, parsed, settings.strict === true);
        const status = cleanString(input.status).trim() || (settings.strict ? '' : '작성');
        if (!['작성', '미작성'].includes(status)) throw new MeetingDataStoreError(`Invalid status for ${parsed.key}: ${status}`, 'INVALID_STATUS');
        const referenceDate = normalizeDateOnly(input.referenceDate);
        if (settings.strict && referenceDate && !/^\d{4}-\d{2}-\d{2}$/.test(referenceDate)) {
            throw new SchemaError(`Invalid referenceDate for ${parsed.key}: ${referenceDate}`);
        }
        const updatedAt = normalizeDateTime(input.updatedAt);
        if (settings.strict && (!updatedAt || Number.isNaN(new Date(updatedAt).getTime()))) {
            throw new SchemaError(`Invalid updatedAt for ${parsed.key}.`);
        }
        return {
            key: parsed.key,
            type: parsed.type,
            year: parsed.year,
            month: parsed.month,
            week: parsed.week,
            status,
            counterIncluded: normalizeFlag(input.counterIncluded, 'Y', 'counterIncluded', settings.strict === true),
            cardVisible: normalizeFlag(input.cardVisible, 'Y', 'cardVisible', settings.strict === true),
            referenceDate,
            updatedAt: updatedAt || nowIso(),
            source: assertExcelCellText(input.source || '웹 수동 편집', 'source'),
            exceptionCode: assertExcelCellText(input.exceptionCode, 'exceptionCode'),
            note: assertExcelCellText(input.note, 'note')
        };
    }

    function normalizeMemoRow(input, options) {
        const settings = options || {};
        const parsed = parseMeetingKey(input.key);
        assertKeyFields(input, parsed, settings.strict === true);
        const updatedAt = normalizeDateTime(input.updatedAt);
        if (settings.strict && (!updatedAt || Number.isNaN(new Date(updatedAt).getTime()))) {
            throw new SchemaError(`Invalid updatedAt for ${parsed.key}.`);
        }
        const revision = normalizeInteger(input.revision, settings.strict ? NaN : 1);
        if (!Number.isInteger(revision) || revision < 1) throw new SchemaError(`Invalid revision for ${parsed.key}.`);
        return {
            key: parsed.key,
            type: parsed.type,
            year: parsed.year,
            month: parsed.month,
            week: parsed.week,
            summary: assertExcelCellText(input.summary, 'summary'),
            updatedAt: updatedAt || nowIso(),
            source: assertExcelCellText(input.source || '웹 수동 편집', 'source'),
            revision
        };
    }

    function validatePatchKeys(patch, allowed, label) {
        for (const key of Object.keys(patch || {})) {
            if (!allowed.has(key)) throw new MeetingDataStoreError(`${label} contains unsupported field: ${key}`, 'INVALID_PATCH');
        }
    }

    function createStatusEvent(current, desired, changedFields, source, eventId, changedAt) {
        const base = {};
        const values = {};
        for (const field of changedFields) {
            base[field] = current ? clone(current[field]) : null;
            values[field] = clone(desired[field]);
        }
        const businessFields = changedFields.filter((field) => field !== 'source');
        const beforeValue = businessFields.length === 1 && businessFields[0] === 'status'
            ? (current ? current.status : '')
            : assertExcelCellText(JSON.stringify(base), 'status history beforeValue');
        const afterValue = businessFields.length === 1 && businessFields[0] === 'status'
            ? desired.status
            : assertExcelCellText(JSON.stringify(values), 'status history afterValue');
        return {
            eventId: eventId || makeEventId(),
            sequence: nextEventSequence(),
            dataset: DATASET_STATUS,
            createdAt: changedAt || nowIso(),
            key: desired.key,
            type: desired.type,
            source,
            operation: current ? 'upsert' : 'create',
            base,
            values,
            beforeValue,
            afterValue
        };
    }

    function createMemoEvent(current, desiredSummary, desiredRow, source, eventId, changedAt) {
        const deletion = !desiredSummary;
        const revision = deletion ? (current ? current.revision : 0) + 1 : desiredRow.revision;
        return {
            eventId: eventId || makeEventId(),
            sequence: nextEventSequence(),
            dataset: DATASET_MEMO,
            createdAt: changedAt || nowIso(),
            key: desiredRow ? desiredRow.key : current.key,
            type: desiredRow ? desiredRow.type : current.type,
            source,
            operation: desiredSummary ? 'upsert' : 'delete',
            base: { summary: current ? current.summary : '', revision: current ? current.revision : 0 },
            values: deletion ? { summary: '', revision } : clone(desiredRow),
            beforeValue: current ? current.summary : '',
            afterValue: desiredSummary,
            revision
        };
    }

    function statusHistoryFromEvent(event, syncStatus) {
        return {
            eventId: event.eventId,
            changedAt: event.createdAt,
            key: event.key,
            type: event.type,
            beforeValue: cleanString(event.beforeValue),
            afterValue: cleanString(event.afterValue),
            source: cleanString(event.source),
            syncStatus: syncStatus || '대기'
        };
    }

    function memoHistoryFromEvent(event, syncStatus) {
        return {
            eventId: event.eventId,
            changedAt: event.createdAt,
            key: event.key,
            type: event.type,
            beforeValue: cleanString(event.beforeValue),
            afterValue: cleanString(event.afterValue),
            source: cleanString(event.source),
            syncStatus: syncStatus || '대기',
            revision: Math.max(1, normalizeInteger(event.revision, 1))
        };
    }

    function upsertByKey(rows, nextRow) {
        const index = rows.findIndex((row) => row.key === nextRow.key);
        if (index >= 0) rows[index] = nextRow;
        else rows.push(nextRow);
    }

    function appendHistory(history, entry) {
        if (!history.some((row) => row.eventId === entry.eventId)) history.push(entry);
    }

    async function upsertStatus(rowOrKey, patch, options) {
        assertInitialized();
        let key;
        let changes;
        let settings;
        if (rowOrKey && typeof rowOrKey === 'object') {
            key = rowOrKey.key;
            changes = { ...rowOrKey };
            settings = patch || {};
        } else {
            key = rowOrKey;
            changes = { ...(patch || {}), key };
            settings = options || {};
        }
        validatePatchKeys(changes, STATUS_FIELDS, 'status patch');
        const parsed = parseMeetingKey(key);
        return serializeLocal(async () => {
            const nextSnapshot = clone(snapshot);
            const current = nextSnapshot.status.rows.find((row) => row.key === parsed.key) || null;
            const base = current || {
                key: parsed.key,
                type: parsed.type,
                year: parsed.year,
                month: parsed.month,
                week: parsed.week,
                status: '작성',
                counterIncluded: 'Y',
                cardVisible: 'Y',
                referenceDate: null,
                updatedAt: nowIso(),
                source: '웹 수동 편집',
                exceptionCode: '',
                note: ''
            };
            const source = cleanString(settings.source || changes.source || '웹 수동 편집');
            const desired = normalizeStatusRow({ ...base, ...changes, key: parsed.key, source, updatedAt: settings.changedAt || nowIso() });
            const changedFields = current
                ? STATUS_MUTABLE_FIELDS.filter((field) => !sameValue(base[field], desired[field]))
                : STATUS_MUTABLE_FIELDS.slice();
            if (!changedFields.length) return { changed: false, row: clone(current || desired), event: null };
            if (!changedFields.includes('source')) changedFields.push('source');
            const event = createStatusEvent(current, desired, changedFields, source, settings.eventId, settings.changedAt);
            upsertByKey(nextSnapshot.status.rows, desired);
            appendHistory(nextSnapshot.status.history, statusHistoryFromEvent(event, '대기'));
            sortStatusRows(nextSnapshot.status.rows);
            sortHistory(nextSnapshot.status.history);
            await persistAtomically(nextSnapshot, [event], []);
            emit('local-change', { dataset: DATASET_STATUS, eventId: event.eventId, key: event.key });
            return { changed: true, row: clone(desired), event: clone(event) };
        });
    }

    async function upsertMemo(key, summary, options) {
        assertInitialized();
        const parsed = parseMeetingKey(key);
        const settings = options || {};
        const desiredSummary = cleanString(summary);
        return serializeLocal(async () => {
            const nextSnapshot = clone(snapshot);
            const current = nextSnapshot.memo.rows.find((row) => row.key === parsed.key) || null;
            if ((current ? current.summary : '') === desiredSummary) {
                return { changed: false, row: clone(current), event: null };
            }
            const changedAt = settings.changedAt || nowIso();
            const source = cleanString(settings.source || '웹 수동 편집');
            const desired = desiredSummary ? normalizeMemoRow({
                key: parsed.key,
                type: settings.type || (current && current.type) || parsed.type,
                year: settings.year || (current && current.year) || parsed.year,
                month: settings.month || (current && current.month) || parsed.month,
                week: settings.week === undefined ? ((current && current.week) || parsed.week) : settings.week,
                summary: desiredSummary,
                updatedAt: changedAt,
                source,
                revision: (current ? current.revision : 0) + 1
            }) : null;
            const event = createMemoEvent(current, desiredSummary, desired || {
                key: parsed.key,
                type: (current && current.type) || parsed.type
            }, source, settings.eventId, changedAt);
            if (desired) upsertByKey(nextSnapshot.memo.rows, desired);
            else nextSnapshot.memo.rows = nextSnapshot.memo.rows.filter((row) => row.key !== parsed.key);
            appendHistory(nextSnapshot.memo.history, memoHistoryFromEvent(event, '대기'));
            sortMemoRows(nextSnapshot.memo.rows);
            sortHistory(nextSnapshot.memo.history);
            await persistAtomically(nextSnapshot, [event], []);
            emit('local-change', { dataset: DATASET_MEMO, eventId: event.eventId, key: event.key });
            return { changed: true, row: clone(desired), event: clone(event) };
        });
    }

    function deleteMemo(key, options) {
        return upsertMemo(key, '', options);
    }

    function applyStatusEvent(state, event, strict, syncStatus, reapplyDuplicates) {
        const result = { conflict: null, applied: false, duplicate: false };
        if (state.history.some((row) => row.eventId === event.eventId)) {
            result.duplicate = true;
            if (!reapplyDuplicates) return result;
        }
        const parsed = parseMeetingKey(event.key);
        const current = state.rows.find((row) => row.key === parsed.key) || null;
        const values = event.values || {};
        const base = event.base || {};
        const conflicts = [];
        for (const field of Object.keys(values)) {
            if (!STATUS_FIELDS.has(field) || field === 'key' || field === 'updatedAt') continue;
            const currentValue = current ? current[field] : null;
            if (!sameValue(currentValue, values[field]) && !sameValue(currentValue, base[field])) {
                conflicts.push({ field, base: base[field], remote: currentValue, local: values[field] });
            }
        }
        if (conflicts.length) {
            result.conflict = { eventId: event.eventId, dataset: DATASET_STATUS, key: event.key, fields: conflicts };
            if (strict) return result;
        }
        const seed = current || {
            key: parsed.key,
            type: event.type || parsed.type,
            year: parsed.year,
            month: parsed.month,
            week: parsed.week,
            status: '작성',
            counterIncluded: 'Y',
            cardVisible: 'Y',
            referenceDate: null,
            source: event.source || '오프라인 이력',
            exceptionCode: '',
            note: ''
        };
        const next = normalizeStatusRow({ ...seed, ...values, key: parsed.key, updatedAt: event.createdAt, source: values.source || event.source || seed.source });
        upsertByKey(state.rows, next);
        appendHistory(state.history, statusHistoryFromEvent(event, syncStatus));
        result.applied = true;
        return result;
    }

    function applyMemoEvent(state, event, strict, syncStatus, reapplyDuplicates) {
        const result = { conflict: null, applied: false, duplicate: false };
        if (state.history.some((row) => row.eventId === event.eventId)) {
            result.duplicate = true;
            if (!reapplyDuplicates) return result;
        }
        const parsed = parseMeetingKey(event.key);
        const current = state.rows.find((row) => row.key === parsed.key) || null;
        const baseSummary = cleanString(event.base && event.base.summary);
        const baseRevision = normalizeInteger(event.base && event.base.revision, 0);
        const desiredSummary = cleanString(event.afterValue !== undefined ? event.afterValue : event.values && event.values.summary);
        const currentSummary = current ? current.summary : '';
        const currentRevision = current ? current.revision : 0;
        const alreadyDesired = currentSummary === desiredSummary && (event.operation !== 'delete' || !current);
        if (!alreadyDesired && (currentSummary !== baseSummary || currentRevision !== baseRevision)) {
            result.conflict = {
                eventId: event.eventId,
                dataset: DATASET_MEMO,
                key: event.key,
                fields: [{ field: 'summary', base: baseSummary, remote: currentSummary, local: desiredSummary }]
            };
            if (strict) return result;
        }
        if (event.operation === 'delete' || !desiredSummary) {
            state.rows = state.rows.filter((row) => row.key !== parsed.key);
        } else {
            const values = event.values || {};
            const next = normalizeMemoRow({
                key: parsed.key,
                type: values.type || event.type || parsed.type,
                year: values.year || parsed.year,
                month: values.month || parsed.month,
                week: values.week === undefined ? parsed.week : values.week,
                summary: desiredSummary,
                updatedAt: event.createdAt,
                source: values.source || event.source,
                revision: Math.max(normalizeInteger(event.revision, 1), normalizeInteger(values.revision, 1), currentRevision + (alreadyDesired ? 0 : 1))
            });
            upsertByKey(state.rows, next);
        }
        appendHistory(state.history, memoHistoryFromEvent(event, syncStatus));
        result.applied = true;
        return result;
    }

    function applyEvents(datasetState, events, options) {
        const state = clone(datasetState || createDatasetState());
        const settings = options || {};
        const strict = settings.strict !== false;
        const syncStatus = settings.syncStatus || '대기';
        const reapplyDuplicates = settings.reapplyDuplicates === true;
        const conflicts = [];
        const applied = [];
        const duplicates = [];
        for (const event of [...events].sort(compareEvents)) {
            const outcome = event.dataset === DATASET_STATUS
                ? applyStatusEvent(state, event, strict, syncStatus, reapplyDuplicates)
                : applyMemoEvent(state, event, strict, syncStatus, reapplyDuplicates);
            if (outcome.conflict) conflicts.push(outcome.conflict);
            if (outcome.applied) applied.push(event.eventId);
            if (outcome.duplicate) duplicates.push(event.eventId);
        }
        if (state === undefined) throw new Error('Unexpected merge state.');
        if (events.some((event) => event.dataset === DATASET_STATUS)) sortStatusRows(state.rows);
        else sortMemoRows(state.rows);
        sortHistory(state.history);
        return { state, conflicts, applied, duplicates };
    }

    function sheetRows(workbook, sheetName, headers) {
        const xlsx = getXlsx();
        const worksheet = workbook.Sheets[sheetName];
        if (!worksheet) throw new SchemaError(`Required sheet is missing: ${sheetName}`);
        if (worksheet['!ref']) {
            const usedRange = xlsx.utils.decode_range(worksheet['!ref']);
            const rowCount = usedRange.e.r - usedRange.s.r + 1;
            const columnCount = usedRange.e.c - usedRange.s.c + 1;
            if (rowCount > 100001) throw new SchemaError(`Sheet has too many rows: ${sheetName}`);
            if (columnCount > headers.length) throw new SchemaError(`Sheet has unexpected used columns after ${headers.length}: ${sheetName}`);
        }
        const matrix = xlsx.utils.sheet_to_json(worksheet, { header: 1, raw: true, defval: null, blankrows: false });
        if (!matrix.length) throw new SchemaError(`Sheet is empty: ${sheetName}`);
        const actual = matrix[0].slice(0, headers.length).map(cleanString);
        if (actual.length !== headers.length || actual.some((value, index) => value !== headers[index])) {
            throw new SchemaError(`Header mismatch in ${sheetName}.`, { expected: headers, actual });
        }
        if (matrix.length > 100001) throw new SchemaError(`Sheet has too many rows: ${sheetName}`);
        return matrix.slice(1).filter((row) => row.some((value) => value !== null && value !== '')).map((row, index) => {
            if (row.slice(headers.length).some((value) => value !== null && value !== '')) {
                throw new SchemaError(`Unexpected data after column ${headers.length} in ${sheetName}, row ${index + 2}.`);
            }
            return row.slice(0, headers.length);
        });
    }

    function ensureUnique(rows, field, sheetName) {
        const seen = new Set();
        for (const row of rows) {
            if (!row[field]) throw new SchemaError(`${sheetName} has a blank ${field}.`);
            if (seen.has(row[field])) throw new SchemaError(`${sheetName} has duplicate ${field}: ${row[field]}`);
            seen.add(row[field]);
        }
    }

    function parseStatusWorkbook(workbook) {
        const rows = sheetRows(workbook, '안건현황', STATUS_HEADERS).map((row) => normalizeStatusRow({
            key: row[0], type: row[1], year: row[2], month: row[3], week: row[4], status: row[5],
            counterIncluded: row[6], cardVisible: row[7], referenceDate: row[8], updatedAt: row[9],
            source: row[10], exceptionCode: row[11], note: row[12]
        }, { strict: true }));
        const history = sheetRows(workbook, '변경이력', STATUS_HISTORY_HEADERS).map((row) => ({
            eventId: cleanString(row[0]), changedAt: normalizeDateTime(row[1]), key: cleanString(row[2]), type: cleanString(row[3]),
            beforeValue: cleanString(row[4]), afterValue: cleanString(row[5]), source: cleanString(row[6]), syncStatus: cleanString(row[7])
        }));
        ensureUnique(rows, 'key', '안건현황');
        ensureUnique(history, 'eventId', '변경이력');
        return { rows: sortStatusRows(rows), history: sortHistory(history), remoteSha: null, loadedAt: nowIso() };
    }

    function parseMemoWorkbook(workbook) {
        const rows = sheetRows(workbook, '회의요약', MEMO_HEADERS).map((row) => normalizeMemoRow({
            key: row[0], type: row[1], year: row[2], month: row[3], week: row[4], summary: row[5],
            updatedAt: row[6], source: row[7], revision: row[8]
        }, { strict: true })).filter((row) => row.summary !== '');
        const history = sheetRows(workbook, '변경이력', MEMO_HISTORY_HEADERS).map((row) => ({
            eventId: cleanString(row[0]), changedAt: normalizeDateTime(row[1]), key: cleanString(row[2]), type: cleanString(row[3]),
            beforeValue: cleanString(row[4]), afterValue: cleanString(row[5]), source: cleanString(row[6]), syncStatus: cleanString(row[7]),
            revision: Math.max(1, normalizeInteger(row[8], 1))
        }));
        ensureUnique(rows, 'key', '회의요약');
        ensureUnique(history, 'eventId', '변경이력');
        return { rows: sortMemoRows(rows), history: sortHistory(history), remoteSha: null, loadedAt: nowIso() };
    }

    async function inputToBytes(input) {
        if (input instanceof Uint8Array) return input;
        if (input instanceof ArrayBuffer) return new Uint8Array(input);
        if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
        if (input && typeof input.arrayBuffer === 'function') return new Uint8Array(await input.arrayBuffer());
        throw new TypeError('Expected File, Blob, ArrayBuffer, or Uint8Array.');
    }

    async function parseXlsb(kind, input) {
        assertDataset(kind);
        const bytes = await inputToBytes(input);
        const workbook = getXlsx().read(bytes, { type: 'array', cellDates: true, dense: true });
        return kind === DATASET_STATUS ? parseStatusWorkbook(workbook) : parseMemoWorkbook(workbook);
    }

    function makeWorksheet(matrix, widths, options) {
        const xlsx = getXlsx();
        const settings = options || {};
        const worksheet = xlsx.utils.aoa_to_sheet(matrix, { cellDates: true });
        const columnCount = matrix.reduce((maximum, row) => Math.max(maximum, row.length), 0);
        if (settings.autofilter !== false && columnCount > 0) {
            const lastRow = Math.max(1, matrix.length);
            const lastColumn = xlsx.utils.encode_col(columnCount - 1);
            worksheet['!autofilter'] = { ref: `A1:${lastColumn}${lastRow}` };
        }
        worksheet['!cols'] = widths.map((wch) => ({ wch }));
        if (Array.isArray(settings.merges) && settings.merges.length) {
            worksheet['!merges'] = settings.merges.map((range) => xlsx.utils.decode_range(range));
        }
        for (const format of settings.numberFormats || []) {
            const startRow = Math.max(1, Number(format.startRow) || 1);
            const endRow = Math.min(matrix.length, Number(format.endRow) || matrix.length);
            for (let rowIndex = startRow; rowIndex <= endRow; rowIndex += 1) {
                const address = `${format.column}${rowIndex}`;
                if (worksheet[address]) worksheet[address].z = format.code;
            }
        }
        return worksheet;
    }

    function snapshotReferenceDate(state) {
        const timestamps = [];
        if (state && state.loadedAt) timestamps.push(state.loadedAt);
        for (const row of (state && state.rows) || []) {
            if (row.updatedAt) timestamps.push(row.updatedAt);
        }
        for (const row of (state && state.history) || []) {
            if (row.changedAt) timestamps.push(row.changedAt);
        }
        const normalized = timestamps
            .map((value) => normalizeDateOnly(value))
            .filter((value) => /^\d{4}-\d{2}-\d{2}$/.test(value || ''))
            .sort();
        return dateOnlyToCell(normalized[normalized.length - 1] || normalizeDateOnly(new Date()));
    }

    function statusSummaryMatrix(state) {
        const includedRows = state.rows.filter((row) => row.counterIncluded === 'Y');
        const countFor = (type, status) => includedRows.filter((row) => row.type === type && (!status || row.status === status)).length;
        const writtenDatesFor = (type) => includedRows
            .filter((row) => row.type === type && row.status === '작성')
            .map((row) => normalizeDateOnly(row.referenceDate))
            .filter((value) => /^\d{4}-\d{2}-\d{2}$/.test(value || ''))
            .sort();
        const monthlyDates = writtenDatesFor('월간');
        const weeklyDates = writtenDatesFor('주간');
        return [
            ['월간 및 주간 회의 안건 현황'],
            [],
            ['스냅샷 기준일', snapshotReferenceDate(state)],
            ['데이터 원본', '안건현황 및 변경이력의 현재 저장값'],
            [],
            ['구분', '누적 대상 카드', '작성', '미작성'],
            ['월간', countFor('월간'), countFor('월간', '작성'), countFor('월간', '미작성')],
            ['주간', countFor('주간'), countFor('주간', '작성'), countFor('주간', '미작성')],
            [],
            [],
            ['구분', '최초 작성 기준일', '마지막 작성 기준일'],
            ['월간', dateOnlyToCell(monthlyDates[0]), dateOnlyToCell(monthlyDates[monthlyDates.length - 1])],
            ['주간', dateOnlyToCell(weeklyDates[0]), dateOnlyToCell(weeklyDates[weeklyDates.length - 1])],
            [],
            [],
            ['감사 항목', '건수/정책'],
            ['카드 미매핑 기존 이력', state.rows.filter((row) => row.counterIncluded === 'N').length],
            ['처리 원칙', '삭제하지 않고 카운터포함=N으로 보존']
        ];
    }

    function statusDictionaryMatrix() {
        return [
            ['필드', '형식', '설명', '관리 규칙'],
            ['안건키', '텍스트', 'YYYY-M 또는 YYYY-M-W', '웹 매핑의 고유키'],
            ['상태', '작성/미작성', '현재 카드 상태', '모달 변경 시 갱신'],
            ['카운터포함', 'Y/N', '공식 카드 카운터 포함 여부', '기존 미매핑 이력은 N 유지'],
            ['카드표시', 'Y/N', '웹 카드 roster 포함 여부', '카운터와 함께 관리'],
            ['기준일', '날짜', '월 1일 또는 해당 주 목요일', '최초/마지막 작성 계산 기준'],
            ['예외코드', '텍스트', '비정규 이력 식별', '임의 삭제 금지'],
            ['FORCED_WEEK5', '코드', '기존 가상 5주차', '카운터포함=Y'],
            ['LEGACY_WEEK_OUT_OF_ROSTER', '코드', '기존 카드 미매핑 이력', '카운터포함=N'],
            ['변경이력', '추가 전용', '웹 편집 이력', '기존 행 덮어쓰기 금지']
        ];
    }

    function memoSummaryMatrix(state) {
        return [
            ['월간 및 주간 회의 요약 메모'],
            [],
            ['스냅샷 기준일', snapshotReferenceDate(state)],
            ['저장된 요약 건수', state.rows.length],
            ['월간 요약', state.rows.filter((row) => row.type === '월간').length],
            ['주간 요약', state.rows.filter((row) => row.type === '주간').length]
        ];
    }

    function memoGuideMatrix() {
        return [
            ['항목', '설명', '운영 규칙'],
            ['안건키', '안건현황 XLSB와 동일한 고유키', '두 파일의 유일한 매핑 키'],
            ['회의요약', '웹에서 작성하는 메모', 'HTML로 해석하지 않고 텍스트로 저장'],
            ['리비전', '메모 변경 횟수', '저장할 때 1씩 증가'],
            ['온라인', 'GitHub Contents API로 자동 동기화', '세션 토큰 필요'],
            ['오프라인', '로컬 변경 큐와 JSONL TXT 이력', '재연결 후 병합 업로드'],
            ['용량', '실제 사용 행/열만 저장', '빈 셀 대량 서식 금지, 압축 저장']
        ];
    }

    function statusMatrix(state) {
        const rows = sortStatusRows(clone(state.rows)).map((row) => [
            row.key, row.type, row.year, row.month, row.week, row.status, row.counterIncluded, row.cardVisible,
            dateOnlyToCell(row.referenceDate), dateTimeToCell(row.updatedAt), row.source, row.exceptionCode, row.note
        ]);
        const history = sortHistory(clone(state.history)).map((row) => [
            row.eventId, dateTimeToCell(row.changedAt), row.key, row.type, row.beforeValue, row.afterValue, row.source, row.syncStatus
        ]);
        return {
            current: [STATUS_HEADERS, ...rows],
            history: [STATUS_HISTORY_HEADERS, ...history]
        };
    }

    function memoMatrix(state) {
        const rows = sortMemoRows(clone(state.rows)).map((row) => [
            row.key, row.type, row.year, row.month, row.week, row.summary, dateTimeToCell(row.updatedAt), row.source, row.revision
        ]);
        const history = sortHistory(clone(state.history)).map((row) => [
            row.eventId, dateTimeToCell(row.changedAt), row.key, row.type, row.beforeValue, row.afterValue, row.source, row.syncStatus, row.revision
        ]);
        return {
            current: [MEMO_HEADERS, ...rows],
            history: [MEMO_HISTORY_HEADERS, ...history]
        };
    }

    function buildWorkbook(kind, state) {
        const xlsx = getXlsx();
        const workbook = xlsx.utils.book_new();
        if (kind === DATASET_STATUS) {
            const matrices = statusMatrix(state);
            xlsx.utils.book_append_sheet(workbook, makeWorksheet(statusSummaryMatrix(state), [23, 21, 21, 21], {
                autofilter: false,
                merges: ['A1:D1'],
                numberFormats: [
                    { column: 'B', startRow: 3, endRow: 3, code: 'yyyy-mm-dd' },
                    { column: 'B', startRow: 12, endRow: 13, code: 'yyyy-mm-dd' },
                    { column: 'C', startRow: 12, endRow: 13, code: 'yyyy-mm-dd' }
                ]
            }), '요약');
            xlsx.utils.book_append_sheet(workbook, makeWorksheet(matrices.current, [17, 10, 9, 7, 7, 10, 14, 12, 13, 25, 24, 30, 42], {
                numberFormats: [
                    { column: 'I', startRow: 2, code: 'yyyy-mm-dd' },
                    { column: 'J', startRow: 2, code: 'yyyy-mm-dd hh:mm' }
                ]
            }), '안건현황');
            xlsx.utils.book_append_sheet(workbook, makeWorksheet(matrices.history, [38, 25, 18, 16, 18, 18, 24, 14], {
                numberFormats: [{ column: 'B', startRow: 2, code: 'yyyy-mm-dd hh:mm' }]
            }), '변경이력');
            xlsx.utils.book_append_sheet(workbook, makeWorksheet(statusDictionaryMatrix(), [30, 18, 42, 42]), '데이터사전');
        } else {
            const matrices = memoMatrix(state);
            xlsx.utils.book_append_sheet(workbook, makeWorksheet(memoSummaryMatrix(state), [24, 24], {
                autofilter: false,
                merges: ['A1:B1'],
                numberFormats: [{ column: 'B', startRow: 3, endRow: 3, code: 'yyyy-mm-dd' }]
            }), '요약');
            xlsx.utils.book_append_sheet(workbook, makeWorksheet(matrices.current, [18, 10, 9, 7, 7, 70, 25, 24, 10], {
                numberFormats: [{ column: 'G', startRow: 2, code: 'yyyy-mm-dd hh:mm' }]
            }), '회의요약');
            xlsx.utils.book_append_sheet(workbook, makeWorksheet(matrices.history, [38, 25, 18, 16, 40, 40, 24, 14, 10], {
                numberFormats: [{ column: 'B', startRow: 2, code: 'yyyy-mm-dd hh:mm' }]
            }), '변경이력');
            xlsx.utils.book_append_sheet(workbook, makeWorksheet(memoGuideMatrix(), [22, 50, 50]), '사용안내');
        }
        return workbook;
    }

    function normalizeWrittenBytes(value) {
        if (value instanceof Uint8Array) return value;
        if (value instanceof ArrayBuffer) return new Uint8Array(value);
        if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
        return Uint8Array.from(value);
    }

    function writeWorkbookVariant(workbook, bookSST) {
        return normalizeWrittenBytes(getXlsx().write(workbook, {
            bookType: 'xlsb',
            type: 'array',
            compression: true,
            bookSST,
            cellStyles: false
        }));
    }

    function exportXlsb(kind, stateOverride) {
        assertDataset(kind);
        const state = stateOverride ? clone(stateOverride) : clone(snapshot[kind]);
        const workbook = buildWorkbook(kind, state);
        const inlineBytes = writeWorkbookVariant(workbook, false);
        const sharedBytes = writeWorkbookVariant(workbook, true);
        const useSharedStrings = sharedBytes.byteLength < inlineBytes.byteLength;
        const bytes = useSharedStrings ? sharedBytes : inlineBytes;
        if (bytes.byteLength > MAX_XLSB_BYTES) {
            throw new MeetingDataStoreError(`Generated XLSB exceeds the ${MAX_XLSB_BYTES}-byte safety limit. Archive old history before retrying.`, 'XLSB_TOO_LARGE', {
                byteLength: bytes.byteLength,
                limit: MAX_XLSB_BYTES
            });
        }
        return {
            bytes,
            byteLength: bytes.byteLength,
            bookSST: useSharedStrings,
            candidateSizes: { inline: inlineBytes.byteLength, sharedStrings: sharedBytes.byteLength }
        };
    }

    function safeFilename(name) {
        return String(name).replace(/[\\/:*?"<>|]+/g, '_');
    }

    function triggerDownload(blob, filename) {
        if (!global.document || !global.URL || typeof global.URL.createObjectURL !== 'function') return false;
        const url = global.URL.createObjectURL(blob);
        const anchor = global.document.createElement('a');
        anchor.href = url;
        anchor.download = safeFilename(filename);
        anchor.style.display = 'none';
        global.document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        setTimeout(() => global.URL.revokeObjectURL(url), 60000);
        return true;
    }

    function downloadXlsb(kind, filename) {
        assertInitialized();
        assertDataset(kind);
        const generated = exportXlsb(kind);
        const defaultName = kind === DATASET_STATUS ? '회의_안건_현황.xlsb' : '회의_요약_메모.xlsb';
        const blob = new Blob([generated.bytes], { type: 'application/vnd.ms-excel.sheet.binary.macroEnabled.12' });
        return { ...generated, blob, filename: filename || defaultName, downloaded: triggerDownload(blob, filename || defaultName) };
    }

    function bytesToBase64(bytes) {
        if (typeof global.btoa === 'function') {
            const chunkSize = 0x8000;
            let binary = '';
            for (let offset = 0; offset < bytes.length; offset += chunkSize) {
                binary += String.fromCharCode.apply(null, bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length)));
            }
            return global.btoa(binary);
        }
        if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
        throw new MeetingDataStoreError('No Base64 encoder is available.', 'BASE64_UNAVAILABLE');
    }

    function base64ToBytes(value) {
        const cleaned = String(value || '').replace(/\s+/g, '');
        if (typeof global.atob === 'function') {
            const binary = global.atob(cleaned);
            const bytes = new Uint8Array(binary.length);
            for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
            return bytes;
        }
        if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(cleaned, 'base64'));
        throw new MeetingDataStoreError('No Base64 decoder is available.', 'BASE64_UNAVAILABLE');
    }

    function githubFetch() {
        const implementation = fetchImplementation || global.fetch;
        if (typeof implementation !== 'function') throw new MeetingDataStoreError('fetch is unavailable.', 'FETCH_UNAVAILABLE');
        return implementation.apply(global, arguments);
    }

    function githubRepoParts() {
        const parts = String(config.github.repo || '').split('/').filter(Boolean);
        if (parts.length !== 2) throw new MeetingDataStoreError('github.repo must use owner/repository form.', 'INVALID_GITHUB_REPO');
        return parts;
    }

    function encodePath(path) {
        return String(path).split('/').map((part) => encodeURIComponent(part)).join('/');
    }

    function githubContentUrl(kind, withRef) {
        assertDataset(kind);
        const [owner, repo] = githubRepoParts();
        const path = kind === DATASET_STATUS ? config.github.statusPath : config.github.memoPath;
        const base = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodePath(path)}`;
        return withRef ? `${base}?ref=${encodeURIComponent(config.github.branch)}` : base;
    }

    function githubHeaders(accept, requireToken) {
        if (requireToken && !sessionToken) throw new MeetingDataStoreError('A session GitHub token is required.', 'TOKEN_REQUIRED');
        const headers = {
            Accept: accept || 'application/vnd.github+json',
            'X-GitHub-Api-Version': config.github.apiVersion
        };
        if (sessionToken) headers.Authorization = `Bearer ${sessionToken}`;
        return headers;
    }

    async function responseJson(response) {
        try { return await response.json(); } catch (_) { return {}; }
    }

    async function fetchGitHubDataset(kind) {
        assertDataset(kind);
        const url = githubContentUrl(kind, true);
        const response = await githubFetch(url, { headers: githubHeaders('application/vnd.github.object+json', false), cache: 'no-store' });
        if (response.status === 404) return { state: createDatasetState(), sha: null, exists: false, byteLength: 0 };
        if (!response.ok) {
            const error = await responseJson(response);
            throw new GitHubError(`GitHub GET failed for ${kind}: ${error.message || response.statusText}`, response.status, error);
        }
        const metadata = await responseJson(response);
        let bytes;
        if (metadata.encoding === 'base64' && metadata.content) {
            bytes = base64ToBytes(metadata.content);
        } else {
            const rawResponse = await githubFetch(url, { headers: githubHeaders('application/vnd.github.raw+json', false), cache: 'no-store' });
            if (!rawResponse.ok) {
                const error = await responseJson(rawResponse);
                throw new GitHubError(`GitHub raw GET failed for ${kind}: ${error.message || rawResponse.statusText}`, rawResponse.status, error);
            }
            bytes = new Uint8Array(await rawResponse.arrayBuffer());
        }
        const state = await parseXlsb(kind, bytes);
        state.remoteSha = metadata.sha || null;
        state.loadedAt = nowIso();
        return { state, sha: state.remoteSha, exists: true, byteLength: bytes.byteLength };
    }

    async function loadFromGitHub(options) {
        assertInitialized();
        const settings = options || {};
        const kinds = settings.dataset ? [settings.dataset] : [DATASET_STATUS, DATASET_MEMO];
        kinds.forEach(assertDataset);
        const results = {};
        for (const kind of kinds) {
            const generation = ++loadGeneration[kind];
            try {
                const remote = await fetchGitHubDataset(kind);
                const update = await serializeLocal(async () => {
                    if (generation !== loadGeneration[kind]) {
                        return { stale: true, pendingCount: 0, conflicts: [] };
                    }
                    const pending = (await readOutboxInternal()).filter((event) => event.dataset === kind);
                    const localFallback = !remote.exists && (snapshot[kind].rows.length || snapshot[kind].history.length)
                        ? clone(snapshot[kind])
                        : remote.state;
                    const overlay = applyEvents(localFallback, pending, { strict: false, syncStatus: '대기', reapplyDuplicates: true });
                    overlay.state.remoteSha = remote.sha;
                    overlay.state.loadedAt = nowIso();
                    const nextSnapshot = clone(snapshot);
                    nextSnapshot[kind] = overlay.state;
                    await persistAtomically(nextSnapshot, [], []);
                    return { stale: false, pendingCount: pending.length, conflicts: overlay.conflicts };
                });
                if (update.stale) {
                    results[kind] = { ok: true, skipped: true, stale: true, exists: remote.exists, byteLength: remote.byteLength, conflicts: [] };
                    emit('remote-load-stale', { dataset: kind, generation });
                    continue;
                }
                results[kind] = { ok: true, exists: remote.exists, byteLength: remote.byteLength, conflicts: update.conflicts };
                emit('remote-loaded', { dataset: kind, conflicts: update.conflicts.length, pendingCount: update.pendingCount });
            } catch (error) {
                results[kind] = { ok: false, error };
                emit('remote-error', { dataset: kind, error });
                if (settings.throwOnError) throw error;
            }
        }
        return results;
    }

    async function putGitHubDataset(kind, state, sha, message) {
        const generated = exportXlsb(kind, state);
        const body = {
            message: message || `[MeetingData] Update ${kind}`,
            content: bytesToBase64(generated.bytes),
            branch: config.github.branch
        };
        if (sha) body.sha = sha;
        const response = await githubFetch(githubContentUrl(kind, false), {
            method: 'PUT',
            headers: { ...githubHeaders('application/vnd.github+json', true), 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        const data = await responseJson(response);
        const errorText = `${data.message || ''} ${JSON.stringify(data.errors || [])}`;
        const creationRace = response.status === 422 && !sha && /sha|already exists|exists/i.test(errorText);
        if (response.status === 409 || creationRace) {
            return { conflict: true, status: response.status, data, generated, retryAfter: Number(response.headers && response.headers.get('Retry-After')) || 0 };
        }
        if (!response.ok) throw new GitHubError(`GitHub PUT failed for ${kind}: ${data.message || response.statusText}`, response.status, data);
        return { conflict: false, status: response.status, data, generated, sha: data.content && data.content.sha };
    }

    async function finalizeSuccessfulSync(kind, mergedRemoteState, acknowledgedIds, newSha) {
        await serializeLocal(async () => {
            const currentOutbox = await readOutboxInternal();
            const acknowledged = new Set(acknowledgedIds);
            const stillPending = currentOutbox.filter((event) => event.dataset === kind && !acknowledged.has(event.eventId));
            const overlay = applyEvents(mergedRemoteState, stillPending, { strict: false, syncStatus: '대기' });
            overlay.state.remoteSha = newSha || mergedRemoteState.remoteSha || null;
            overlay.state.loadedAt = nowIso();
            const nextSnapshot = clone(snapshot);
            nextSnapshot[kind] = overlay.state;
            await persistAtomically(nextSnapshot, [], acknowledgedIds);
        });
    }

    async function syncDatasetInternal(kind, options) {
        assertDataset(kind);
        if (!sessionToken) throw new MeetingDataStoreError('A session GitHub token is required for upload.', 'TOKEN_REQUIRED');
        const settings = options || {};
        const captured = (await readOutboxInternal()).filter((event) => event.dataset === kind);
        if (!captured.length && !settings.publishMissing) {
            return { ok: true, skipped: true, reason: 'empty-outbox', dataset: kind, uploadedEvents: 0 };
        }
        let lastConflictResponse = null;
        for (let retry = 0; retry <= MAX_GITHUB_CONFLICT_RETRIES; retry += 1) {
            const remote = await fetchGitHubDataset(kind);
            if (!captured.length && remote.exists) {
                return {
                    ok: true,
                    skipped: true,
                    reason: 'remote-exists',
                    dataset: kind,
                    uploadedEvents: 0,
                    sha: remote.sha || null
                };
            }
            let mergeBase = remote.state;
            if (!remote.exists) {
                const capturedIds = new Set(captured.map((event) => event.eventId));
                mergeBase = clone(snapshot[kind]);
                mergeBase.history = mergeBase.history.filter((row) => !capturedIds.has(row.eventId));
                mergeBase.remoteSha = null;
            }
            const merged = applyEvents(mergeBase, captured, { strict: true, syncStatus: '완료' });
            if (merged.conflicts.length) throw new ConflictError(`Cannot merge ${kind} changes without user review.`, merged.conflicts);
            merged.state.remoteSha = remote.sha;
            const result = await putGitHubDataset(kind, merged.state, remote.sha, settings.message);
            if (result.conflict) {
                lastConflictResponse = result;
                if (retry < MAX_GITHUB_CONFLICT_RETRIES) {
                    const backoff = result.retryAfter > 0 ? result.retryAfter * 1000 : Math.min(1000, 100 * (2 ** retry)) + Math.floor(Math.random() * 75);
                    await delay(backoff);
                    continue;
                }
                break;
            }
            const acknowledgedIds = captured.map((event) => event.eventId);
            await finalizeSuccessfulSync(kind, merged.state, acknowledgedIds, result.sha);
            emit('synced', { dataset: kind, uploadedEvents: acknowledgedIds.length, retryCount: retry });
            return {
                ok: true,
                skipped: false,
                dataset: kind,
                uploadedEvents: acknowledgedIds.length,
                retryCount: retry,
                sha: result.sha || null,
                byteLength: result.generated.byteLength,
                bookSST: result.generated.bookSST,
                candidateSizes: result.generated.candidateSizes
            };
        }
        const status = (lastConflictResponse && lastConflictResponse.status) || 409;
        throw new GitHubError(`GitHub returned ${status} after ${MAX_GITHUB_CONFLICT_RETRIES} retries for ${kind}.`, status, lastConflictResponse && lastConflictResponse.data);
    }

    function syncDataset(kind, options) {
        assertInitialized();
        assertDataset(kind);
        const task = syncChain.then(() => syncDatasetInternal(kind, options), () => syncDatasetInternal(kind, options));
        syncChain = task.catch(() => undefined);
        return task;
    }

    function delay(milliseconds) {
        return new Promise((resolve) => setTimeout(resolve, milliseconds));
    }

    function syncAll(options) {
        assertInitialized();
        const task = syncChain.then(async () => {
            const results = {};
            const pending = await readOutboxInternal();
            const kinds = [DATASET_STATUS, DATASET_MEMO].filter(
                (kind) => (options && options.publishMissing) || pending.some((event) => event.dataset === kind)
            );
            if (!kinds.length) return { ok: true, skipped: true, results, pendingCount: 0 };
            for (let index = 0; index < kinds.length; index += 1) {
                const kind = kinds[index];
                try {
                    results[kind] = await syncDatasetInternal(kind, options);
                } catch (error) {
                    results[kind] = { ok: false, error };
                    emit('sync-error', { dataset: kind, error });
                }
                if (index < kinds.length - 1 && config.github.mutationDelayMs > 0) await delay(config.github.mutationDelayMs);
            }
            const remaining = await readOutboxInternal();
            return { ok: Object.values(results).every((result) => result.ok), skipped: false, results, pendingCount: remaining.length };
        }, async () => {
            const pending = await readOutboxInternal();
            if (!pending.length) return { ok: true, skipped: true, results: {}, pendingCount: 0 };
            return syncAll(options);
        });
        syncChain = task.catch(() => undefined);
        return task;
    }

    async function sha256Hex(text) {
        if (!global.crypto || !global.crypto.subtle || typeof global.TextEncoder !== 'function') return null;
        const digest = await global.crypto.subtle.digest('SHA-256', new global.TextEncoder().encode(text));
        return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join('');
    }

    function localDateString(date) {
        return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
    }

    async function exportOfflineTxt(options) {
        assertInitialized();
        const settings = options || {};
        if (settings.dataset) assertDataset(settings.dataset);
        const allPending = await readOutboxInternal();
        const events = allPending.filter((event) => {
            if (settings.dataset && event.dataset !== settings.dataset) return false;
            if (settings.date && String(event.createdAt).slice(0, 10) !== settings.date) return false;
            return true;
        });
        const header = {
            recordType: 'header',
            format: JSONL_FORMAT,
            schemaVersion: SCHEMA_VERSION,
            exportedAt: nowIso(),
            repo: config.github.repo,
            branch: config.github.branch,
            baseShas: { status: snapshot.status.remoteSha, memo: snapshot.memo.remoteSha }
        };
        const lines = [JSON.stringify(header), ...events.map((event) => JSON.stringify({ recordType: 'event', ...event }))];
        const signedPayload = `${lines.join('\n')}\n`;
        const checksum = await sha256Hex(signedPayload);
        if (!checksum && !settings.allowUnchecked) {
            throw new MeetingDataStoreError('SHA-256 is unavailable. Use a modern secure browser context or explicitly set allowUnchecked.', 'CHECKSUM_UNAVAILABLE');
        }
        lines.push(JSON.stringify({ recordType: 'footer', count: events.length, sha256: checksum }));
        const text = `${lines.join('\n')}\n`;
        const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
        const filename = safeFilename(settings.filename || `meeting-changes-${settings.date || localDateString(new Date())}.txt`);
        const downloaded = settings.download === false ? false : triggerDownload(blob, filename);
        return { text, blob, filename, count: events.length, checksum, downloaded };
    }

    async function readTextInput(input) {
        if (typeof input === 'string') return input;
        if (input && typeof input.text === 'function') return input.text();
        if (input instanceof Uint8Array || input instanceof ArrayBuffer || ArrayBuffer.isView(input)) {
            if (typeof global.TextDecoder !== 'function') throw new MeetingDataStoreError('TextDecoder is unavailable.', 'TEXT_DECODER_UNAVAILABLE');
            return new global.TextDecoder('utf-8', { fatal: true }).decode(await inputToBytes(input));
        }
        throw new TypeError('Expected a text string, File, Blob, ArrayBuffer, or Uint8Array.');
    }

    function validateImportedEvent(event) {
        if (!event || typeof event !== 'object') throw new MeetingDataStoreError('Invalid JSONL event.', 'INVALID_JSONL');
        if (!VALID_DATASETS.has(event.dataset)) throw new MeetingDataStoreError('JSONL event has invalid dataset.', 'INVALID_JSONL');
        if (!event.eventId || String(event.eventId).length > 160) throw new MeetingDataStoreError('JSONL event has invalid eventId.', 'INVALID_JSONL');
        const parsed = parseMeetingKey(event.key);
        if (!event.createdAt || Number.isNaN(new Date(event.createdAt).getTime())) throw new MeetingDataStoreError('JSONL event has invalid createdAt.', 'INVALID_JSONL');
        if (!event.values || typeof event.values !== 'object' || !event.base || typeof event.base !== 'object') {
            throw new MeetingDataStoreError('JSONL event is missing base or values.', 'INVALID_JSONL');
        }
        const allowed = event.dataset === DATASET_STATUS ? STATUS_FIELDS : new Set(['key', 'type', 'year', 'month', 'week', 'summary', 'updatedAt', 'source', 'revision']);
        for (const [section, values] of [['base', event.base], ['values', event.values]]) {
            for (const key of Object.keys(values)) {
                if (!allowed.has(key)) throw new MeetingDataStoreError(`JSONL event ${section} has unsupported field: ${key}`, 'INVALID_JSONL');
            }
        }
        const operation = cleanString(event.operation || 'upsert');
        const validOperations = event.dataset === DATASET_STATUS ? ['create', 'upsert'] : ['upsert', 'delete'];
        if (!validOperations.includes(operation)) throw new MeetingDataStoreError(`JSONL event has invalid operation: ${operation}`, 'INVALID_JSONL');
        if (event.type && cleanString(event.type) !== parsed.type) throw new MeetingDataStoreError('JSONL event type does not match its meeting key.', 'INVALID_JSONL');
        if (event.dataset === DATASET_MEMO) {
            const desiredSummary = cleanString(event.afterValue !== undefined ? event.afterValue : event.values.summary);
            if (operation === 'delete' && desiredSummary !== '') throw new MeetingDataStoreError('JSONL delete event contains a non-empty summary.', 'INVALID_JSONL');
            if (operation === 'upsert' && desiredSummary === '') throw new MeetingDataStoreError('JSONL memo upsert contains an empty summary.', 'INVALID_JSONL');
            assertExcelCellText(desiredSummary, 'summary');
        } else {
            if (event.values.status !== undefined && !['작성', '미작성'].includes(cleanString(event.values.status))) {
                throw new MeetingDataStoreError('JSONL status event contains an invalid status.', 'INVALID_JSONL');
            }
            for (const field of ['counterIncluded', 'cardVisible']) {
                if (event.values[field] !== undefined && !['Y', 'N'].includes(cleanString(event.values[field]))) {
                    throw new MeetingDataStoreError(`JSONL status event contains an invalid ${field}.`, 'INVALID_JSONL');
                }
            }
        }
        const clean = {
            eventId: String(event.eventId), dataset: event.dataset, createdAt: String(event.createdAt), key: String(event.key),
            type: cleanString(event.type || parsed.type), source: cleanString(event.source || '오프라인 TXT 가져오기'), operation,
            base: clone(event.base), values: clone(event.values), beforeValue: cleanString(event.beforeValue), afterValue: cleanString(event.afterValue)
        };
        if (Number.isFinite(Number(event.sequence))) clean.sequence = Number(event.sequence);
        if (event.dataset === DATASET_MEMO) clean.revision = Math.max(1, normalizeInteger(event.revision, 1));
        return clean;
    }

    async function importOfflineTxt(input, options) {
        assertInitialized();
        const settings = options || {};
        const text = (await readTextInput(input)).replace(/^\uFEFF/, '');
        const rawLines = text.split(/\r?\n/).filter((line) => line.trim() !== '');
        if (rawLines.length < 2) throw new MeetingDataStoreError('JSONL file is incomplete.', 'INVALID_JSONL');
        let records;
        try { records = rawLines.map((line) => JSON.parse(line)); }
        catch (error) { throw new MeetingDataStoreError(`JSONL parsing failed: ${error.message}`, 'INVALID_JSONL'); }
        const header = records[0];
        const footer = records[records.length - 1];
        if (header.recordType !== 'header' || header.format !== JSONL_FORMAT || header.schemaVersion !== SCHEMA_VERSION) {
            throw new MeetingDataStoreError('JSONL header or schema version is invalid.', 'INVALID_JSONL');
        }
        if (!settings.allowForeignRepository && (header.repo !== config.github.repo || header.branch !== config.github.branch)) {
            throw new MeetingDataStoreError('JSONL repository or branch does not match this data store.', 'JSONL_REPOSITORY_MISMATCH', {
                expected: { repo: config.github.repo, branch: config.github.branch },
                actual: { repo: header.repo, branch: header.branch }
            });
        }
        if (footer.recordType !== 'footer') {
            if (!settings.allowUnchecked) throw new MeetingDataStoreError('JSONL footer is missing.', 'INVALID_JSONL');
        } else {
            const eventCount = records.length - 2;
            if (footer.count !== eventCount) throw new MeetingDataStoreError('JSONL event count does not match footer.', 'INVALID_JSONL');
            if (!footer.sha256 && !settings.allowUnchecked) {
                throw new MeetingDataStoreError('JSONL SHA-256 checksum is missing.', 'INVALID_JSONL');
            }
            if (footer.sha256) {
                const signedPayload = `${rawLines.slice(0, -1).join('\n')}\n`;
                const actual = await sha256Hex(signedPayload);
                if (!actual && !settings.allowUnchecked) throw new MeetingDataStoreError('SHA-256 verification is unavailable.', 'CHECKSUM_UNAVAILABLE');
                if (actual && actual !== footer.sha256) throw new MeetingDataStoreError('JSONL SHA-256 checksum mismatch.', 'INVALID_JSONL');
            }
        }
        const eventRecords = records.slice(1, footer.recordType === 'footer' ? -1 : undefined).map((record) => {
            if (record.recordType !== 'event') throw new MeetingDataStoreError('JSONL contains an unexpected record.', 'INVALID_JSONL');
            const event = { ...record };
            delete event.recordType;
            return validateImportedEvent(event);
        });
        return serializeLocal(async () => {
            const existingOutbox = await readOutboxInternal();
            const knownEvents = new Map(existingOutbox.map((event) => [event.eventId, event]));
            const knownIds = new Set(existingOutbox.map((event) => event.eventId));
            for (const kind of VALID_DATASETS) {
                for (const row of snapshot[kind].history) knownIds.add(row.eventId);
            }
            const nextSnapshot = clone(snapshot);
            const accepted = [];
            const duplicates = [];
            const conflicts = [];
            for (const event of eventRecords.sort(compareEvents)) {
                if (knownIds.has(event.eventId)) {
                    const knownEvent = knownEvents.get(event.eventId);
                    if (knownEvent && eventSignature(knownEvent) !== eventSignature(event)) {
                        conflicts.push({ eventId: event.eventId, dataset: event.dataset, key: event.key, reason: 'EVENT_ID_PAYLOAD_MISMATCH' });
                        continue;
                    }
                    duplicates.push(event.eventId);
                    continue;
                }
                const merged = applyEvents(nextSnapshot[event.dataset], [event], { strict: true, syncStatus: '대기' });
                if (merged.conflicts.length) {
                    conflicts.push(...merged.conflicts);
                    continue;
                }
                nextSnapshot[event.dataset] = merged.state;
                accepted.push(event);
                knownIds.add(event.eventId);
                knownEvents.set(event.eventId, event);
            }
            if (accepted.length) await persistAtomically(nextSnapshot, accepted, []);
            emit('offline-imported', { accepted: accepted.length, duplicates: duplicates.length, conflicts: conflicts.length });
            return { accepted: accepted.length, duplicateEventIds: duplicates, conflicts, pendingCount: (await readOutboxInternal()).length };
        });
    }

    function mergeImportedHistory(current, incoming) {
        const byId = new Map(current.map((row) => [row.eventId, clone(row)]));
        for (const row of incoming) if (!byId.has(row.eventId)) byId.set(row.eventId, clone(row));
        return sortHistory([...byId.values()]);
    }

    async function importLocalFile(kind, file, options) {
        assertInitialized();
        assertDataset(kind);
        const settings = options || {};
        const imported = await parseXlsb(kind, file);
        if (!settings.queueForSync) {
            await serializeLocal(async () => {
                const pending = (await readOutboxInternal()).filter((event) => event.dataset === kind);
                if (pending.length && !settings.force) {
                    throw new MeetingDataStoreError('Cannot replace or merge a local XLSB while this dataset has pending changes. Sync or export the offline TXT first.', 'OUTBOX_NOT_EMPTY', {
                        dataset: kind,
                        pendingCount: pending.length
                    });
                }
                const nextSnapshot = clone(snapshot);
                if (settings.mode === 'merge') {
                    const rows = new Map(nextSnapshot[kind].rows.map((row) => [row.key, clone(row)]));
                    for (const row of imported.rows) rows.set(row.key, clone(row));
                    imported.rows = [...rows.values()];
                    imported.history = mergeImportedHistory(nextSnapshot[kind].history, imported.history);
                }
                imported.remoteSha = settings.keepRemoteSha ? nextSnapshot[kind].remoteSha : null;
                imported.loadedAt = nowIso();
                nextSnapshot[kind] = imported;
                await persistAtomically(nextSnapshot, [], settings.force ? pending.map((event) => event.eventId) : []);
            });
            emit('local-file-imported', { dataset: kind, queued: 0 });
            return { dataset: kind, queued: 0, rows: imported.rows.length, history: imported.history.length };
        }
        const queued = [];
        if (kind === DATASET_STATUS) {
            for (const row of imported.rows) {
                const current = snapshot.status.rows.find((item) => item.key === row.key) || null;
                const changedFields = STATUS_MUTABLE_FIELDS.filter((field) => !sameValue(current && current[field], row[field]));
                if (!changedFields.length) continue;
                const event = createStatusEvent(current, row, changedFields, settings.source || '로컬 XLSB 가져오기');
                await importEventsDirectly([event]);
                queued.push(event.eventId);
            }
        } else {
            const importedByKey = new Map(imported.rows.map((row) => [row.key, row]));
            for (const row of imported.rows) {
                const current = snapshot.memo.rows.find((item) => item.key === row.key) || null;
                if (current && current.summary === row.summary) continue;
                const event = createMemoEvent(current, row.summary, { ...row, revision: (current ? current.revision : 0) + 1 }, settings.source || '로컬 XLSB 가져오기');
                await importEventsDirectly([event]);
                queued.push(event.eventId);
            }
            if (settings.mode === 'replace') {
                for (const current of getRows(DATASET_MEMO)) {
                    if (importedByKey.has(current.key)) continue;
                    const event = createMemoEvent(current, '', null, settings.source || '로컬 XLSB 가져오기');
                    await importEventsDirectly([event]);
                    queued.push(event.eventId);
                }
            }
        }
        emit('local-file-imported', { dataset: kind, queued: queued.length });
        return { dataset: kind, queued: queued.length, eventIds: queued };
    }

    async function importEventsDirectly(events) {
        return serializeLocal(async () => {
            const nextSnapshot = clone(snapshot);
            for (const event of events) {
                const merged = applyEvents(nextSnapshot[event.dataset], [event], { strict: true, syncStatus: '대기' });
                if (merged.conflicts.length) throw new ConflictError('Local import conflicts with current data.', merged.conflicts);
                nextSnapshot[event.dataset] = merged.state;
            }
            await persistAtomically(nextSnapshot, events, []);
        });
    }

    async function replaceLocalData(data, options) {
        assertInitialized();
        const settings = options || {};
        return serializeLocal(async () => {
            const pending = await readOutboxInternal();
            if (pending.length && !settings.force) {
                throw new MeetingDataStoreError('Cannot replace local data while the outbox is not empty.', 'OUTBOX_NOT_EMPTY');
            }
            const nextSnapshot = createEmptySnapshot();
            if (data && data.status) {
                nextSnapshot.status.rows = sortStatusRows((data.status.rows || []).map(normalizeStatusRow));
                nextSnapshot.status.history = sortHistory(clone(data.status.history || []));
            }
            if (data && data.memo) {
                nextSnapshot.memo.rows = sortMemoRows((data.memo.rows || []).map(normalizeMemoRow));
                nextSnapshot.memo.history = sortHistory(clone(data.memo.history || []));
            }
            await persistAtomically(nextSnapshot, [], settings.force ? pending.map((event) => event.eventId) : []);
            emit('local-replaced', { statusRows: nextSnapshot.status.rows.length, memoRows: nextSnapshot.memo.rows.length });
            return getSnapshot();
        });
    }

    async function clearLocalData(options) {
        assertInitialized();
        const settings = options || {};
        return serializeLocal(async () => {
            const pending = await readOutboxInternal();
            if (pending.length && !settings.force) throw new MeetingDataStoreError('Outbox is not empty. Export or sync it before clearing.', 'OUTBOX_NOT_EMPTY');
            await persistAtomically(createEmptySnapshot(), [], pending.map((event) => event.eventId));
            emit('local-cleared', {});
        });
    }

    async function create(options) {
        const settings = { ...(options || {}) };
        if (settings.token !== undefined) {
            setSessionToken(settings.token);
            delete settings.token;
        }
        if (!initialized) await init(settings);
        else if (options) configure(settings);
        return api;
    }

    function load(options) {
        const settings = { ...(options || {}) };
        if (settings.token !== undefined) {
            setSessionToken(settings.token);
            delete settings.token;
        }
        if (settings.github) {
            configure({ github: settings.github });
            delete settings.github;
        }
        return loadFromGitHub(settings);
    }

    function setStatus(key, status, options) {
        return upsertStatus(key, { status }, options || {});
    }

    function setMemo(key, text, options) {
        return upsertMemo(key, text, options);
    }

    async function pendingCount(kind) {
        return (await getOutbox(kind)).length;
    }

    function sync(options) {
        const settings = { ...(options || {}) };
        if (settings.token !== undefined) {
            setSessionToken(settings.token);
            delete settings.token;
        }
        if (settings.github) {
            configure({ github: settings.github });
            delete settings.github;
        }
        return syncAll(settings);
    }

    async function importXlsbFiles(files, options) {
        const inputs = files || {};
        const results = {};
        if (inputs.status) results.status = await importLocalFile(DATASET_STATUS, inputs.status, options);
        if (inputs.memo) results.memo = await importLocalFile(DATASET_MEMO, inputs.memo, options);
        if (!inputs.status && !inputs.memo) throw new TypeError('importXlsbFiles requires status and/or memo input.');
        return results;
    }

    const api = {
        version: '1.0.0',
        schemaVersion: SCHEMA_VERSION,
        datasets: Object.freeze({ status: DATASET_STATUS, memo: DATASET_MEMO }),
        headers: Object.freeze({
            status: STATUS_HEADERS.slice(),
            statusHistory: STATUS_HISTORY_HEADERS.slice(),
            memo: MEMO_HEADERS.slice(),
            memoHistory: MEMO_HISTORY_HEADERS.slice()
        }),
        errors: Object.freeze({ MeetingDataStoreError, SchemaError, GitHubError, ConflictError }),
        create,
        configure,
        getConfig,
        init,
        subscribe,
        getSnapshot,
        getRows,
        getHistory,
        getOutbox,
        pendingCount,
        setSessionToken,
        clearSessionToken,
        hasSessionToken,
        upsertStatus,
        setStatus,
        upsertMemo,
        setMemo,
        deleteMemo,
        parseXlsb,
        exportXlsb,
        downloadXlsb,
        importLocalFile,
        importXlsbFiles,
        exportOfflineTxt,
        importOfflineTxt,
        loadFromGitHub,
        load,
        syncDataset,
        syncAll,
        sync,
        replaceLocalData,
        clearLocalData
    };

    global.MeetingDataStore = Object.freeze(api);
})(typeof window !== 'undefined' ? window : globalThis);
