// ==UserScript==
// @name         Chuo Pocket Login
// @description  自分のGmailから新しいCampusSquare認証番号を読み、大学公式フォームへ入力する補助
// @version      1.0.0
// @match        https://portal.cs.chuo-u.ac.jp/campusweb/*
// @match        https://mail.google.com/mail/u/*
// @inject-into  content
// @run-at       document-end
// @noframes
// @grant        GM.getValue
// @grant        GM.setValue
// @grant        GM.deleteValue
// @grant        GM.getTab
// @grant        GM.saveTab
// @grant        GM.openInTab
// @grant        GM.closeTab
// @grant        GM.addStyle
// ==/UserScript==
(function(){
"use strict";
const ChuoAuthState=(()=>{const module={exports:{}};
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ChuoAuthState = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  var PHASES = new Set(['prepare','prepared','requested','ready','consumed','failed']);
  function validConfig(c) {
    return c && c.version === 1 && typeof c.email === 'string' && /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,63}$/i.test(c.email) &&
      Number.isInteger(c.accountIndex) && c.accountIndex >= 0 && c.accountIndex <= 9;
  }
  function validJob(j, now) {
    return j && j.version === 1 && /^[a-f0-9]{32}$/.test(j.nonce) && PHASES.has(j.phase) &&
      Number.isSafeInteger(j.createdAt) && Number.isSafeInteger(j.expiresAt) && j.createdAt <= now &&
      j.expiresAt > now && j.expiresAt - j.createdAt <= 600000 && /^[a-f0-9]{64}$/.test(j.ownerHash);
  }
  function canConsume(j, ownerHash, now) {
    return validJob(j, now) && j.phase === 'ready' && j.ownerHash === ownerHash &&
      typeof j.code === 'string' && /^\d{6}$/.test(j.code) && Number.isSafeInteger(j.requestStartedAt) &&
      j.requestStartedAt >= j.createdAt && j.requestStartedAt <= now && now - j.requestStartedAt <= 300000 &&
      Array.isArray(j.messageIds) && j.messageIds.length > 0;
  }
  function consumed(j, now) {
    if (!canConsume(j,j.ownerHash,now)) throw new Error('AUTH_EXPIRED');
    // New object: the code and message body never survive consumption.
    return {version:1,nonce:j.nonce,phase:'consumed',createdAt:j.createdAt,expiresAt:j.expiresAt,
      ownerHash:j.ownerHash,inputHash:j.inputHash||null,consumedAt:now};
  }
  return {validConfig:validConfig,validJob:validJob,canConsume:canConsume,consumed:consumed};
});

return module.exports;})();
const ChuoGmailDOM=(()=>{const module={exports:{}};
(function (root, factory) {
    'use strict';
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.ChuoGmailDOM = factory(); // Library only. No captured mail or secrets live on the global object.
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';
    var SUBJECT = '【CampusSquare】ワンタイムパスワードのお知らせ';
    var MAILBOX = /^[a-z0-9._%+-]+@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/i;
    var ID = /^[a-zA-Z0-9_:#-]{1,160}$/;
    var OTP_LABEL = '(?:ワンタイム(?:パスワード|認証コード|コード)|認証コード|確認コード|one[-\\s]?time\\s+(?:password|passcode|code)|verification\\s+code|\\bOTP\\b)';
    var OMIT = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'FORM', 'IFRAME', 'SVG', 'OBJECT', 'EMBED', 'BLOCKQUOTE']);
    var BLOCK = new Set(['DIV', 'P', 'PRE', 'SECTION', 'ARTICLE', 'LI', 'TR', 'TABLE', 'H1', 'H2', 'H3']);
    function list(value) { return Array.from(value || []); }
    function normalized(value) { return String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim(); }
    function unique(values) { return Array.from(new Set(values)); }
    function fail(code) { var error = new Error(code); error.name = 'ChuoGmailDOMError'; error.code = code; throw error; }

    function rules(input) {
        input = input || {};
        if (typeof input.expectedSender !== 'string' || !MAILBOX.test(input.expectedSender.trim())) fail('SENDER_REQUIRED');
        var subject = input.expectedSubject === undefined ? SUBJECT : input.expectedSubject;
        if (typeof subject !== 'string' || !normalized(subject) || subject.length > 500 || !/campus\s*square|キャンパス\s*スクエア/i.test(subject)) fail('SUBJECT_REQUIRED');
        return { expectedSender: input.expectedSender.trim().toLowerCase(), expectedSubject: normalized(subject) };
    }
    function isVisible(element, boundary) {
        // A hidden scope or its ancestors must not make a hidden message/popup look visible.
        // Gmail also hides parts with stylesheet classes rather than inline style.
        var view = element && element.ownerDocument && element.ownerDocument.defaultView;
        for (var current = element; current; current = current.parentElement) {
            if (current.hidden || current.getAttribute('hidden') !== null || current.getAttribute('aria-hidden') === 'true') return false;
            if (/(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*(?:hidden|collapse))\s*(?:!important)?\s*(?:;|$)/i.test(current.getAttribute('style') || '')) return false;
            if (view && typeof view.getComputedStyle === 'function') {
                var style = view.getComputedStyle(current);
                if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || style.opacity === '0') return false;
            }
        }
        return true;
    }
    function inBody(element, boundary) {
        for (var current = element; current; current = current.parentElement) {
            if ((current.getAttribute('class') || '').split(/\s+/).includes('a3s')) return true;
            if (current === boundary) break;
        }
        return false;
    }
    function plainText(node) {
        var pieces = [], count = 0;
        function visit(current) {
            if (!current || ++count > 20_000) { if (count > 20_000) fail('BODY_TOO_LARGE'); return; }
            if (current.nodeType === 3) { pieces.push(current.textContent || ''); return; }
            if (current.nodeType !== 1 || OMIT.has(current.tagName) || !isVisible(current, current.parentElement)) return;
            var classes = (current.getAttribute('class') || '').split(/\s+/);
            if (classes.includes('gmail_quote') || classes.includes('gmail_attr')) return;
            if (current.tagName === 'BR') { pieces.push('\n'); return; }
            if (BLOCK.has(current.tagName)) pieces.push('\n');
            list(current.childNodes).forEach(visit);
            if (current.tagName === 'TD' || current.tagName === 'TH') pieces.push('\t');
            if (BLOCK.has(current.tagName)) pieces.push('\n');
        }
        visit(node);
        var body = pieces.join('').replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
        if (body.length > 100_000) fail('BODY_TOO_LARGE');
        return body;
    }

    function parseJstMinuteTitle(value) {
        var input = normalized(value);
        var match = /^(\d{4})(?:年|\/|-)(\d{1,2})(?:月|\/|-)(\d{1,2})(?:日)?(?:\s*[（(][^()（）]{1,8}[）)])?\s+(\d{1,2}):(\d{2})$/.exec(input);
        if (!match) return null;
        var year = Number(match[1]), month = Number(match[2]), day = Number(match[3]), hour = Number(match[4]), minute = Number(match[5]);
        if (year < 2000 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return null;
        var date = new Date(Date.UTC(year, month - 1, day));
        if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
        var startMs = Date.UTC(year, month - 1, day, hour - 9, minute);
        return { startMs: startMs, endMs: startMs + 60_000, precision: 'minute', timeZone: 'Asia/Tokyo' };
    }
    function identityKeys(element, type) {
        var names = type === 'thread' ? ['data-legacy-thread-id', 'data-thread-id'] : ['data-legacy-message-id', 'data-message-id'];
        return names.flatMap(function (name) {
            var value = element.getAttribute(name);
            return value && ID.test(value) ? [name + ':' + value] : [];
        });
    }
    function threadKeys(scope) {
        var values = [];
        if (scope.getAttribute && !inBody(scope, scope) && isVisible(scope, scope)) values.push.apply(values, identityKeys(scope, 'thread'));
        list(scope.querySelectorAll('[data-legacy-thread-id], [data-thread-id]')).filter(function (element) { return !inBody(element, scope) && isVisible(element, scope); }).forEach(function (element) { values.push.apply(values, identityKeys(element, 'thread')); });
        return unique(values);
    }
    function validKeys(keys) {
        return Array.isArray(keys) && keys.length <= 20 && keys.every(function (key) { return typeof key === 'string' && /^data-(?:legacy-)?thread-id:/.test(key) && ID.test(key.slice(key.indexOf(':') + 1)); });
    }
    function intersects(left, right) { return left.some(function (value) { return right.includes(value); }); }
    function ownedElements(container, selector) {
        return list(container.querySelectorAll(selector)).filter(function (element) { return !inBody(element, container) && isVisible(element, container); });
    }

    function captureInboxCandidates(scope, config) {
        var settings = rules(config), candidates = [];
        list(scope.querySelectorAll('[role="row"]')).forEach(function (row) {
            if (!isVisible(row, scope)) return;
            var subjectNodes = list(row.querySelectorAll('span, div')).filter(function (node) { return isVisible(node, row) && normalized(plainText(node)) === settings.expectedSubject; });
            if (!subjectNodes.length) return;
            var senders = unique(ownedElements(row, 'span[email]').map(function (node) { return (node.getAttribute('email') || '').trim().toLowerCase(); }));
            if (senders.length !== 1 || senders[0] !== settings.expectedSender) return;
            var intervals = ownedElements(row, '[title]').map(function (node) { return parseJstMinuteTitle(node.getAttribute('title')); }).filter(Boolean);
            var uniqueIntervals = unique(intervals.map(function (interval) { return interval.startMs; }));
            var keys = threadKeys(row);
            if (uniqueIntervals.length !== 1 || !keys.length) return;
            candidates.push({ threadKeys: keys, subject: settings.expectedSubject, sender: settings.expectedSender, receivedInterval: intervals[0] });
        });
        return { status: 'captured', candidates: candidates };
    }

    function captureOpenThread(scope, config, options) {
        var settings = rules(config); options = options || {};
        var subjects = unique(ownedElements(scope, 'h2').map(function (node) { return normalized(plainText(node)); }).filter(Boolean));
        if (subjects.length !== 1 || subjects[0] !== settings.expectedSubject) return { status: 'wrong-thread', messages: [], identityKeys: [], threadKeys: [] };
        var observedKeys = threadKeys(scope), supplied = options.threadKeys || [];
        if (!validKeys(supplied) || (supplied.length && observedKeys.length && !intersects(supplied, observedKeys))) return { status: 'thread-mismatch', messages: [], identityKeys: [], threadKeys: [] };
        // A caller may bind keys from the inbox row it just opened when Gmail omits them in the open-thread DOM.
        var keys = supplied.length ? supplied : observedKeys;
        if (!keys.length) return { status: 'thread-id-missing', messages: [], identityKeys: [], threadKeys: [] };
        var allIds = [], messages = [], seenBodies = new Set();
        list(scope.querySelectorAll('[data-message-id], [data-legacy-message-id]')).forEach(function (container) {
            if (inBody(container, scope)) return;
            var aliases = identityKeys(container, 'message');
            allIds.push.apply(allIds, aliases); // Includes collapsed existing messages for baseline use.
            if (!aliases.length || !isVisible(container, scope)) return;
            var bodies = list(container.querySelectorAll('div.a3s')).filter(function (body) { return isVisible(body, container); });
            if (bodies.length !== 1 || seenBodies.has(bodies[0])) return;
            var senderNodes = ownedElements(container, 'span.gD[email]');
            var senders = unique(senderNodes.map(function (node) { return (node.getAttribute('email') || '').trim().toLowerCase(); }));
            if (senders.length !== 1 || senders[0] !== settings.expectedSender) return;
            var intervals = ownedElements(container, 'span.g3[title]').map(function (node) { return parseJstMinuteTitle(node.getAttribute('title')); }).filter(Boolean);
            if (unique(intervals.map(function (interval) { return interval.startMs; })).length !== 1) return;
            // Include IDs on nested message wrappers around the same body, without treating them as another mail.
            for (var parent = bodies[0].parentElement; parent && parent !== container; parent = parent.parentElement) aliases.push.apply(aliases, identityKeys(parent, 'message'));
            aliases = unique(aliases); allIds.push.apply(allIds, aliases); seenBodies.add(bodies[0]);
            try { messages.push({ id: aliases[0], identityKeys: aliases, threadKeys: keys.slice(), sender: settings.expectedSender,
                subject: settings.expectedSubject, receivedInterval: intervals[0], bodyText: plainText(bodies[0]) }); }
            catch (error) { messages.push({ id: aliases[0], identityKeys: aliases, threadKeys: keys.slice(), sender: settings.expectedSender,
                subject: settings.expectedSubject, receivedInterval: intervals[0], captureError: error.code || 'BODY_UNAVAILABLE' }); }
        });
        return { status: 'captured', threadKeys: keys.slice(), identityKeys: unique(allIds), messages: messages };
    }

    function createThreadBaseline(capture, capturedAt) {
        if (!capture || capture.status !== 'captured' || !validKeys(capture.threadKeys) || !capture.threadKeys.length || !Array.isArray(capture.identityKeys) || !Number.isSafeInteger(capturedAt) || capturedAt <= 0) fail('INVALID_BASELINE');
        return { kind: 'chuo-gmail-thread-baseline', version: 1, capturedAt: capturedAt,
            threadKeys: capture.threadKeys.slice(), identityKeys: capture.identityKeys.slice() };
    }
    function extractCodes(body) {
        var text = String(body || '').normalize('NFKC').replace(/\r\n?/g, '\n');
        var lines = [];
        for (var line of text.split('\n')) {
            if (/^-{2,}\s*(?:Original Message|Forwarded message|転送メッセージ)|^Begin forwarded message:|^転送メッセージ/i.test(line.trim())) break;
            if (!/^\s*>/.test(line)) lines.push(line);
        }
        text = lines.join('\n');
        var codes = new Set(), regex = new RegExp(OTP_LABEL + '[^0-9]{0,80}?([0-9]{6})(?![A-Za-z0-9-])', 'gi');
        for (var match of text.matchAll(regex)) {
            var start = match.index + match[0].length - 6;
            if (/[A-Za-z0-9-]/.test(text[start - 1] || '')) continue;
            codes.add(match[1]);
            var end = text.indexOf('\n', start), rest = text.slice(start + 6, end < 0 ? text.length : end);
            for (var other of rest.matchAll(/(?:^|[^A-Za-z0-9-])([0-9]{6})(?![A-Za-z0-9-])/g)) codes.add(other[1]);
        }
        return codes;
    }

    function selectFreshOtp(capture, config, options) {
        var settings = rules(config); options = options || {};
        var start = options.requestStartedAt, now = options.now === undefined ? Date.now() : options.now;
        var age = options.maxAgeMs === undefined ? 300_000 : options.maxAgeMs;
        var skew = options.futureSkewMs === undefined ? 15_000 : options.futureSkewMs;
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(now) || start <= 0 || start > now ||
            !Number.isSafeInteger(age) || age < 30_000 || age > 600_000 || !Number.isSafeInteger(skew) || skew < 0 || skew > 30_000) fail('INVALID_CHALLENGE_TIME');
        if (!capture || capture.status !== 'captured' || !Array.isArray(capture.messages) || !validKeys(capture.threadKeys)) return { status: 'not-ready', reason: capture && capture.status || 'thread-unavailable' };
        var baseline = options.baseline || null;
        if (baseline && (baseline.kind !== 'chuo-gmail-thread-baseline' || baseline.version !== 1 || !validKeys(baseline.threadKeys) || !Array.isArray(baseline.identityKeys) ||
            !Number.isSafeInteger(baseline.capturedAt) || baseline.capturedAt <= 0 || baseline.capturedAt > start || !intersects(baseline.threadKeys, capture.threadKeys))) return { status: 'not-ready', reason: 'baseline-mismatch' };
        var baselineIds = new Set(baseline ? baseline.identityKeys : []), used = options.usedMessageIds || new Set();
        if (!(used instanceof Set)) fail('INVALID_USED_IDS');
        var eligible = [], diagnostics = [], ambiguousMinute = false, unreadable = false;
        capture.messages.forEach(function (message) {
            var reject = function (reason) { diagnostics.push({ messageId: message.id, reason: reason }); };
            if (message.subject !== settings.expectedSubject || message.sender !== settings.expectedSender || !intersects(message.threadKeys || [], capture.threadKeys)) return reject('context-mismatch');
            if (!Array.isArray(message.identityKeys) || !message.identityKeys.length) return reject('message-id-missing');
            if (message.identityKeys.some(function (key) { return baselineIds.has(key); })) return reject('baseline-existing');
            if (used.has(message.id) || message.identityKeys.some(function (key) { return used.has(key); })) return reject('already-used');
            var interval = message.receivedInterval;
            if (!interval || interval.precision !== 'minute' || interval.timeZone !== 'Asia/Tokyo' || !Number.isSafeInteger(interval.startMs) || interval.endMs !== interval.startMs + 60_000) return reject('invalid-received-time');
            if (interval.endMs <= start || now - interval.endMs > age) return reject('stale');
            if (interval.startMs > now + skew) return reject('future-message');
            if (!baseline && interval.startMs < start) { ambiguousMinute = true; return reject('same-minute-without-baseline'); }
            if (message.captureError || typeof message.bodyText !== 'string') { unreadable = true; return reject('body-unavailable'); }
            var codes = extractCodes(message.bodyText);
            if (codes.size !== 1) { unreadable = true; return reject(codes.size ? 'ambiguous-code' : 'no-labelled-code'); }
            eligible.push({ status: 'found', messageId: message.id, identityKeys: message.identityKeys.slice(), threadKeys: capture.threadKeys.slice(), code: Array.from(codes)[0], receivedInterval: interval });
        });
        if (ambiguousMinute) return { status: 'ambiguous', reason: 'same-minute-without-baseline', diagnostics: diagnostics };
        if (eligible.length > 1) return { status: 'ambiguous', reason: 'multiple-new-messages', diagnostics: diagnostics };
        if (unreadable) return { status: 'manual-required', reason: 'unreadable-new-message', diagnostics: diagnostics };
        return eligible.length === 1 ? Object.assign(eligible[0], { diagnostics: diagnostics }) : { status: 'not-found', diagnostics: diagnostics };
    }

    function verifySignaturePopup(popup, config) {
        config = config || {};
        var domain = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,63}$/i;
        if (!domain.test(config.expectedSenderDomain || '') || !domain.test(config.expectedSigningDomain || '')) fail('SIGNATURE_DOMAINS_REQUIRED');
        // Mail-authored tables are not Gmail's message-detail UI.
        if (!popup || inBody(popup) || !isVisible(popup, popup)) return { status: 'unverified', reason: 'missing-details' };
        var senderDomains = [], signingDomains = [];
        list(popup.querySelectorAll('tr')).filter(function (row) { return isVisible(row, popup); }).forEach(function (row) {
            var value = normalized(plainText(row));
            var sender = /^送信元\s*[:：]\s*([^\s]+)$/.exec(value), signing = /^署名元\s*[:：]\s*([^\s]+)$/.exec(value);
            if (sender) senderDomains.push(sender[1].toLowerCase());
            if (signing) signingDomains.push(signing[1].toLowerCase());
        });
        if (senderDomains.length !== 1 || signingDomains.length !== 1) return { status: 'unverified', reason: senderDomains.length > 1 || signingDomains.length > 1 ? 'ambiguous-details' : 'missing-details' };
        if (senderDomains[0] !== config.expectedSenderDomain.toLowerCase() || signingDomains[0] !== config.expectedSigningDomain.toLowerCase()) return { status: 'unverified', reason: 'domain-mismatch' };
        // This describes the supplied popup only. Caller must bind it to the exact selected message.
        return { status: 'verified', senderDomain: senderDomains[0], signingDomain: signingDomains[0] };
    }
    return { parseJstMinuteTitle: parseJstMinuteTitle, captureInboxCandidates: captureInboxCandidates,
        captureOpenThread: captureOpenThread, createThreadBaseline: createThreadBaseline,
        selectFreshOtp: selectFreshOtp, verifySignaturePopup: verifySignaturePopup };
});

