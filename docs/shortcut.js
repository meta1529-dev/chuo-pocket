/* Read-only Safari DOM adapter. No network, cookie/storage access, or field-value reads. */
var ChuoCaptureCore = (function () {
    "use strict";

    var MANABA_ORIGIN = "https://room.chuo-u.ac.jp";
    var CAMPUS_ORIGIN = "https://portal.cs.chuo-u.ac.jp";
    var DAYS = { "月": 1, "火": 2, "水": 3, "木": 4, "金": 5, "土": 6, "日": 7 };
    var SECRET_NAMES = new Set([
        "samlrequest", "samlresponse", "relaystate", "ticket", "token", "access_token", "id_token",
        "code", "state", "auth", "authorization", "auth_token", "authtoken", "session", "session_id", "sessionid", "jsessionid", "sid", "phpsessid", "otp", "password", "_flowexecutionkey",
        "flowexecutionkey", "rwfhash", "execution", "csrf", "csrf_token", "_csrf"
    ]);
    var OMIT_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "INPUT", "TEXTAREA", "SELECT", "BUTTON", "NAV", "HEADER", "FOOTER"]);
    var BLOCK_TAGS = new Set(["ARTICLE", "DIV", "SECTION", "MAIN", "P", "PRE", "H1", "H2", "H3", "H4", "H5", "H6", "LI", "TR", "TABLE"]);

    function reject(message) {
        var error = new Error(message);
        error.name = "ChuoCaptureError";
        throw error;
    }

    function asArray(list) { return Array.from(list || []); }
    function cleanSpace(text) { return String(text || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim(); }
    function visibleByAttributes(element) {
        if (!element || element.nodeType !== 1) return true;
        if (element.hidden || element.getAttribute("hidden") !== null || element.getAttribute("aria-hidden") === "true") return false;
        return !/(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)\s*(?:!important)?\s*(?:;|$)/i.test(element.getAttribute("style") || "");
    }

    // Traverse text nodes only. In particular, never consult input.value or textarea.value.
    function plainText(node) {
        var pieces = [];
        function visit(current) {
            if (!current) return;
            if (current.nodeType === 3) { pieces.push(current.textContent || ""); return; }
            if (current.nodeType !== 1 || OMIT_TAGS.has(current.tagName) || !visibleByAttributes(current)) return;
            if (current.tagName === "BR") { pieces.push("\n"); return; }
            if (BLOCK_TAGS.has(current.tagName)) pieces.push("\n");
            asArray(current.childNodes).forEach(visit);
            if (current.tagName === "TD" || current.tagName === "TH") pieces.push("\t");
            if (BLOCK_TAGS.has(current.tagName)) pieces.push("\n");
        }
        visit(node);
        return pieces.join("").replace(/\u00a0/g, " ").replace(/[ \t]+/g, " ")
            .replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    }

    function parseURL(input, base) {
        try { return new URL(input, base); } catch (_) { return null; }
    }
    function trustedURL(url, origin) {
        return url && url.protocol === "https:" && url.origin === origin && !url.username && !url.password && (!url.port || url.port === "443");
    }
    function safeURL(url) {
        var safe = new URL(url.href);
        asArray(safe.searchParams.keys()).forEach(function (key) {
            if (SECRET_NAMES.has(key.toLowerCase())) safe.searchParams.delete(key);
        });
        safe.pathname = safe.pathname.replace(/;(?:jsessionid|sessionid)=[^/;?]*/gi, "");
        safe.hash = "";
        return safe.href;
    }
    function campusSearchURL(url) {
        var safe = new URL(url.href);
        safe.pathname = safe.pathname.replace(/;(?:jsessionid|sessionid)=[^/;?]*/gi, "");
        safe.search = "";
        safe.hash = "";
        safe.searchParams.set("_flowId", "SBW3701300-flow");
        return safe.href;
    }
    function anchorURL(anchor, base, origin) {
        var href = anchor && anchor.getAttribute("href");
        if (!href) return null;
        var url = parseURL(href, base.href);
        return trustedURL(url, origin) ? url : null;
    }
    function rowsOf(table) {
        if (table.rows) return asArray(table.rows);
        return asArray(table.querySelectorAll("tr")).filter(function (row) {
            var parent = row.parentElement;
            while (parent && parent !== table && parent.tagName !== "TABLE") parent = parent.parentElement;
            return parent === table;
        });
    }
    function cellsOf(row) {
        return asArray(row.cells || row.children).filter(function (cell) { return cell.tagName === "TH" || cell.tagName === "TD"; });
    }
    function spanOf(cell, name, remaining) {
        var parsed = Number(cell.getAttribute(name) || 1);
        if (name === "rowspan" && parsed === 0) return remaining;
        return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, 100) : 1;
    }

    // Occupied columns include rowspan cells from earlier rows; subsequent cells never shift left.
    function expandedGrid(table) {
        var rows = rowsOf(table);
        var grid = rows.map(function () { return []; });
        rows.forEach(function (row, rowIndex) {
            var column = 0;
            cellsOf(row).forEach(function (cell) {
                while (grid[rowIndex][column]) column += 1;
                var rowspan = spanOf(cell, "rowspan", rows.length - rowIndex);
                var colspan = spanOf(cell, "colspan", 100);
                for (var r = rowIndex; r < Math.min(rows.length, rowIndex + rowspan); r += 1) {
                    for (var c = column; c < column + colspan; c += 1) {
                        if (!grid[r][c]) grid[r][c] = cell;
                    }
                }
                column += colspan;
            });
        });
        return { rows: rows, grid: grid };
    }
    function courseSourceId(id) { return "manaba:course:" + id; }
    function uniqueSlots(slots) {
        var seen = new Set();
        return slots.filter(function (slot) {
            var key = slot.day + ":" + slot.period;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        }).sort(function (a, b) { return a.day - b.day || a.period - b.period; });
    }

    function captureManabaCourses(document, base) {
        var tables = asArray(document.querySelectorAll("#courselistweekly table.stdlist"));
        var selected = null;
        var daysByColumn = null;
        for (var t = 0; t < tables.length; t += 1) {
            var expanded = expandedGrid(tables[t]);
            if (!expanded.grid.length) continue;
            var days = expanded.grid[0].map(function (cell) { return DAYS[cleanSpace(plainText(cell))] || null; });
            if (days.filter(Boolean).length >= 5) { selected = expanded; daysByColumn = days; break; }
        }
        if (!selected) reject("manabaの曜日別時間割表が見つかりません。ホームの時間割表示で実行してください。");
        var courses = new Map();
        selected.grid.slice(1).forEach(function (row) {
            var period = Number(cleanSpace(plainText(row[0])));
            if (!Number.isInteger(period) || period < 1 || period > 9) return;
            row.forEach(function (cell, column) {
                var day = daysByColumn[column];
                if (!day || !cell || !visibleByAttributes(cell) || !(cell.getAttribute("class") || "").split(/\s+/).includes("course")) return;
                asArray(cell.querySelectorAll("a[href]")).forEach(function (anchor) {
                    var url = anchorURL(anchor, base, MANABA_ORIGIN);
                    var match = url && /^\/ct\/course_(\d+)$/.exec(url.pathname);
                    var title = cleanSpace(plainText(anchor));
                    if (!match || !title) return;
                    var sourceId = courseSourceId(match[1]);
                    if (!courses.has(sourceId)) courses.set(sourceId, { sourceId: sourceId, title: title, slots: [], room: "", campus: "", instructor: "", term: "", url: safeURL(url) });
                    courses.get(sourceId).slots.push({ day: day, period: period });
                });
            });
        });
        return Array.from(courses.values()).map(function (course) { course.slots = uniqueSlots(course.slots); return course; });
    }

    function parseJSTDeadline(text) {
        var cleaned = cleanSpace(text);
        if (!cleaned) return null;
        var match = /^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(cleaned);
        if (!match) return null;
        var year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
        var hour = Number(match[4]), minute = Number(match[5]), second = Number(match[6] || 0);
        if (year < 2000 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return null;
        var calendar = new Date(Date.UTC(year, month - 1, day));
        if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day) return null;
        var two = function (number) { return String(number).padStart(2, "0"); };
        return year + "-" + two(month) + "-" + two(day) + "T" + two(hour) + ":" + two(minute) + ":" + two(second) + "+09:00";
    }
    function captureManabaTasks(document, base) {
        var tables = asArray(document.querySelectorAll("table.stdlist"));
        var selected = null, headerMap = null;
        tables.some(function (table) {
            var rows = rowsOf(table);
            if (!rows.length) return false;
            var headers = cellsOf(rows[0]).map(function (cell) { return cleanSpace(plainText(cell)); });
            var map = { type: headers.indexOf("タイプ"), title: headers.indexOf("タイトル"), course: headers.indexOf("コース"), start: headers.indexOf("受付開始日時"), end: headers.indexOf("受付終了日時") };
            if (Object.keys(map).some(function (key) { return map[key] < 0; })) return false;
            selected = rows;
            headerMap = map;
            return true;
        });
        if (!selected) reject("manabaの課題一覧が見つかりません。「課題」一覧画面で実行してください。");
        var tasks = new Map();
        selected.slice(1).forEach(function (row) {
            var cells = cellsOf(row);
            if (cells.length <= Math.max(headerMap.title, headerMap.course, headerMap.end)) return;
            var taskAnchor = null, taskURL = null, taskMatch = null;
            asArray(cells[headerMap.title].querySelectorAll("a[href]")).some(function (anchor) {
                var url = anchorURL(anchor, base, MANABA_ORIGIN);
                var match = url && /^\/ct\/course_(\d+)_(report|query|survey|quiz|exam|test|examination|drill)_(\d+)$/.exec(url.pathname);
                if (!match) return false;
                taskAnchor = anchor; taskURL = url; taskMatch = match;
                return true;
            });
            if (!taskAnchor) return;
            var courseTitle = "", sourceCourseId = courseSourceId(taskMatch[1]), mismatchedCourse = false;
            asArray(cells[headerMap.course].querySelectorAll("a[href]")).some(function (anchor) {
                var url = anchorURL(anchor, base, MANABA_ORIGIN);
                var match = url && /^\/ct\/course_(\d+)$/.exec(url.pathname);
                if (!match) return false;
                if (match[1] !== taskMatch[1]) { mismatchedCourse = true; return true; }
                courseTitle = cleanSpace(plainText(anchor));
                return true;
            });
            var title = cleanSpace(plainText(taskAnchor));
            if (!title || mismatchedCourse) return;
            if (!courseTitle) courseTitle = cleanSpace(plainText(cells[headerMap.course]));
            var sourceId = "manaba:task:" + taskMatch[1] + ":" + taskMatch[2] + ":" + taskMatch[3];
            tasks.set(sourceId, { sourceId: sourceId, title: title, sourceCourseId: sourceCourseId, courseTitle: courseTitle,
                dueAt: parseJSTDeadline(plainText(cells[headerMap.end])), url: safeURL(taskURL) });
        });
        return Array.from(tasks.values());
    }

    function japanesePart(value) { return cleanSpace(String(value || "").split("／")[0]); }
    function syllabusSlots(value) {
        var slots = [], regex = /([月火水木金土日])(?:曜(?:日)?)?(?:\s*[／/]\s*[A-Za-z]+)?\s*([1-9](?:\s*[・、,/]\s*[1-9])*)(?!\d)(?:\s*(?:時限|限))?/g, match;
        while ((match = regex.exec(value || ""))) {
            match[2].split(/[・、,\/]/).forEach(function (period) { slots.push({ day: DAYS[match[1]], period: Number(period.trim()) }); });
        }
        return uniqueSlots(slots);
    }
    function outerSyllabusText(article) {
        var tables = asArray(article.querySelectorAll("table")).filter(function (table) {
            var parent = table.parentElement;
            while (parent && parent !== article) {
                if (parent.tagName === "TABLE") return false;
                parent = parent.parentElement;
            }
            return parent === article;
        });
        var sections = [], seen = new Set();
        tables.forEach(function (table) {
            rowsOf(table).forEach(function (row) {
                var section = plainText(row);
                if (section && !seen.has(section)) { seen.add(section); sections.push(section); }
            });
        });
        return sections.join("\n\n").slice(0, 100_000);
    }
    function captureCampusSyllabus(document, base) {
        var article = document.querySelector("article#main-func-body, article.main-func-body") || document.querySelector("#main-func-body article");
        if (!article) reject("CampusSquareのシラバス詳細画面を開いてから実行してください。");
        var metadataTables = asArray(article.querySelectorAll("table.syllabus-normal"));
        var fields = new Map();
        metadataTables.forEach(function (table) {
            rowsOf(table).forEach(function (row) {
                var cells = cellsOf(row);
                if (cells.length !== 2) return;
                var key = japanesePart(plainText(cells[0])).replace(/\s/g, "");
                var value = plainText(cells[1]);
                if (key && value && !fields.has(key)) fields.set(key, value);
            });
        });
        var title = japanesePart(fields.get("開講科目名"));
        var courseCode = japanesePart(fields.get("時間割コード"));
        if (!title || !courseCode) reject("シラバスの科目名と時間割コードを確認できませんでした。詳細画面で実行してください。");
        var termValue = fields.get("ターム・学期") || "";
        var yearMatch = /(20\d{2})\s*年度/.exec(termValue);
        var year = yearMatch ? Number(yearMatch[1]) : null;
        var terms = termValue.match(/(?:春|秋|前|後|夏|冬)学期|(?:第\s*)?[1-4１２３４一二三四]\s*(?:ターム|学期)|通年|前期|後期/g) || [];
        var term = Array.from(new Set(terms)).join("・");
        var instructor = japanesePart(fields.get("主担当教員"));
        var roomValue = japanesePart(fields.get("教室"));
        var campus = "", room = roomValue;
        var roomMatch = /^[（(]([^()（）]+)[）)]\s*(.*)$/.exec(roomValue);
        if (roomMatch) { campus = cleanSpace(roomMatch[1]); room = cleanSpace(roomMatch[2]); }
        var slots = syllabusSlots(fields.get("曜限") || "");
        var bodyText = outerSyllabusText(article);
        if (!bodyText) reject("シラバス本文が見つかりません。詳細画面を読み込んでから実行してください。");
        var reference = campusSearchURL(base);
        return { sourceId: "campusSquare:syllabus:" + (year || "unknown") + ":" + courseCode,
            title: title, courseCode: courseCode, year: year, term: term, room: room, campus: campus,
            instructor: instructor, slots: slots, bodyText: bodyText, url: reference };
    }

    function capturePage(document, location) {
        var base = parseURL(typeof location === "string" ? location : location && location.href);
        var manaba = trustedURL(base, MANABA_ORIGIN);
        var campus = trustedURL(base, CAMPUS_ORIGIN) && (base.pathname === "/campusweb" || base.pathname.indexOf("/campusweb/") === 0);
        if (!manaba && !campus) reject("中央大学のmanabaまたはCampusSquareの公式ページで実行してください。");
        if (document.querySelector('input[type="password"]')) reject("ログイン画面は取り込めません。ログイン後に対象画面を開いてください。");
        var payload = { kind: "chuo-pocket-capture", schemaVersion: 1, source: manaba ? "manaba" : "campusSquare",
            sourceURL: manaba ? safeURL(base) : campusSearchURL(base), capturedAt: new Date().toISOString(), courses: [], tasks: [], pages: [] };
        if (manaba) {
            if (/^\/(?:ct(?:\/home)?\/?)?$/.test(base.pathname)) payload.courses = captureManabaCourses(document, base);
            else if (/^\/ct\/home_library_query\/?$/.test(base.pathname)) { payload.tasks = captureManabaTasks(document, base); payload.emptyTasks = payload.tasks.length === 0; }
            else reject("このmanaba画面には対応していません。ホームの曜日別時間割か「課題」一覧で実行してください。");
        } else {
            payload.pages = [captureCampusSyllabus(document, base)];
        }
        return payload;
    }

    return { capturePage: capturePage };
})();

if (typeof module === "object" && module.exports) module.exports = ChuoCaptureCore;

try {
  completion(JSON.stringify(ChuoCaptureCore.capturePage(document, location)));
} catch (error) {
  completion(JSON.stringify({error: error && error.name === "ChuoCaptureError" ? error.message : "ページを読み取れませんでした。時間割・課題一覧・シラバス詳細で再実行してください。"}));
}
