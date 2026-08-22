(function attachMeetingGithubCredential(global) {
    'use strict';

    const DEFAULT_CONFIG = Object.freeze({
        repo: 'JongGunelee/wyggkr04',
        branch: 'main',
        remoteVaultPath: 'RawData/공정관리/encrypted-pat.json',
        localVaultKey: 'codex_gh_token_vault_v1',
        rememberedPinKey: 'codex_gh_token_pin_remember_v1',
        legacyTokenKey: 'github_pat',
        defaultPin: '2026xlsb',
        fetchTimeoutMs: 12000
    });

    let config = { ...DEFAULT_CONFIG };
    let tokenConsumer = null;
    let sessionToken = '';
    let remoteVault = null;
    let remoteVaultPromise = null;
    let promptPromise = null;

    class MeetingGithubCredentialError extends Error {
        constructor(message, code) {
            super(message);
            this.name = 'MeetingGithubCredentialError';
            this.code = code || 'GITHUB_CREDENTIAL_ERROR';
        }
    }

    function isLikelyGithubToken(value) {
        const token = String(value || '').trim();
        return /^(github_pat_|gh[pousr]_)[A-Za-z0-9_]+$/.test(token);
    }

    function validPin(value) {
        return /^[0-9A-Za-z]{4,12}$/.test(String(value || '').trim());
    }

    function isValidVault(vault) {
        return Boolean(vault && vault.v === 1 && vault.alg === 'AES-GCM'
            && vault.kdf === 'PBKDF2-SHA256' && vault.salt && vault.iv && vault.cipher);
    }

    function storage() {
        try { return global.localStorage || null; } catch (_) { return null; }
    }

    function webCrypto() {
        const cryptoObject = global.crypto;
        if (!cryptoObject || !cryptoObject.subtle || !cryptoObject.getRandomValues
            || !global.TextEncoder || !global.TextDecoder) {
            throw new MeetingGithubCredentialError('이 브라우저는 PAT 암호문 복호화를 지원하지 않습니다.', 'WEB_CRYPTO_UNAVAILABLE');
        }
        return cryptoObject;
    }

    function adoptToken(value) {
        const token = String(value || '').trim();
        if (!isLikelyGithubToken(token)) {
            throw new MeetingGithubCredentialError('GitHub PAT 형식이 아닙니다.', 'INVALID_TOKEN_FORMAT');
        }
        sessionToken = token;
        if (tokenConsumer && typeof tokenConsumer.setSessionToken === 'function') tokenConsumer.setSessionToken(token);
        return token;
    }

    function clearSessionToken() {
        sessionToken = '';
        if (tokenConsumer && typeof tokenConsumer.clearSessionToken === 'function') tokenConsumer.clearSessionToken();
    }

    function clearStoredGithubToken(reason) {
        clearSessionToken();
        const local = storage();
        try { local?.removeItem(config.legacyTokenKey); } catch (_) { /* no-op */ }
        try { local?.removeItem(config.localVaultKey); } catch (_) { /* no-op */ }
        try {
            global.__meetingGithubCredentialReset = {
                reason: String(reason || 'auth-failed'),
                at: new Date().toISOString()
            };
        } catch (_) { /* no-op */ }
    }

    function hasSessionToken() {
        return isLikelyGithubToken(sessionToken)
            || Boolean(tokenConsumer && typeof tokenConsumer.hasSessionToken === 'function' && tokenConsumer.hasSessionToken());
    }

    function migrateLegacySessionToken() {
        const local = storage();
        if (!local) return '';
        try {
            const legacy = String(local.getItem(config.legacyTokenKey) || '').trim();
            if (!legacy) return '';
            local.removeItem(config.legacyTokenKey);
            return isLikelyGithubToken(legacy) ? adoptToken(legacy) : '';
        } catch (_) {
            return '';
        }
    }

    function bytesToBase64(bytes) {
        const source = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
        let binary = '';
        for (let index = 0; index < source.length; index += 1) binary += String.fromCharCode(source[index]);
        return global.btoa(binary);
    }

    function base64ToBytes(value) {
        const binary = global.atob(String(value || ''));
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
        return bytes;
    }

    async function deriveVaultKey(pin, salt, iterations) {
        const cryptoObject = webCrypto();
        const encoder = new global.TextEncoder();
        const baseKey = await cryptoObject.subtle.importKey('raw', encoder.encode(String(pin || '')), 'PBKDF2', false, ['deriveKey']);
        return cryptoObject.subtle.deriveKey({
            name: 'PBKDF2',
            salt,
            iterations: Number(iterations) || 120000,
            hash: 'SHA-256'
        }, baseKey, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    }

    async function saveTokenVault(token, pin) {
        if (!isLikelyGithubToken(token)) throw new MeetingGithubCredentialError('GitHub PAT 형식이 아닙니다.', 'INVALID_TOKEN_FORMAT');
        if (!validPin(pin)) throw new MeetingGithubCredentialError('간편키는 4~12자리 영문/숫자로 입력하세요.', 'INVALID_PIN');
        const local = storage();
        if (!local) throw new MeetingGithubCredentialError('PAT 암호문을 보관할 브라우저 저장소를 사용할 수 없습니다.', 'STORAGE_UNAVAILABLE');
        const cryptoObject = webCrypto();
        const salt = new Uint8Array(16);
        const iv = new Uint8Array(12);
        cryptoObject.getRandomValues(salt);
        cryptoObject.getRandomValues(iv);
        const key = await deriveVaultKey(pin, salt, 120000);
        const cipher = await cryptoObject.subtle.encrypt({ name: 'AES-GCM', iv }, key, new global.TextEncoder().encode(token));
        const vault = {
            v: 1,
            alg: 'AES-GCM',
            kdf: 'PBKDF2-SHA256',
            iterations: 120000,
            salt: bytesToBase64(salt),
            iv: bytesToBase64(iv),
            cipher: bytesToBase64(cipher),
            createdAt: new Date().toISOString()
        };
        local.setItem(config.localVaultKey, JSON.stringify(vault));
        local.removeItem(config.legacyTokenKey);
        return adoptToken(token);
    }

    async function unlockTokenVault(pin, vaultOverride) {
        if (!validPin(pin)) throw new MeetingGithubCredentialError('간편키는 4~12자리 영문/숫자로 입력하세요.', 'INVALID_PIN');
        let vault = vaultOverride || null;
        if (!vault) {
            const raw = storage()?.getItem(config.localVaultKey);
            if (!raw) return '';
            vault = JSON.parse(raw);
        }
        if (!isValidVault(vault)) throw new MeetingGithubCredentialError('PAT 암호문 형식이 올바르지 않습니다.', 'INVALID_VAULT');
        const cryptoObject = webCrypto();
        const salt = base64ToBytes(vault.salt);
        const iv = base64ToBytes(vault.iv);
        const cipher = base64ToBytes(vault.cipher);
        const key = await deriveVaultKey(pin, salt, vault.iterations);
        const plain = await cryptoObject.subtle.decrypt({ name: 'AES-GCM', iv }, key, cipher);
        return adoptToken(new global.TextDecoder().decode(plain));
    }

    function encodePath(path) {
        return String(path || '').split('/').map(part => encodeURIComponent(part)).join('/');
    }

    function remoteVaultUrls() {
        if (Array.isArray(config.remoteVaultUrls) && config.remoteVaultUrls.length) return config.remoteVaultUrls.slice();
        const parts = String(config.repo || DEFAULT_CONFIG.repo).split('/').filter(Boolean);
        const owner = parts[0] || 'JongGunelee';
        const repo = parts[1] || 'wyggkr04';
        const branch = config.branch || 'main';
        const path = encodePath(config.remoteVaultPath);
        return [
            `https://${owner.toLowerCase()}.github.io/${encodeURIComponent(repo)}/${path}`,
            `https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(branch)}/${path}`
        ];
    }

    async function fetchJsonWithTimeout(url) {
        const controller = typeof global.AbortController === 'function' ? new global.AbortController() : null;
        const timer = controller ? global.setTimeout(() => controller.abort(), config.fetchTimeoutMs) : 0;
        try {
            const response = await global.fetch(url, {
                method: 'GET',
                cache: 'no-store',
                signal: controller?.signal
            });
            if (!response.ok) return null;
            return await response.json();
        } finally {
            if (timer) global.clearTimeout(timer);
        }
    }

    async function fetchRemoteTokenVault() {
        if (remoteVault) return remoteVault;
        if (remoteVaultPromise) return remoteVaultPromise;
        remoteVaultPromise = (async () => {
            for (const url of remoteVaultUrls()) {
                try {
                    const candidate = await fetchJsonWithTimeout(url);
                    if (isValidVault(candidate)) {
                        remoteVault = candidate;
                        return candidate;
                    }
                } catch (_) { /* fallback URL */ }
            }
            return null;
        })();
        try { return await remoteVaultPromise; }
        finally { remoteVaultPromise = null; }
    }

    function hasLocalVault() {
        try { return Boolean(storage()?.getItem(config.localVaultKey)); } catch (_) { return false; }
    }

    function getRememberedPin() {
        try {
            const pin = String(storage()?.getItem(config.rememberedPinKey) || '').trim();
            return validPin(pin) ? pin : '';
        } catch (_) { return ''; }
    }

    function setRememberedPin(pin, remember) {
        const local = storage();
        if (!local) return;
        try {
            if (remember && validPin(pin)) local.setItem(config.rememberedPinKey, String(pin).trim());
            else local.removeItem(config.rememberedPinKey);
        } catch (_) { /* no-op */ }
    }

    function hardenSecretInput(input, purpose) {
        if (!input) return;
        input.setAttribute('autocomplete', 'new-password');
        input.setAttribute('autocorrect', 'off');
        input.setAttribute('autocapitalize', 'none');
        input.setAttribute('spellcheck', 'false');
        input.setAttribute('data-lpignore', 'true');
        input.setAttribute('data-1p-ignore', 'true');
        input.name = `meeting_credential_${purpose}_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
        ['beforeinput', 'input', 'change', 'paste', 'compositionstart', 'compositionupdate', 'compositionend', 'keyup', 'keydown']
            .forEach(type => input.addEventListener(type, event => event.stopPropagation()));
    }

    function createPromptShell(width) {
        const overlay = global.document.createElement('div');
        overlay.id = 'meetingGithubPatPrompt';
        overlay.setAttribute('role', 'dialog');
        overlay.setAttribute('aria-modal', 'true');
        overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483001;background:rgba(15,23,42,.42);display:flex;align-items:center;justify-content:center;padding:18px;';
        const panel = global.document.createElement('div');
        panel.style.cssText = `width:min(${width || 400}px,100%);max-height:calc(100dvh - 36px);overflow:auto;background:#fff;border:1px solid #c8d7ea;border-radius:14px;box-shadow:0 20px 60px rgba(15,23,42,.3);padding:18px;font-family:inherit;color:#0f172a;`;
        ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'touchstart', 'touchend']
            .forEach(type => panel.addEventListener(type, event => event.stopPropagation()));
        overlay.appendChild(panel);
        global.document.body.appendChild(overlay);
        return { overlay, panel };
    }

    function bindPinToggle(panel, input) {
        const toggle = panel.querySelector('[data-pin-toggle]');
        if (!toggle || !input) return;
        toggle.addEventListener('click', () => {
            const reveal = input.type === 'password';
            input.type = reveal ? 'text' : 'password';
            toggle.textContent = reveal ? '숨김' : '보기';
        });
    }

    function requestTokenUnlock(source, vault) {
        return new Promise((resolve, reject) => {
            global.document.getElementById('meetingGithubPatPrompt')?.remove();
            const { overlay, panel } = createPromptShell(390);
            const remote = source === 'remote';
            panel.innerHTML = `<div style="font-weight:900;font-size:17px;margin-bottom:8px;">${remote ? 'GitHub PAT 암호문 열기' : 'PAT 암호문 열기'}</div><div style="font-size:13px;color:#475569;margin-bottom:12px;">${remote ? 'GitHub encrypted-pat.json과 조합할 간편키를 입력하세요.' : '등록할 때 설정한 간편키를 입력하세요.'}</div><div style="display:flex;gap:7px;"><input data-pin-input type="password" inputmode="text" placeholder="간편키 4~12자리" style="flex:1;min-width:0;height:42px;border:1px solid #cbd5e1;border-radius:8px;padding:0 11px;font-size:16px;background:#f8fafc;"><button type="button" data-pin-toggle style="height:42px;padding:0 11px;border:1px solid #cbd5e1;border-radius:8px;background:#fff;font-weight:800;">보기</button></div><label style="display:flex;align-items:center;gap:7px;margin-top:10px;font-size:12px;color:#475569;font-weight:700;"><input data-pin-remember type="checkbox" style="width:15px;height:15px;"> 이 기기에 간편키 저장</label><div data-help role="alert" style="display:none;margin-top:9px;font-size:12px;color:#b91c1c;font-weight:800;"></div><div style="display:flex;gap:8px;justify-content:flex-end;margin-top:15px;">${remote ? '' : '<button type="button" data-reset style="padding:8px 12px;border:1px solid #fca5a5;border-radius:8px;background:#fff;color:#b91c1c;font-weight:800;">재등록</button>'}<button type="button" data-cancel style="padding:8px 12px;border:1px solid #cbd5e1;border-radius:8px;background:#fff;font-weight:800;">취소</button><button type="button" data-confirm style="padding:8px 14px;border:1px solid #1d4ed8;border-radius:8px;background:#1d4ed8;color:#fff;font-weight:900;">열기</button></div>`;
            const input = panel.querySelector('[data-pin-input]');
            const remember = panel.querySelector('[data-pin-remember]');
            const help = panel.querySelector('[data-help]');
            hardenSecretInput(input, remote ? 'remote_pin' : 'local_pin');
            bindPinToggle(panel, input);
            const remembered = getRememberedPin();
            if (remembered) {
                input.value = remembered;
                remember.checked = true;
            } else if (validPin(config.defaultPin)) {
                input.value = String(config.defaultPin);
            }
            let done = false;
            const finish = (value, error) => {
                if (done) return;
                done = true;
                input.value = '';
                overlay.remove();
                if (error) reject(error);
                else resolve(value || '');
            };
            const close = value => finish(value, null);
            panel.querySelector('[data-cancel]').addEventListener('click', () => close(''));
            panel.querySelector('[data-reset]')?.addEventListener('click', () => {
                try { storage()?.removeItem(config.localVaultKey); } catch (_) { /* no-op */ }
                setRememberedPin('', false);
                close('__reset__');
            });
            panel.querySelector('[data-confirm]').addEventListener('click', async () => {
                try {
                    const pin = String(input.value || '').trim();
                    const token = await unlockTokenVault(pin, vault);
                    setRememberedPin(pin, remember.checked);
                    close(token);
                } catch (_) {
                    finish('', new MeetingGithubCredentialError(
                        '조합키가 맞지 않거나 GitHub PAT 암호문을 열 수 없습니다.',
                        'CREDENTIAL_UNLOCK_FAILED'
                    ));
                }
            });
            input.addEventListener('keydown', event => {
                if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); panel.querySelector('[data-confirm]').click(); }
                if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(''); }
            });
            global.setTimeout(() => input.focus(), 0);
        });
    }

    function requestTokenSetup() {
        return new Promise(resolve => {
            global.document.getElementById('meetingGithubPatPrompt')?.remove();
            const { overlay, panel } = createPromptShell(430);
            panel.innerHTML = '<div style="font-weight:900;font-size:17px;margin-bottom:8px;">GitHub PAT 최초 등록</div><div style="font-size:13px;color:#475569;margin-bottom:12px;">PAT 원문은 HTML·XLSB·TXT에 기록하지 않고 AES-GCM 암호문으로만 보관합니다.</div><label style="display:block;font-size:12px;font-weight:800;margin-bottom:4px;">GitHub PAT</label><input data-token-input type="password" placeholder="github_pat_ 또는 ghp_" style="width:100%;height:42px;border:1px solid #cbd5e1;border-radius:8px;padding:0 11px;background:#f8fafc;"><label style="display:block;font-size:12px;font-weight:800;margin:10px 0 4px;">간편키 4~12자리</label><div style="display:flex;gap:7px;"><input data-pin-input type="password" inputmode="text" placeholder="간편키" style="flex:1;min-width:0;height:42px;border:1px solid #cbd5e1;border-radius:8px;padding:0 11px;font-size:16px;background:#f8fafc;"><button type="button" data-pin-toggle style="height:42px;padding:0 11px;border:1px solid #cbd5e1;border-radius:8px;background:#fff;font-weight:800;">보기</button></div><label style="display:flex;align-items:center;gap:7px;margin-top:10px;font-size:12px;color:#475569;font-weight:700;"><input data-pin-remember type="checkbox" style="width:15px;height:15px;"> 이 기기에 간편키 저장</label><div data-help role="alert" style="display:none;margin-top:9px;font-size:12px;color:#b91c1c;font-weight:800;"></div><div style="display:flex;gap:8px;justify-content:flex-end;margin-top:15px;"><button type="button" data-cancel style="padding:8px 12px;border:1px solid #cbd5e1;border-radius:8px;background:#fff;font-weight:800;">취소</button><button type="button" data-confirm style="padding:8px 14px;border:1px solid #1d4ed8;border-radius:8px;background:#1d4ed8;color:#fff;font-weight:900;">등록</button></div>';
            const tokenInput = panel.querySelector('[data-token-input]');
            const pinInput = panel.querySelector('[data-pin-input]');
            const remember = panel.querySelector('[data-pin-remember]');
            const help = panel.querySelector('[data-help]');
            hardenSecretInput(tokenInput, 'pat');
            hardenSecretInput(pinInput, 'setup_pin');
            bindPinToggle(panel, pinInput);
            const remembered = getRememberedPin();
            if (remembered) {
                pinInput.value = remembered;
                remember.checked = true;
            } else if (validPin(config.defaultPin)) {
                pinInput.value = String(config.defaultPin);
            }
            let done = false;
            const close = value => {
                if (done) return;
                done = true;
                tokenInput.value = '';
                pinInput.value = '';
                overlay.remove();
                resolve(value || '');
            };
            panel.querySelector('[data-cancel]').addEventListener('click', () => close(''));
            panel.querySelector('[data-confirm]').addEventListener('click', async () => {
                try {
                    const pin = String(pinInput.value || '').trim();
                    const token = await saveTokenVault(String(tokenInput.value || '').trim(), pin);
                    setRememberedPin(pin, remember.checked);
                    close(token);
                } catch (error) {
                    help.textContent = error?.message || 'PAT를 암호화해 등록하지 못했습니다.';
                    help.style.display = 'block';
                }
            });
            [tokenInput, pinInput].forEach(input => input.addEventListener('keydown', event => {
                if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); panel.querySelector('[data-confirm]').click(); }
                if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(''); }
            }));
            global.setTimeout(() => tokenInput.focus(), 0);
        });
    }

    async function ensureToken(options) {
        const settings = options || {};
        if (settings.token) return adoptToken(settings.token);
        if (!settings.forcePrompt && isLikelyGithubToken(sessionToken)) return sessionToken;
        if (!settings.forcePrompt) {
            const legacy = migrateLegacySessionToken();
            if (legacy) return legacy;
        }
        if (settings.allowPrompt === false) return '';
        if (promptPromise) return promptPromise;
        promptPromise = (async () => {
            let entered = '';
            if (!settings.skipLocalVault && hasLocalVault()) {
                entered = await requestTokenUnlock('local');
                if (entered === '__reset__') entered = '';
                else if (!entered) return '';
            }
            if (!entered) {
                const vault = await fetchRemoteTokenVault();
                if (vault) {
                    entered = await requestTokenUnlock('remote', vault);
                    if (!entered) return '';
                }
            }
            if (!entered && settings.allowSetup !== false) entered = await requestTokenSetup();
            return entered ? adoptToken(entered) : '';
        })();
        try { return await promptPromise; }
        finally { promptPromise = null; }
    }

    function configure(options) {
        const settings = options || {};
        config = { ...config, ...(settings.github || {}), ...settings };
        delete config.github;
        if (settings.tokenConsumer) tokenConsumer = settings.tokenConsumer;
        return api;
    }

    function getState() {
        return {
            sessionReady: hasSessionToken(),
            localVaultAvailable: hasLocalVault(),
            remoteVaultLoaded: Boolean(remoteVault),
            promptActive: Boolean(promptPromise),
            remoteVaultPath: config.remoteVaultPath
        };
    }

    const api = {
        configure,
        adoptToken,
        ensureToken,
        clearSessionToken,
        clearStoredGithubToken,
        hasSessionToken,
        isLikelyGithubToken,
        isValidVault,
        fetchRemoteTokenVault,
        unlockTokenVault,
        getState,
        Error: MeetingGithubCredentialError
    };

    global.MeetingGithubCredential = api;
})(typeof window !== 'undefined' ? window : globalThis);