return module.exports;})();
const ChuoOTPAdapter=(()=>{const module={exports:{}};
/*
 * Proposal for an iPhone Safari "Run JavaScript on Web Page" action.
 * Load the separately verified CampusSquare flow manifest explicitly.
 * Without that fixed manifest, this adapter refuses to input/submit.
 * Pass only the extracted OTP, never a Gmail token, password, or email body.
 */
var ChuoOTPAdapter = (function () {
    "use strict";

    var OFFICIAL_HOSTS = new Set(["portal.cs.chuo-u.ac.jp", "gakunin-idp.c.chuo-u.ac.jp"]);
    var VERIFIED_PRODUCTION_FLOW = null;

    function fail(message) { return { ok: false, action: "refused", message: message }; }
    function compact(text) { return String(text || "").replace(/\s+/g, " ").trim(); }
    function parseURL(value, base) { try { return new URL(value, base); } catch (_) { return null; } }
    function exactPath(path) {
        if (typeof path !== "string" || !/^\/[^?#]*$/.test(path) || path.indexOf("//") !== -1) return false;
        var normalized = parseURL(path, "https://portal.cs.chuo-u.ac.jp");
        return normalized && normalized.pathname === path;
    }
    function validManifest(flow) {
        return flow && flow.domVerified === true && OFFICIAL_HOSTS.has(flow.host) && exactPath(flow.pagePath) && exactPath(flow.actionPath) &&
            typeof flow.formSelector === "string" && flow.formSelector.trim() &&
            typeof flow.inputSelector === "string" && flow.inputSelector.trim() &&
            typeof flow.labelSelector === "string" && flow.labelSelector.trim() &&
            typeof flow.submitSelector === "string" && flow.submitSelector.trim() &&
            typeof flow.labelText === "string" && compact(flow.labelText) &&
            typeof flow.inputName === "string" && flow.inputName &&
            ["text", "tel", "number"].indexOf(flow.inputType) !== -1 &&
            ["for", "contains", "sameForm"].indexOf(flow.labelRelation) !== -1 &&
            Number.isInteger(flow.codeLength) && flow.codeLength >= 4 && flow.codeLength <= 12 &&
            (flow.submitTag === undefined || ["BUTTON", "INPUT"].indexOf(flow.submitTag) !== -1) &&
            (flow.submitTag !== "INPUT" || (typeof flow.submitName === "string" && flow.submitName)) &&
            typeof flow.submitText === "string" && compact(flow.submitText);
    }
    function trusted(url, flow) {
        return url && url.protocol === "https:" && url.hostname === flow.host && !url.username && !url.password && (!url.port || url.port === "443");
    }
    function single(document, selector) {
        var matches;
        try { matches = Array.from(document.querySelectorAll(selector)); } catch (_) { return null; }
        return matches.length === 1 ? matches[0] : null;
    }
    function parentForm(element) {
        var parent = element && element.parentElement;
        while (parent && parent.tagName !== "FORM") parent = parent.parentElement;
        return parent;
    }
    function visible(element, view) {
        if (!element || typeof element.getClientRects !== "function" || !Array.from(element.getClientRects()).some(function (rect) { return rect.width > 0 && rect.height > 0; })) return false;
        var current = element;
        while (current && current.nodeType === 1) {
            if (current.hidden || current.getAttribute("hidden") !== null || current.getAttribute("aria-hidden") === "true") return false;
            if (view && typeof view.getComputedStyle === "function") {
                var style = view.getComputedStyle(current);
                if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" || Number(style.opacity) === 0) return false;
            }
            current = current.parentElement;
        }
        return true;
    }
    function enabled(element) {
        return element && !element.disabled && !element.readOnly && element.getAttribute("disabled") === null && element.getAttribute("readonly") === null;
    }
    function hasUnverifiedChallenge(document, view) {
        return Array.from(document.querySelectorAll("input,textarea,iframe")).some(function (element) {
            if (!visible(element, view)) return false;
            var marker = [element.getAttribute("name"), element.getAttribute("id"), element.getAttribute("aria-label"), element.getAttribute("src")].filter(Boolean).join(" ");
            return /captcha|recaptcha|hcaptcha|画像認証|画像の文字/i.test(marker);
        });
    }

    function inspect(document, location, flow) {
        if (!validManifest(flow)) return { result: fail("公式の確認コード画面が未検証です。この版では自動入力・送信できません。") };
        var url = parseURL(location && location.href);
        var view = document && document.defaultView;
        if (!document || !view || view.top !== view || !trusted(url, flow) || url.pathname !== flow.pagePath) {
            return { result: fail("確認済みの大学公式認証画面のメインページで実行してください。") };
        }
        var actual = parseURL(document.location && document.location.href);
        if (!trusted(actual, flow) || actual.pathname !== url.pathname) return { result: fail("現在の公式認証画面を確認できませんでした。") };
        if (Array.from(document.querySelectorAll('input[type="password"]')).some(function (field) { return visible(field, view); })) return { result: fail("大学パスワードを入力する画面では実行できません。確認コードの画面を開いてください。") };
        if (hasUnverifiedChallenge(document, view)) return { result: fail("画像認証など追加の確認があります。公式画面で手動操作してください。") };

        var form = single(document, flow.formSelector);
        var input = single(document, flow.inputSelector);
        var label = single(document, flow.labelSelector);
        var submitter = single(document, flow.submitSelector);
        if (flow.headingSelector || flow.headingText) {
            var heading = flow.headingSelector && single(document, flow.headingSelector);
            if (!heading || !visible(heading, view) || parentForm(heading) !== form || compact(heading.textContent) !== compact(flow.headingText)) {
                return { result: fail("公式のワンタイムパスワード画面の見出しを確認できませんでした。") };
            }
        }
        var submitTag = flow.submitTag || "BUTTON";
        if (!form || form.tagName !== "FORM" || !input || input.tagName !== "INPUT" || !label || !submitter || submitter.tagName !== submitTag ||
            !visible(form, view) || !visible(input, view) || !visible(label, view) || !visible(submitter, view) || !enabled(input) || !enabled(submitter)) {
            return { result: fail("確認コード画面の構造が確認済みの画面と一致しません。入力・送信を停止しました。") };
        }
        var action = parseURL(form.getAttribute("action") || actual.href, actual.href);
        if (String(form.getAttribute("method") || "get").toLowerCase() !== "post" || !trusted(action, flow) || action.pathname !== flow.actionPath ||
            parentForm(input) !== form || parentForm(submitter) !== form || parentForm(label) !== form ||
            String(input.getAttribute("type") || "text").toLowerCase() !== flow.inputType || input.getAttribute("name") !== flow.inputName ||
            String(submitter.getAttribute("type") || "submit").toLowerCase() !== "submit" ||
            compact(label.textContent) !== compact(flow.labelText) ||
            compact(submitter.tagName === "INPUT" ? submitter.getAttribute("value") : submitter.textContent) !== compact(flow.submitText) ||
            (flow.submitTag === "INPUT" && submitter.getAttribute("name") !== flow.submitName)) {
            return { result: fail("確認コード入力欄、表示ラベル、または送信先が確認済みの内容と異なります。入力・送信を停止しました。") };
        }
        if ((flow.labelRelation === "for" && (!input.getAttribute("id") || label.getAttribute("for") !== input.getAttribute("id"))) ||
            (flow.labelRelation === "contains" && !label.contains(input))) {
            return { result: fail("確認コードのラベルと入力欄の対応を確認できませんでした。") };
        }
        var maxlength = input.getAttribute("maxlength");
        if (maxlength !== null && Number(maxlength) !== flow.codeLength) return { result: fail("確認コードの桁数が確認済みの画面と一致しません。") };
        // Prevent a submit button from overriding the validated form's origin/action/method.
        if (submitter.getAttribute("formaction") !== null || submitter.getAttribute("formmethod") !== null || submitter.getAttribute("formtarget") !== null ||
            (form.getAttribute("target") !== null && ["", "_self"].indexOf(form.getAttribute("target")) === -1)) {
            return { result: fail("通常と異なる送信設定を検出しました。公式画面で手動操作してください。") };
        }
        var unexpectedField = Array.from(form.querySelectorAll("input,textarea,select")).some(function (element) {
            return element !== input && element !== submitter && visible(element, view) && enabled(element) && String(element.getAttribute("type") || "text").toLowerCase() !== "hidden";
        });
        if (unexpectedField) return { result: fail("確認コード以外の入力欄があります。公式画面で手動操作してください。") };
        var descriptor = view.HTMLInputElement && Object.getOwnPropertyDescriptor(view.HTMLInputElement.prototype, "value");
        var requestSubmit = view.HTMLFormElement && view.HTMLFormElement.prototype.requestSubmit;
        if (!descriptor || typeof descriptor.set !== "function" || typeof requestSubmit !== "function" || typeof view.Event !== "function") {
            return { result: fail("このブラウザーでは安全な入力・送信方法を利用できません。公式画面で手動操作してください。") };
        }
        return { form: form, input: input, submitter: submitter, view: view, setValue: descriptor.set, requestSubmit: requestSubmit };
    }

    function createAdapter(flow) {
        var manifest = VERIFIED_PRODUCTION_FLOW;
        if (flow) {
            // Snapshot structural settings only; do not retain arbitrary token/credential properties.
            var approvedKeys = ["domVerified", "host", "pagePath", "actionPath", "formSelector", "inputSelector", "inputName", "inputType", "headingSelector", "headingText", "labelSelector", "labelText", "labelRelation", "submitSelector", "submitTag", "submitName", "submitText", "codeLength"];
            manifest = {};
            approvedKeys.forEach(function (key) { manifest[key] = flow[key]; });
            Object.freeze(manifest);
        }
        return {
            inspectPage: function (document, location) {
                try {
                    var state = inspect(document, location, manifest);
                    return state.result || { ok: true, action: "verified", message: "確認済みの確認コード入力画面です。" };
                } catch (_) { return fail("公式認証画面を確認できませんでした。入力・送信を停止しました。"); }
            },
            applyOTP: function (document, location, otp, options) {
                var state;
                try {
                    state = inspect(document, location, manifest);
                    if (state.result) return state.result;
                    // String-only digit code: objects, tokens, full email bodies and broad guesses are rejected.
                    if (typeof otp !== "string" || !new RegExp("^[0-9]{" + manifest.codeLength + "}$").test(otp)) {
                        return fail("確認コードの形式を確認できませんでした。確認済みの桁数のコードだけを渡してください。");
                    }
                    state.setValue.call(state.input, otp);
                    state.input.dispatchEvent(new state.view.Event("input", { bubbles: true }));
                    state.input.dispatchEvent(new state.view.Event("change", { bubbles: true }));
                    var checkedAgain = inspect(document, location, manifest);
                    if (checkedAgain.result || checkedAgain.form !== state.form || checkedAgain.input !== state.input || checkedAgain.submitter !== state.submitter) {
                        state.setValue.call(state.input, "");
                        return fail("入力後に認証画面が変わったため送信を停止しました。公式画面を確認してください。");
                    }
                    if (!options || options.submit !== true) return { ok: true, action: "filled", message: "確認コードを入力しました。公式画面で送信してください。" };
                    if (typeof state.form.checkValidity !== "function" || !state.form.checkValidity()) {
                        state.setValue.call(state.input, "");
                        return fail("公式フォームの入力確認を通過できませんでした。手動操作してください。");
                    }
                    state.requestSubmit.call(state.form, state.submitter);
                    return { ok: true, action: "submitted", message: "確認コードを送信しました。認証結果は公式画面で確認してください。" };
                } catch (_) {
                    if (state && state.setValue && state.input) {
                        try { state.setValue.call(state.input, ""); } catch (_) {}
                    }
                    return fail("確認コードの入力・送信を完了できませんでした。公式画面で手動操作してください。");
                }
            }
        };
    }

    return { createAdapter: createAdapter };
})();

if (typeof module === "object" && module.exports) module.exports = ChuoOTPAdapter;

return module.exports;})();
const ChuoCampusSquareOTPManifest=(()=>{const module={exports:{}};
/* Exact flow observed on the official CampusSquare OTP page; no user secrets. */
var ChuoCampusSquareOTPManifest = Object.freeze({
    domVerified: true,
    host: "portal.cs.chuo-u.ac.jp",
    pagePath: "/campusweb/campussquare.do",
    actionPath: "/campusweb/campussquare.do",
    formSelector: "form#otpInputForm",
    inputSelector: "input#oneTimeCode",
    inputName: "oneTimeCode",
    inputType: "text",
    headingSelector: "#otpInputForm > div > h3",
    headingText: "ワンタイムパスワード認証を行います。",
    labelSelector: "#otpInputForm > div > div:nth-of-type(3)",
    labelText: "メールで受け取ったパスワード",
    labelRelation: "contains",
    submitSelector: 'form#otpInputForm input[type="submit"][name="_eventId_input"]',
    submitTag: "INPUT",
    submitName: "_eventId_input",
    submitText: "ログイン",
    codeLength: 6
});

if (typeof module === "object" && module.exports) module.exports = ChuoCampusSquareOTPManifest;

return module.exports;})();
/* Bundled into a single, locally installed Safari Userscript. No remote code or server. */
(async function runChuoLogin() {
  'use strict';
  if (window.top !== window || !['portal.cs.chuo-u.ac.jp','mail.google.com'].includes(location.hostname)) return;
  const KEY_CONFIG='config-v1',KEY_JOB='login-job-v1',KEY_USED='used-mail-ids-v1';
  const RULES={expectedSender:'no-reply@cs.chuo-u.ac.jp',expectedSubject:'【CampusSquare】ワンタイムパスワードのお知らせ'};
  const SIGNATURE={expectedSenderDomain:'cs.chuo-u.ac.jp',expectedSigningDomain:'cs.chuo-u.ac.jp'};
  const adapter=ChuoOTPAdapter.createAdapter(ChuoCampusSquareOTPManifest);
  const State=ChuoAuthState;
  if (typeof GM==='undefined' || !['getValue','setValue','deleteValue','openInTab','getTab','saveTab'].every(k=>typeof GM[k]==='function')) return;
  let busy=false,config=await GM.getValue(KEY_CONFIG,null),owner=null,openedKeys=null,signature=null,signaturePending=null;
  const panel=document.createElement('section');panel.id='chuo-pocket-login';panel.setAttribute('aria-label','中大ポケットのログイン補助');
  panel.innerHTML='<strong>中大ポケット</strong><p class="cp-status" role="status"></p><div class="cp-actions"></div><details><summary>メール連携の設定</summary><label>大学に登録したGmail<input type="email" class="cp-email" autocomplete="email"></label><label>Gmailのアカウント番号<input type="number" class="cp-index" min="0" max="9" value="0"></label><button type="button" class="cp-save">設定をこのiPhoneに保存</button><button type="button" class="cp-clear">連携設定を消す</button><p>番号はGmailのURLの /u/0/ の数字です。メール本文や大学パスワードは保存しません。</p></details>';
  document.body.append(panel);
  await GM.addStyle('#chuo-pocket-login{position:fixed!important;bottom:12px!important;right:12px!important;left:12px!important;z-index:2147483646!important;max-width:420px!important;margin-left:auto!important;padding:14px!important;border:1px solid #aaa!important;border-radius:14px!important;background:#fff!important;color:#20242b!important;box-shadow:0 4px 24px #0003!important;font:14px/1.6 system-ui!important;max-height:48vh!important;overflow:auto!important;box-sizing:border-box!important}#chuo-pocket-login p{margin:6px 0!important}#chuo-pocket-login button{font:inherit!important;border:1px solid #ba1837!important;border-radius:8px!important;background:#ba1837!important;color:#fff!important;padding:8px 10px!important;margin:3px!important;cursor:pointer!important}#chuo-pocket-login label{display:block!important}#chuo-pocket-login input{display:block!important;box-sizing:border-box!important;width:100%!important;border:1px solid #888!important;color:#20242b!important;background:#fff!important;padding:7px!important;font:inherit!important}#chuo-pocket-login details p{font-size:12px!important}');
  const say=t=>{panel.querySelector('.cp-status').textContent=t;};
  function actions(list){const area=panel.querySelector('.cp-actions');area.replaceChildren();for(const [text,fn]of list){const b=document.createElement('button');b.type='button';b.textContent=text;b.onclick=()=>perform(fn);area.append(b);}}
  async function perform(fn){if(busy)return;busy=true;try{await fn();}catch(_){say('処理を完了できませんでした。設定と公式画面を確認してください。保存した授業データは残っています。');}finally{busy=false;}}
  if(State.validConfig(config)){panel.querySelector('.cp-email').value=config.email;panel.querySelector('.cp-index').value=config.accountIndex;}
  panel.querySelector('.cp-save').onclick=()=>perform(async()=>{const c={version:1,email:panel.querySelector('.cp-email').value.trim().toLowerCase(),accountIndex:Number(panel.querySelector('.cp-index').value)};if(!State.validConfig(c)){say('Gmailアドレスと0〜9のアカウント番号を確認してください。');return;}await GM.setValue(KEY_CONFIG,c);config=c;say('設定を保存しました。Safariを閉じても次回に引き継ぎます。');await tick();});
  panel.querySelector('.cp-clear').onclick=()=>perform(async()=>{await GM.deleteValue(KEY_JOB);await GM.deleteValue(KEY_CONFIG);await GM.deleteValue(KEY_USED);config=null;panel.querySelector('.cp-email').value='';say('連携設定を消しました。授業データは残っています。');});
  const visible=e=>!!e&&e.getClientRects().length>0&&getComputedStyle(e).display!=='none'&&getComputedStyle(e).visibility!=='hidden';
  const random=()=>Array.from(crypto.getRandomValues(new Uint8Array(16)),x=>x.toString(16).padStart(2,'0')).join('');
  async function hash(text){const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text));return Array.from(new Uint8Array(bytes),x=>x.toString(16).padStart(2,'0')).join('');}
  async function flowHash(form){const keys=Array.from(form.querySelectorAll('input[type="hidden"][name="_flowExecutionKey"]'));if(keys.length!==1||!keys[0].value)throw Error('FLOW_MISSING');return hash(location.origin+location.pathname+'\n'+keys[0].value);}
  async function job(){const j=await GM.getValue(KEY_JOB,null);if(j&&!State.validJob(j,Date.now())){await GM.deleteValue(KEY_JOB);return null;}return j;}
  async function update(j,phase,fields={}){const current=await job();if(!current||current.nonce!==j.nonce||current.phase!==j.phase)return false;const next={...j,...fields,phase};await GM.setValue(KEY_JOB,next);return next;}
  async function openMail(){if(!State.validConfig(config))return;const query='from:'+RULES.expectedSender+' subject:ワンタイムパスワード';await GM.openInTab('https://mail.google.com/mail/u/'+config.accountIndex+'/#search/'+encodeURIComponent(query),false);}
  function sendStage(){if(location.pathname!=='/campusweb/campussquare.do')return null;const forms=Array.from(document.forms).filter(f=>{const a=new URL(f.getAttribute('action')||location.href,location.href);return (f.method||'').toLowerCase()==='post'&&a.origin===location.origin&&a.pathname===location.pathname&&Array.from(f.querySelectorAll('h3')).some(h=>visible(h)&&h.textContent.trim()==='ワンタイムパスワード認証を行います。')&&f.querySelectorAll('input[type="submit"][name="_eventId_send"][value="送信"]').length===1;});if(forms.length!==1)return null;const form=forms[0],button=form.querySelector('input[type="submit"][name="_eventId_send"]');if(!visible(button)||button.disabled||Array.from(document.querySelectorAll('input[type="password"]')).some(visible)||button.hasAttribute('formaction')||button.hasAttribute('formmethod'))return null;return{form,button};}
  async function start(){const s=sendStage();if(!s||!State.validConfig(config)){say('公式のメール送信画面を開き、Gmail設定を保存してください。');return;}const existing=await job();if(existing&&!['failed','consumed'].includes(existing.phase)){say('進行中の認証があります。再開するか中止してください。');return;}owner=random();await GM.saveTab({chuoOwner:owner});const now=Date.now();const j={version:1,nonce:random(),phase:'prepare',createdAt:now,expiresAt:now+600000,ownerHash:await hash(owner),sendHash:await flowHash(s.form)};await GM.setValue(KEY_JOB,j);await openMail();}
  async function cancel(){await GM.deleteValue(KEY_JOB);say('認証の進行状況を消しました。新しく開始できます。');}
  async function campusTick(){const j=await job(),s=sendStage(),isInput=adapter.inspectPage(document,location).ok;
    if(!State.validConfig(config)){say('初回だけGmailの連携設定を保存してください。');actions([]);return;}
    if(!j){say(s?'公式メールを送る前に、ログイン補助を開始してください。':isInput?'すでにメールを送信済みです。公式画面で入力するか、メール送信画面から補助を開始してください。':'大学のログイン状態を利用できます。期限切れの場合は公式ログイン画面へ進んでください。');actions(s?[['Gmailで自動認証を開始',start]]:[]);return;}
    const tab=await GM.getTab();owner=tab&&tab.chuoOwner||owner;
    let mine=owner&&await hash(owner)===j.ownerHash;
    if(!mine&&isInput&&j.inputHash&&await flowHash(document.querySelector('#otpInputForm'))===j.inputHash){mine=true;}
    if(!mine){say('別の画面で認証が進行中です。開始した大学のタブに戻ってください。');actions([['認証を中止',cancel]]);return;}
    if(j.phase==='prepare'){say('Gmailで過去の認証メールを確認しています。Gmailを前面で開いてください。');actions([['Gmailを開く',openMail],['認証を中止',cancel]]);return;}
    if(j.phase==='prepared'&&s){if(await flowHash(s.form)!==j.sendHash){say('公式画面が変わりました。認証を中止して開始し直してください。');actions([['認証を中止',cancel]]);return;}const now=Date.now();const next=await update(j,'requested',{requestStartedAt:now,expiresAt:now+300000});if(next){say('大学から認証メールを送信しています。');s.button.click();}return;}
    if(isInput&&['requested','ready'].includes(j.phase)){const currentHash=await flowHash(document.querySelector('#otpInputForm'));if(j.inputHash&&j.inputHash!==currentHash){say('別の認証画面のため入力を停止しました。');return;}if(!j.inputHash){await update(j,j.phase,{inputHash:currentHash});return;}
      if(j.phase==='requested'){say('新しい認証メールを取得します。Gmailを開いてください。');actions([['Gmailから番号を取得',openMail],['認証を中止',cancel]]);return;}
      if(!State.canConsume(j,j.ownerHash,Date.now())){await GM.deleteValue(KEY_JOB);say('認証番号の期限が切れました。新しく認証してください。');return;}
      const current=await job();if(!current||current.nonce!==j.nonce||current.phase!=='ready')return;
      const code=j.code;await GM.setValue(KEY_USED,Array.from(new Set([...(await GM.getValue(KEY_USED,[])),...j.messageIds])).slice(-200));await GM.setValue(KEY_JOB,State.consumed(j,Date.now()));
      const result=adapter.applyOTP(document,location,code,{submit:true});say(result.message);actions([]);return;
    }
    if(j.phase==='consumed'){say(isInput?'認証番号を送信済みです。公式画面の結果を確認してください。':'大学の画面を利用できます。連携設定は次回へ引き継ぎます。');actions([['進行状況を片付ける',cancel]]);return;}
    say('認証の途中です。開始した公式画面に戻ってください。');actions([['認証を中止',cancel]]);
  }
  function matchingAccount(){const labels=Array.from(document.querySelectorAll('a[aria-label^="Google アカウント"],a[aria-label^="Google Account"]')).filter(visible).map(e=>e.getAttribute('aria-label')||'');return State.validConfig(config)&&labels.length===1&&(labels[0].toLowerCase().match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,63}/g)||[]).includes(config.email);}
  function messageElement(ids){const all=Array.from(document.querySelectorAll('[data-message-id], [data-legacy-message-id]'));return all.find(e=>visible(e)&&['data-message-id','data-legacy-message-id'].some(k=>ids.includes(k+':'+e.getAttribute(k))));}
  function detailsTables(){return Array.from(document.querySelectorAll('table.ajC')).filter(visible);}
  async function gmailTick(){const j=await job();if(!j||!['prepare','requested'].includes(j.phase)){say('Gmailの連携設定は保存されています。認証はCampusSquareのメール送信画面から開始してください。');actions([]);return;}
    if(!matchingAccount()){say('設定したGmailアカウントで開いてください。Safariでデスクトップ用Webサイトを表示すると対応画面になります。');actions([]);return;}
    let capture=ChuoGmailDOM.captureOpenThread(document,RULES,{threadKeys:openedKeys||j.baseline&&j.baseline.threadKeys||[]});
    if(capture.status!=='captured'){const inbox=ChuoGmailDOM.captureInboxCandidates(document,RULES);const candidates=inbox.candidates.sort((a,b)=>b.receivedInterval.startMs-a.receivedInterval.startMs);if(!candidates.length){say('CampusSquareの認証メールの検索結果を開いてください。初回の過去メールがない場合は一度公式画面で認証してください。');return;}const chosen=candidates[0];const row=Array.from(document.querySelectorAll('[role="row"]')).find(r=>visible(r)&&Array.from(r.querySelectorAll('[data-thread-id],[data-legacy-thread-id]')).some(e=>['data-thread-id','data-legacy-thread-id'].some(k=>chosen.threadKeys.includes(k+':'+e.getAttribute(k)))));if(!row)return;openedKeys=chosen.threadKeys;row.click();say('CampusSquareの認証メールだけを確認しています。');return;}
    if(j.phase==='prepare'){const baseline=ChuoGmailDOM.createThreadBaseline(capture,Date.now());if(await update(j,'prepared',{baseline})){say('過去メールを記録しました。CampusSquareのタブに戻ると新しい認証メールを送信します。');actions([['このGmailタブを閉じて戻る',()=>GM.closeTab()]]);}return;}
    const found=ChuoGmailDOM.selectFreshOtp(capture,RULES,{baseline:j.baseline,requestStartedAt:j.requestStartedAt,usedMessageIds:new Set(await GM.getValue(KEY_USED,[])),now:Date.now()});
    if(found.status!=='found'){say(found.status==='ambiguous'||found.status==='manual-required'?'新しい認証メールを一意に確認できません。公式画面で確認してください。':'認証メールの到着を待っています。このGmail画面を前面にしておいてください。');return;}
    const element=messageElement(found.identityKeys);if(!element)return;
    if(signature&&signature.messageId===found.messageId&&Date.now()-signature.checkedAt<30000){const fresh=await job();if(!fresh||fresh.nonce!==j.nonce||fresh.phase!=='requested')return;const next=await update(fresh,'ready',{code:found.code,messageIds:found.identityKeys,codeCapturedAt:Date.now()});if(next){say('新しい認証番号を取得しました。CampusSquareへ戻ると公式フォームに入力・送信します。');actions([['このGmailタブを閉じて戻る',()=>GM.closeTab()]]);}return;}
    if(signaturePending&&signaturePending.messageId===found.messageId){const tables=detailsTables().filter(t=>!signaturePending.existing.has(t));if(tables.length===1&&ChuoGmailDOM.verifySignaturePopup(tables[0],SIGNATURE).status==='verified'){signature={messageId:found.messageId,checkedAt:Date.now()};signaturePending=null;return;}if(Date.now()-signaturePending.startedAt>10000){signaturePending=null;say('送信元の署名を確認できません。メールの詳細を閉じて再確認してください。');}return;}
    const buttons=Array.from(element.querySelectorAll('[role="button"].ajy')).filter(b=>visible(b)&&['詳細を表示','Show details'].includes(b.getAttribute('aria-label')));if(buttons.length!==1)return;
    const existing=new Set(detailsTables());if(existing.size){say('メールの詳細を一度閉じてください。新しいメールの署名を照合します。');return;}
    signaturePending={messageId:found.messageId,existing,startedAt:Date.now()};buttons[0].click();
  }
  async function tick(){config=await GM.getValue(KEY_CONFIG,null);if(document.visibilityState==='hidden')return;if(location.hostname==='mail.google.com')await gmailTick();else await campusTick();}
  const refresh=()=>perform(tick);document.addEventListener('visibilitychange',refresh);window.addEventListener('pageshow',refresh);setInterval(refresh,1500);await refresh();
})();

})();
