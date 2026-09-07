/* ============================================================
 *  課表查詢系統 — 應用程式邏輯
 *  資料來源：Google Apps Script JSON API，讀不到時退回本地 CSV
 * ============================================================ */
(function () {
'use strict';

/* ── 小工具 ───────────────────────────────────────────────── */
var $  = function (s, r) { return (r || document).querySelector(s); };
var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function attr(s) { return esc(s); }

var DAY_NAMES = ['', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六', '星期日'];
var DAY_SHORT = ['', '一', '二', '三', '四', '五', '六', '日'];

/* ── 全域資料 ─────────────────────────────────────────────── */
var DB  = null;
var IDX = null;
var LAST_HOME_TAB = 'class';

/* ═══════════════════════════════════════════════════════════
   1. 載入資料
═══════════════════════════════════════════════════════════ */
function cacheKey(sem) { return 'tt-cache:' + (CONFIG.API_URL || 'local') + ':' + (sem || ''); }

function readCache(sem) {
  var mins = CONFIG.CACHE_MINUTES || 0;
  if (!mins) return null;
  try {
    var raw = sessionStorage.getItem(cacheKey(sem));
    if (!raw) return null;
    var o = JSON.parse(raw);
    if (Date.now() - o.t > mins * 60000) return null;
    return o.d;
  } catch (e) { return null; }
}
function writeCache(sem, data) {
  if (!CONFIG.CACHE_MINUTES) return;
  try { sessionStorage.setItem(cacheKey(sem), JSON.stringify({ t: Date.now(), d: data })); }
  catch (e) { /* 隱私模式或空間不足，忽略 */ }
}

function jsonp(url) {
  return new Promise(function (resolve, reject) {
    var cb = 'ttcb_' + Math.random().toString(36).slice(2);
    var s = document.createElement('script');
    var timer = setTimeout(function () { cleanup(); reject(new Error('連線逾時')); }, 15000);
    function cleanup() {
      clearTimeout(timer);
      delete window[cb];
      if (s.parentNode) s.parentNode.removeChild(s);
    }
    window[cb] = function (data) { cleanup(); resolve(data); };
    s.onerror = function () { cleanup(); reject(new Error('無法連線至資料來源')); };
    s.src = url + (url.indexOf('?') < 0 ? '?' : '&') + 'callback=' + cb;
    document.head.appendChild(s);
  });
}

function fetchFromApi(sem) {
  var url = CONFIG.API_URL + (CONFIG.API_URL.indexOf('?') < 0 ? '?' : '&') +
            'semester=' + encodeURIComponent(sem || '');
  if (CONFIG.USE_JSONP) return jsonp(url);
  return fetch(url, { redirect: 'follow' }).then(function (r) {
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  });
}

/* CSV 解析（支援引號、逗號、換行）*/
function parseCSV(text) {
  text = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  var rows = [], row = [], cur = '', inQ = false;
  for (var i = 0; i < text.length; i++) {
    var c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else inQ = false; }
      else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
    else cur += c;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows.filter(function (r) { return r.some(function (v) { return String(v).trim() !== ''; }); });
}

function fetchFromCsv() {
  var f = CONFIG.FALLBACK || {};
  var pl = fetch(f.lessons).then(function (r) {
    if (!r.ok) throw new Error('讀不到課表檔 ' + f.lessons);
    return r.text();
  });
  var ph = f.homerooms
    ? fetch(f.homerooms).then(function (r) { return r.ok ? r.text() : ''; }).catch(function () { return ''; })
    : Promise.resolve('');
  var pt = f.teachers
    ? fetch(f.teachers).then(function (r) { return r.ok ? r.text() : ''; }).catch(function () { return ''; })
    : Promise.resolve('');

  return Promise.all([pl, ph, pt]).then(function (res) {
    var rows = parseCSV(res[0]).slice(1);
    var lessons = [];
    rows.forEach(function (r) {
      var cls = String(r[0] || '').trim();
      var d = parseInt(r[1], 10), p = parseInt(r[2], 10);
      var subj = String(r[3] || '').trim();
      if (!cls || !subj || isNaN(d) || isNaN(p)) return;
      lessons.push([cls, d, p, subj, String(r[4] || '').trim(),
                    String(r[5] || '').trim(), String(r[6] || '').trim()]);
    });
    var hm = {};
    if (res[1]) parseCSV(res[1]).slice(1).forEach(function (r) {
      if (r[0]) hm[String(r[0]).trim()] = String(r[1] || '').trim();
    });
    var tt = {};
    if (res[2]) parseCSV(res[2]).slice(1).forEach(function (r) {
      if (r[0]) tt[String(r[0]).trim()] = String(r[1] || '').trim();
    });
    return {
      ok: true,
      school: { '學校名稱': CONFIG.SCHOOL_NAME, '副標題': CONFIG.SCHOOL_SUBTITLE },
      periods: CONFIG.PERIODS,
      semesters: [{ code: 'local', name: '本機資料' }],
      current: { code: 'local', name: '本機資料' },
      homerooms: hm,
      teacherTitles: tt,
      lessons: lessons,
      updatedAt: ''
    };
  });
}

function loadData(sem) {
  var cached = readCache(sem);
  if (cached) return Promise.resolve(cached);

  var p = CONFIG.API_URL ? fetchFromApi(sem) : Promise.reject(new Error('未設定 API'));

  return p.then(function (d) {
    if (!d || d.ok === false) throw new Error((d && d.error) || '資料來源回應異常');
    if (!d.lessons || !d.lessons.length) throw new Error('課表沒有資料');
    writeCache(sem, d);
    return d;
  }).catch(function (err) {
    if (CONFIG.API_URL) console.warn('API 讀取失敗，改用本地備援檔：', err.message);
    return fetchFromCsv().then(function (d) {
      d.fallbackReason = CONFIG.API_URL ? err.message : '';
      return d;
    });
  });
}

/* ═══════════════════════════════════════════════════════════
   2. 建索引
═══════════════════════════════════════════════════════════ */
function buildIndex(db) {
  var ix = {
    classes: [], teachers: [], rooms: [], subjects: [],
    byClass: {}, byTeacher: {}, byRoom: {},
    subjectTeachers: {}, teacherLoad: {}, roomClasses: {},
    days: [], periods: [], specialRooms: {}
  };
  var setC = {}, setT = {}, setR = {}, setS = {}, setD = {}, setP = {};

  db.lessons.forEach(function (L) {
    var cls = L[0], d = L[1], p = L[2], subj = L[3], t = L[4], room = L[5];
    var key = d + '-' + p;
    setC[cls] = 1; setD[d] = 1; setP[p] = 1;
    if (subj) setS[subj] = 1;

    (ix.byClass[cls] = ix.byClass[cls] || {});
    (ix.byClass[cls][key] = ix.byClass[cls][key] || []).push(L);

    if (t) {
      setT[t] = 1;
      (ix.byTeacher[t] = ix.byTeacher[t] || {});
      (ix.byTeacher[t][key] = ix.byTeacher[t][key] || []).push(L);
      (ix.subjectTeachers[subj] = ix.subjectTeachers[subj] || {})[t] = 1;
      if ((CONFIG.LIGHT_SUBJECTS || []).indexOf(subj) < 0) {
        ix.teacherLoad[t] = (ix.teacherLoad[t] || 0) + 1;
      }
    }
    if (room) {
      setR[room] = 1;
      (ix.byRoom[room] = ix.byRoom[room] || {});
      (ix.byRoom[room][key] = ix.byRoom[room][key] || []).push(L);
      (ix.roomClasses[room] = ix.roomClasses[room] || {})[cls] = 1;
    }
  });

  ix.classes  = Object.keys(setC).sort(cmpClass);
  // 真正的班級＝有導師，或符合年級規則的；其餘（分組課、校內活動、教室借用）
  // 只用來判斷老師與教室有沒有被佔用，不出現在班級清單裡
  ix.realClasses = ix.classes.filter(function (c) {
    if (isPseudoClass(c)) return false;
    return !!(db.homerooms && db.homerooms[c]) || !!gradeOf(c);
  });
  ix.teachers = Object.keys(setT).sort(cmpZh);
  ix.subjects = Object.keys(setS).sort(cmpZh);
  ix.days     = Object.keys(setD).map(Number).sort(function (a, b) { return a - b; });
  ix.periods  = Object.keys(setP).map(Number).sort(function (a, b) { return a - b; });
  if (!ix.days.length) ix.days = [1, 2, 3, 4, 5];

  // 場地：設定檔有指定就照指定；否則除了「某班自己的教室」以外全都算場地
  // （課後照顧、社團、活動借用都要查得到，不能只留被多班共用的）
  var listed = CONFIG.SPECIAL_ROOMS || [];
  Object.keys(setR).forEach(function (r) {
    if (listed.length) { ix.specialRooms[r] = listed.indexOf(r) >= 0; return; }
    var users = Object.keys(ix.roomClasses[r] || {});
    var ownRoomOf = users.filter(function (c) { return r === c || r === c + '教室'; });
    ix.specialRooms[r] = !(ownRoomOf.length && users.length === 1);
  });
  ix.rooms = Object.keys(setR).filter(function (r) { return ix.specialRooms[r]; }).sort(cmpZh);

  Object.keys(ix.subjectTeachers).forEach(function (s) {
    ix.subjectTeachers[s] = Object.keys(ix.subjectTeachers[s]).sort(cmpZh);
  });
  return ix;
}

function cmpZh(a, b) { return String(a).localeCompare(String(b), 'zh-Hant'); }

/** 把班級名稱轉成可排序的鍵：一年甲班 → [1, 1]，401 → [4, 1]，其他 → [99, 0] */
function classKey(cls) {
  var go = CONFIG.GRADE_ORDER || '一二三四五六七八九';
  var co = CONFIG.CLASS_ORDER || '甲乙丙丁戊己庚辛壬癸';
  var m = /^(.)年(.)班$/.exec(cls);
  if (m) {
    var g = go.indexOf(m[1]);
    var c = co.indexOf(m[2]);
    if (g >= 0) return [g + 1, c >= 0 ? c + 1 : 50];
  }
  if (/^\d{3}$/.test(cls)) return [parseInt(cls[0], 10), parseInt(cls.slice(1), 10)];
  return [99, 0];
}
function cmpClass(a, b) {
  var ka = classKey(a), kb = classKey(b);
  if (ka[0] !== kb[0]) return ka[0] - kb[0];
  if (ka[1] !== kb[1]) return ka[1] - kb[1];
  return cmpZh(a, b);
}
function titleOf(name) {
  return (DB && DB.teacherTitles && DB.teacherTitles[name]) || '';
}
function isPseudoClass(cls) {
  return !!(CONFIG.PSEUDO_CLASS && CONFIG.PSEUDO_CLASS.test(cls));
}

function gradeOf(cls) {
  var gs = CONFIG.GRADES || [];
  for (var i = 0; i < gs.length; i++) if (gs[i].test.test(cls)) return gs[i];
  return null;
}
function periodInfo(p) {
  var list = (DB && DB.periods && DB.periods.length) ? DB.periods : CONFIG.PERIODS;
  for (var i = 0; i < list.length; i++) if (Number(list[i].p) === Number(p)) return list[i];
  return { p: p, name: '第' + p + '節', start: '', end: '' };
}
function isHomeRoom(cls, room) {
  return !room || room === cls || room === cls + '教室' || !IDX.specialRooms[room];
}

/* ═══════════════════════════════════════════════════════════
   3. 「現在是第幾節」
═══════════════════════════════════════════════════════════ */
function toMin(hhmm) {
  var m = /^(\d{1,2}):(\d{2})/.exec(String(hhmm || ''));
  return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : null;
}
function nowSlot() {
  var now = new Date();
  var day = now.getDay();                       // 0=日 … 6=六
  if (day < 1 || day > 5) return { day: day, period: null, state: 'weekend' };
  var mins = now.getHours() * 60 + now.getMinutes();
  var list = (DB && DB.periods && DB.periods.length) ? DB.periods : CONFIG.PERIODS;
  var next = null;
  for (var i = 0; i < list.length; i++) {
    var s = toMin(list[i].start), e = toMin(list[i].end);
    if (s == null || e == null) continue;
    if (mins >= s && mins < e) return { day: day, period: Number(list[i].p), state: 'in', info: list[i] };
    if (mins < s && (!next || s < toMin(next.start))) next = list[i];
  }
  return { day: day, period: null, state: next ? 'break' : 'after', next: next };
}

function renderNowBar() {
  var box = $('#nowBarText');
  var n = nowSlot();
  var d = new Date();
  var date = (d.getMonth() + 1) + '月' + d.getDate() + '日';
  var html;
  if (n.state === 'weekend') {
    html = date + '（' + DAY_NAMES[d.getDay() === 0 ? 7 : d.getDay()] + '）今天沒有排課';
  } else if (n.state === 'in') {
    html = date + '（' + DAY_NAMES[n.day] + '）現在是 <b>' + esc(n.info.name) + '</b> ' +
           esc(n.info.start) + '–' + esc(n.info.end) +
           ' ｜ <a href="#/all/' + n.day + '">看全校這天的課 →</a>';
  } else if (n.state === 'break' && n.next) {
    html = date + '（' + DAY_NAMES[n.day] + '）下一節是 <b>' + esc(n.next.name) + '</b> ' +
           esc(n.next.start) + '起 ｜ <a href="#/all/' + n.day + '">看全校這天的課 →</a>';
  } else {
    html = date + '（' + DAY_NAMES[n.day] + '）今天課程已結束 ｜ <a href="#/all/' + n.day + '">看全校這天的課 →</a>';
  }
  box.innerHTML = html;
}

/* ═══════════════════════════════════════════════════════════
   4. 課表表格
═══════════════════════════════════════════════════════════ */
/**
 * rows：要顯示的節次陣列
 * cellFn(day, period) → { html, empty }
 */
function visiblePeriods(cellFn) {
  var core = CONFIG.CORE_PERIODS || [];
  var used = {};
  IDX.periods.forEach(function (p) {
    if (core.indexOf(p) >= 0) { used[p] = 1; return; }
    for (var i = 0; i < IDX.days.length; i++) {
      var c = cellFn(IDX.days[i], p);
      if (c && c.html) { used[p] = 1; return; }
    }
  });
  return IDX.periods.filter(function (p) { return used[p]; });
}

function renderGrid(cellFn, opts) {
  opts = opts || {};
  var days = IDX.days, periods = visiblePeriods(cellFn);
  var n = nowSlot();
  var highlight = opts.highlightNow !== false;

  var h = '<div class="table-scroll"><table class="tt"><thead><tr>' +
          '<th class="col-p">節次</th>';
  days.forEach(function (d) {
    h += '<th>' + DAY_NAMES[d] + '</th>';
  });
  h += '</tr></thead><tbody>';

  periods.forEach(function (p) {
    var pi = periodInfo(p);
    var isNowRow = highlight && n.state === 'in' && n.period === p;
    h += '<tr class="' + (isNowRow ? 'now' : '') + '">' +
         '<td class="p-head"><div class="p-name">' + esc(pi.name) + '</div>';
    if (pi.start) h += '<div class="p-time">' + esc(pi.start) + '<br>' + esc(pi.end) + '</div>';
    h += '</td>';
    days.forEach(function (d) {
      var c = cellFn(d, p) || {};
      var cls = 'cell' + (c.html ? '' : ' empty') +
                (isNowRow && n.day === d && c.html ? ' now-cell' : '');
      h += '<td class="' + cls + '">' + (c.html || '') + '</td>';
    });
    h += '</tr>';
  });
  return h + '</tbody></table></div>';
}

function linkBtn(kind, value, text) {
  return '<button class="c-link" type="button" data-go="' + attr(kind) + '" data-val="' +
         attr(value) + '">' + esc(text || value) + '</button>';
}

/* ═══════════════════════════════════════════════════════════
   5. 各種檢視
═══════════════════════════════════════════════════════════ */
function showResult(title, subHtml, bodyHtml) {
  $('#viewHome').hidden = true;
  $('#viewResult').hidden = false;
  $('#resultTitle').innerHTML = title;
  $('#resultSub').innerHTML = subHtml || '';
  $('#resultBody').innerHTML = bodyHtml;
  $('.print-foot').setAttribute('data-foot',
    (DB.school['學校名稱'] || CONFIG.SCHOOL_NAME) + '　' +
    (DB.current ? DB.current.name : '') + '　列印於 ' + new Date().toLocaleString('zh-TW'));
  document.title = String(title).replace(/<[^>]+>/g, '') + ' — ' + (DB.school['學校名稱'] || CONFIG.SCHOOL_NAME);
  window.scrollTo(0, 0);
}

function showHome() {
  $('#viewResult').hidden = true;
  $('#viewHome').hidden = false;
  document.title = (DB ? (DB.school['學校名稱'] || CONFIG.SCHOOL_NAME) : CONFIG.SCHOOL_NAME) + ' 課表查詢';
  window.scrollTo(0, 0);
}

/* ── 班級課表 ─────────────────────────────────────────────── */
function viewClass(cls) {
  var map = IDX.byClass[cls];
  if (!map) return showNotFound('找不到班級「' + cls + '」');
  var hm = DB.homerooms[cls];
  var g = gradeOf(cls);

  var body = renderGrid(function (d, p) {
    var arr = map[d + '-' + p];
    if (!arr) return {};
    var h = '';
    arr.forEach(function (L) {
      h += '<div class="c-subject">' + esc(L[3]) + '</div>';
      if (L[4]) h += '<div class="c-line">' + linkBtn('teacher', L[4]) + '</div>';
      if (!isHomeRoom(cls, L[5])) h += '<div class="c-room">' + esc(L[5]) + '</div>';
      if (L[6] && /待補|待確認/.test(L[6])) h += '<div class="c-note">' + esc(L[6]) + '</div>';
    });
    return { html: h };
  });

  var count = Object.keys(map).length;
  var sub = '<span class="pill">' + esc(g ? g.label : CONFIG.OTHER_GRADE_LABEL) + '</span>' +
            (hm ? '<span class="pill">導師：' + esc(hm) + '</span>' : '') +
            '<span class="pill">每週 ' + count + ' 節</span>';
  showResult(esc(cls) + ' 班課表', sub, body);
}

/* ── 教師課表 ─────────────────────────────────────────────── */
function viewTeacher(name) {
  var map = IDX.byTeacher[name];
  if (!map) return showNotFound('找不到教師「' + name + '」');

  var body = renderGrid(function (d, p) {
    var arr = map[d + '-' + p];
    if (!arr) return {};
    var h = '';
    var bySubj = {};
    arr.forEach(function (L) { (bySubj[L[3]] = bySubj[L[3]] || []).push(L); });
    Object.keys(bySubj).forEach(function (subj) {
      h += '<div class="c-subject">' + esc(subj) + '</div><div class="c-line">';
      bySubj[subj].forEach(function (L) { h += linkBtn('class', L[0]); });
      h += '</div>';
      var rooms = {};
      bySubj[subj].forEach(function (L) { if (!isHomeRoom(L[0], L[5])) rooms[L[5]] = 1; });
      var rk = Object.keys(rooms);
      if (rk.length) h += '<div class="c-room">' + esc(rk.join('、')) + '</div>';
    });
    return { html: h };
  });

  var homeroomOf = Object.keys(DB.homerooms).filter(function (c) { return DB.homerooms[c] === name; });
  var subjects = {};
  Object.keys(map).forEach(function (k) { map[k].forEach(function (L) { subjects[L[3]] = 1; }); });

  var ttl = titleOf(name);
  var sub = (ttl ? '<span class="pill">' + esc(ttl) + '</span>' : '') +
            (homeroomOf.length ? '<span class="pill">' + esc(homeroomOf.join('、')) + ' 導師</span>' : '') +
            '<span class="pill">每週 ' + Object.keys(map).reduce(function (s, k) { return s + map[k].length; }, 0) + ' 節</span>' +
            '<span class="pill">' + esc(Object.keys(subjects).sort(cmpZh).join('、')) + '</span>';
  showResult(esc(name) + ' 老師課表', sub, body);
}

/* ── 專科教室使用表 ───────────────────────────────────────── */
function viewRoom(room) {
  var map = IDX.byRoom[room];
  if (!map) return showNotFound('找不到教室「' + room + '」');

  var used = 0;
  var body = renderGrid(function (d, p) {
    var arr = map[d + '-' + p];
    if (!arr) return {};
    used += arr.length;
    var h = '';
    arr.forEach(function (L) {
      var who = isPseudoClass(L[0]) || !IDX.byClass[L[0]]
        ? '<span class="c-subject">' + esc(L[0]) + '</span>'
        : '<div class="c-subject">' + linkBtn('class', L[0]) + '</div>';
      h += who + '<div class="c-room">' + esc(L[3]) +
           (L[4] ? ' · ' + esc(L[4]) : '') + '</div>';
    });
    return { html: h };
  });

  var total = IDX.days.length * IDX.periods.length;
  var sub = '<span class="pill">已排 ' + used + ' 節</span>' +
            '<span class="pill">空堂 ' + (total - Object.keys(map).length) + ' 節</span>' +
            '<span class="pill">共 ' + Object.keys(IDX.roomClasses[room] || {}).length + ' 班使用</span>';
  showResult(esc(room) + ' 使用情形', sub,
    '<div class="notice no-print">斜線格＝該節沒有排課也沒有借用，可以安排活動。' +
    '課後照顧、社團等非正課的佔用也已列入。</div>' + body);
}

/* ── 代課查詢 ─────────────────────────────────────────────── */
function viewSub(day, period) {
  day = Number(day); period = Number(period);
  var pi = periodInfo(period);
  var busy = {}, teaching = [];

  DB.lessons.forEach(function (L) {
    if (L[1] !== day || L[2] !== period || !L[4]) return;
    busy[L[4]] = 1;
    teaching.push(L);
  });

  var free = IDX.teachers.filter(function (t) { return !busy[t]; });

  // 該老師當天已上幾節（負擔參考）
  var dayLoad = {};
  DB.lessons.forEach(function (L) {
    if (L[1] !== day || !L[4]) return;
    if ((CONFIG.LIGHT_SUBJECTS || []).indexOf(L[3]) >= 0) return;
    dayLoad[L[4]] = (dayLoad[L[4]] || 0) + 1;
  });

  teaching.sort(function (a, b) { return cmpClass(a[0], b[0]); });
  free.sort(function (a, b) {
    var da = dayLoad[a] || 0, db = dayLoad[b] || 0;
    return da !== db ? da - db : cmpZh(a, b);
  });

  var freeHtml = free.length
    ? '<ul class="list">' + free.map(function (t) {
        var hm = Object.keys(DB.homerooms).filter(function (c) { return DB.homerooms[c] === t; });
        var note = hm.length ? hm.join('、') + ' 導師' : titleOf(t);
        return '<li><span class="who free">' + linkBtn('teacher', t) + '</span>' +
               (note ? '<span class="what">' + esc(note) + '</span>' : '') +
               '<span class="load">當天 ' + (dayLoad[t] || 0) + ' 節</span></li>';
      }).join('') + '</ul>'
    : '<p class="list-empty">這個時段全校老師都有課。</p>';

  var busyHtml = teaching.length
    ? '<ul class="list">' + teaching.map(function (L) {
        return '<li><span class="who">' + linkBtn('class', L[0]) + '</span>' +
               '<span class="what">' + esc(L[3]) + ' · ' + linkBtn('teacher', L[4]) + '</span>' +
               (isHomeRoom(L[0], L[5]) ? '' : '<span class="load">' + esc(L[5]) + '</span>') +
               '</li>';
      }).join('') + '</ul>'
    : '<p class="list-empty">這個時段沒有排課。</p>';

  var body =
    '<div class="notice">「可代課」＝該節沒有排課的老師，依當天授課節數由少到多排序，' +
    '排代課時優先找上面的人。實際仍需徵詢意願並經教務處排定。</div>' +
    '<div class="two-col">' +
      '<div class="card"><h3>可代課教師 <span class="n">' + free.length + ' 人</span></h3>' + freeHtml + '</div>' +
      '<div class="card"><h3>該節有課 <span class="n">' + teaching.length + ' 班</span></h3>' + busyHtml + '</div>' +
    '</div>';

  showResult('代課查詢：' + DAY_NAMES[day] + ' ' + esc(pi.name),
    '<span class="pill">' + esc(pi.start ? pi.start + '–' + pi.end : '') + '</span>' +
    '<span class="pill">全校教師 ' + IDX.teachers.length + ' 人</span>', body);
}

/* ── 全校總覽 ─────────────────────────────────────────────── */
function viewAll(day) {
  day = Number(day);
  var core = CONFIG.CORE_PERIODS || [];
  var periods = IDX.periods.filter(function (p) {
    if (core.indexOf(p) >= 0) return true;
    return IDX.realClasses.some(function (cls) {
      return (IDX.byClass[cls] || {})[day + '-' + p];
    });
  });
  var n = nowSlot();

  var h = '<div class="table-scroll"><table class="tt wide"><thead><tr><th class="col-p">班級</th>';
  periods.forEach(function (p) {
    var pi = periodInfo(p);
    var on = (n.state === 'in' && n.day === day && n.period === p);
    h += '<th>' + esc(pi.name) + (on ? '<span class="now-tag">現在</span>' : '') +
         (pi.start ? '<div class="p-time">' + esc(pi.start) + '</div>' : '') + '</th>';
  });
  h += '</tr></thead><tbody>';

  IDX.realClasses.forEach(function (cls) {
    var map = IDX.byClass[cls] || {};
    h += '<tr><td class="row-head">' + linkBtn('class', cls) + '</td>';
    periods.forEach(function (p) {
      var arr = map[day + '-' + p];
      if (!arr) { h += '<td class="cell empty"></td>'; return; }
      var inner = arr.map(function (L) {
        return '<div class="c-subject">' + esc(L[3]) + '</div>' +
               (L[4] ? '<div class="c-room">' + esc(L[4]) + '</div>' : '');
      }).join('');
      h += '<td class="cell">' + inner + '</td>';
    });
    h += '</tr>';
  });
  h += '</tbody></table></div>';

  showResult(DAY_NAMES[day] + ' 全校課表總覽',
    '<span class="pill">' + IDX.realClasses.length + ' 班</span>' +
    '<span class="pill">點班級可看該班完整週課表</span>', h);
}

function showNotFound(msg) {
  showResult('查無資料', '', '<div class="notice">' + esc(msg) +
    '，可能是課表已更新或連結有誤。<a href="#/">回查詢首頁</a></div>');
}


/* ═══════════════════════════════════════════════════════════
   系統檢查（#/check）
   把「讀不到資料」拆成幾個可以分別確認的步驟，
   直接告訴使用者卡在哪一關、該怎麼改。
═══════════════════════════════════════════════════════════ */
function chkRow(state, title, detail) {
  var icon = { ok: '✅', warn: '⚠️', bad: '❌', info: 'ℹ️' }[state] || '·';
  return '<li class="chk chk-' + state + '"><span class="chk-icon">' + icon + '</span>' +
         '<div><div class="chk-title">' + title + '</div>' +
         (detail ? '<div class="chk-detail">' + detail + '</div>' : '') + '</div></li>';
}

function viewCheck() {
  showResult('系統檢查', '<span class="pill">確認資料來源接得起來</span>',
    '<div class="notice">正在測試⋯</div>');

  var out = [];
  var url = CONFIG.API_URL || '';

  function render(extra) {
    $('#resultBody').innerHTML =
      '<div class="card"><h3>檢查結果</h3><ul class="chk-list">' +
      out.join('') + '</ul></div>' + (extra || '');
  }

  // 1. 目前資料狀態
  if (DB && DB.current && DB.current.code === 'local') {
    out.push(chkRow('info', '目前讀取網站內建的課表檔',
      '課表 ' + DB.lessons.length + ' 筆，資料是正確的，只是「靜態」的——' +
      '改課表得重新上傳檔案。接上 Apps Script 之後，改試算表就會即時反映。'));
  } else if (DB && DB.fallbackReason) {
    out.push(chkRow('bad', '線上資料讀取失敗，已退回備援檔',
      esc(DB.fallbackReason)));
  } else if (DB) {
    out.push(chkRow('ok', '正在使用線上資料',
      '課表 ' + DB.lessons.length + ' 筆' +
      (DB.updatedAt ? '，資料更新於 ' + esc(DB.updatedAt) : '')));
  }

  // 2. 設定檔
  if (!url) {
    out.push(chkRow('warn', 'config.js 的 API_URL 還沒填',
      '部署好 Apps Script 後，把結尾是 <code>/exec</code> 的網址貼進去。' +
      '沒填也能用，只是課表改了要重新上傳檔案。'));
    render('<div class="notice no-print">目前這樣就能正常查詢，只是資料是靜態的。</div>');
    return;
  }
  if (!/\/exec\s*$/.test(url)) {
    out.push(chkRow('warn', 'API_URL 結尾不是 /exec',
      '目前填的是 <code>' + esc(url) + '</code>。' +
      '如果結尾是 <code>/dev</code>，那是測試網址，只有你自己登入時能用。'));
  } else {
    out.push(chkRow('ok', 'API_URL 格式正確', esc(url)));
  }
  render();

  // 3. 實際連一次
  var started = Date.now();
  fetch(url + (url.indexOf('?') < 0 ? '?' : '&') + 'action=ping&nocache=1', { redirect: 'follow' })
    .then(function (r) {
      return r.text().then(function (body) { return { r: r, body: body }; });
    })
    .then(function (o) {
      var ms = Date.now() - started;
      var body = o.body || '';
      if (!o.r.ok) {
        out.push(chkRow('bad', '連得到，但回應 HTTP ' + o.r.status,
          '多半是部署網址貼錯，或該部署已被刪除。回 Apps Script 重新部署一次。'));
        render(); return;
      }
      if (/<html/i.test(body) || /accounts\.google\.com/.test(body)) {
        out.push(chkRow('bad', '回傳的是 Google 登入頁，不是資料',
          '部署時「誰可以存取」沒有選<b>「任何人」</b>。<br>' +
          '回 Apps Script ▸ 部署 ▸ 管理部署作業 ▸ 鉛筆圖示 ▸ 把存取權改成「任何人」▸ 部署。'));
        render(); return;
      }
      var data = null;
      try { data = JSON.parse(body); } catch (e) {}
      if (!data) {
        out.push(chkRow('bad', '回應不是 JSON', '前 200 字：<code>' + esc(body.slice(0, 200)) + '</code>'));
        render(); return;
      }
      out.push(chkRow('ok', '連線成功（' + ms + ' ms）', 'Apps Script 有回應，權限設定正確。'));
      render();
      return fetch(url + (url.indexOf('?') < 0 ? '?' : '&') + 'nocache=1', { redirect: 'follow' })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          if (d.ok === false) {
            out.push(chkRow('bad', '後端回報錯誤', esc(d.error || '')));
            render(); return;
          }
          var n = (d.lessons || []).length;
          if (!n) {
            out.push(chkRow('bad', '連得到但課表是空的',
              '確認「學期」分頁的「課表工作表」欄，填的分頁名稱跟實際分頁一致。'));
          } else {
            out.push(chkRow('ok', '讀到課表 ' + n + ' 筆',
              '班級 ' + Object.keys(d.homerooms || {}).length + ' 班' +
              '、學期 ' + (d.semesters || []).length + ' 個' +
              '、節次 ' + (d.periods || []).length + ' 節'));
            if (!(d.periods || []).length) {
              out.push(chkRow('warn', '沒有讀到「節次」分頁',
                '會改用 config.js 內建的時間表。想讓教務處自己調作息，請補上這個分頁。'));
            }
            if (!Object.keys(d.teacherTitles || {}).length) {
              out.push(chkRow('warn', '沒有讀到「教師」分頁',
                '代課查詢就不會顯示職稱。分頁欄位是「教師／職稱」。'));
            }
          }
          render('<div class="notice no-print">全部綠燈的話，把瀏覽器重新整理一次' +
                 '（<b>Ctrl + F5</b>）就會改用線上資料。</div>');
        });
    })
    .catch(function (err) {
      out.push(chkRow('bad', '連不上：' + esc(err.message),
        '常見兩種原因：<br>' +
        '① <b>跨網域被擋（CORS）</b>——把 config.js 的 <code>USE_JSONP</code> 改成 <code>true</code>，' +
        '或改用 cloudflare/worker.js 代理。<br>' +
        '② 網址打錯，或部署被刪除。<br><br>' +
        '也可以直接用瀏覽器開 <a href="' + attr(url) + '" target="_blank" rel="noopener">這個網址</a>，' +
        '看得到一大串 JSON 就表示後端沒問題，是前端跨網域的關係。'));
      render();
    });
}

/* ═══════════════════════════════════════════════════════════
   6. 首頁 UI
═══════════════════════════════════════════════════════════ */
function buildHome() {
  // 班級
  var groups = [], others = [];
  (CONFIG.GRADES || []).forEach(function (g) {
    var list = IDX.realClasses.filter(function (c) { return g.test.test(c); });
    if (list.length) groups.push({ g: g, list: list });
  });
  others = IDX.realClasses.filter(function (c) { return !gradeOf(c); });
  if (others.length) groups.push({ g: { key: '0', label: CONFIG.OTHER_GRADE_LABEL }, list: others });

  $('#gradeGroups').innerHTML = groups.map(function (item) {
    return '<div class="grade-group" style="--gc:var(--g' + esc(item.g.key) + ')">' +
      '<div class="grade-title">' + esc(item.g.label) +
      '<span class="count">' + item.list.length + ' 班</span></div>' +
      '<div class="class-grid">' + item.list.map(function (c) {
        var hm = DB.homerooms[c];
        return '<button class="class-btn" type="button" data-go="class" data-val="' + attr(c) + '">' +
               esc(c) + (hm ? '<small>' + esc(hm) + '</small>' : '') + '</button>';
      }).join('') + '</div></div>';
  }).join('') || '<p class="hint">目前沒有班級資料。</p>';

  // 教師
  var subjSel = $('#subjectFilter');
  subjSel.innerHTML = '<option value="">全部科目</option>' +
    IDX.subjects.map(function (s) { return '<option>' + esc(s) + '</option>'; }).join('');
  renderTeacherChips('');
  subjSel.onchange = function () { renderTeacherChips(this.value); };

  // 教室
  $('#roomChips').innerHTML = IDX.rooms.length
    ? IDX.rooms.map(function (r) {
        var used = Object.keys(IDX.byRoom[r] || {}).length;
        return '<button class="chip" type="button" data-go="room" data-val="' + attr(r) + '">' +
               esc(r) + '<small>' + used + ' 節</small></button>';
      }).join('')
    : '<p class="hint">課表中沒有標註場地。請在試算表的「教室」欄填入場地名稱。</p>';

  // 代課／總覽的下拉
  var dayOpts = IDX.days.map(function (d) { return '<option value="' + d + '">' + DAY_NAMES[d] + '</option>'; }).join('');
  $('#subDay').innerHTML = dayOpts;
  $('#allDay').innerHTML = dayOpts;
  $('#subPeriod').innerHTML = IDX.periods.map(function (p) {
    return '<option value="' + p + '">' + esc(periodInfo(p).name) + '</option>';
  }).join('');

  var n = nowSlot();
  var today = (n.day >= 1 && n.day <= 5) ? n.day : IDX.days[0];
  $('#subDay').value = today; $('#allDay').value = today;
  if (n.period != null) $('#subPeriod').value = n.period;

  $('#subGo').onclick = function () { location.hash = '#/sub/' + $('#subDay').value + '/' + $('#subPeriod').value; };
  $('#allGo').onclick = function () { location.hash = '#/all/' + $('#allDay').value; };

  // 資料狀態
  var meta = [];
  meta.push('班級 ' + IDX.realClasses.length + ' · 教師 ' + IDX.teachers.length +
            ' · 專科教室 ' + IDX.rooms.length + ' · 課堂 ' + DB.lessons.length + ' 筆');
  if (DB.updatedAt) meta.push('資料更新：' + DB.updatedAt);
  if (DB.fallbackReason) meta.push('⚠ 線上資料讀取失敗（' + DB.fallbackReason + '），目前顯示的是網站內建的備援課表。');
  else if (DB.current && DB.current.code === 'local') meta.push('目前讀取網站內建的課表檔（尚未接上 Google 試算表）。');
  $('#dataMeta').innerHTML = meta.map(esc).join('<br>') +
    '<br><a href="#/check">系統檢查 →</a>';
}

function renderTeacherChips(subject) {
  var list = subject ? (IDX.subjectTeachers[subject] || []) : IDX.teachers;
  $('#teacherChips').innerHTML = list.length
    ? list.map(function (t) {
        var hm = Object.keys(DB.homerooms).filter(function (c) { return DB.homerooms[c] === t; });
        var note = hm.length ? hm[0] : titleOf(t);
        return '<button class="chip" type="button" data-go="teacher" data-val="' + attr(t) + '">' +
               esc(t) + (note ? '<small>' + esc(note) + '</small>' : '') + '</button>';
      }).join('')
    : '<p class="hint">沒有符合的教師。</p>';
}

/* ── 快速搜尋 ─────────────────────────────────────────────── */
function setupSearch() {
  var box = $('#quickSearch'), out = $('#quickResult');

  function hits(q) {
    q = q.trim().toLowerCase();
    if (!q) return [];
    var r = [];
    function add(kind, label, value, note) {
      r.push({ kind: kind, label: label, value: value, note: note || '' });
    }
    IDX.realClasses.forEach(function (c) {
      if (c.toLowerCase().indexOf(q) >= 0 || (DB.homerooms[c] || '').indexOf(q) >= 0)
        add('class', c + ' 班', c, DB.homerooms[c] ? '導師 ' + DB.homerooms[c] : '');
    });
    IDX.teachers.forEach(function (t) {
      if (t.toLowerCase().indexOf(q) >= 0) add('teacher', t, t, titleOf(t));
    });
    IDX.rooms.forEach(function (m) {
      if (m.toLowerCase().indexOf(q) >= 0) {
        var used = Object.keys(IDX.byRoom[m] || {}).length;
        add('room', m, m, '已排 ' + used + ' 節');
      }
    });
    // 搜科目也能用（想找「誰在上資訊教育」）
    IDX.subjects.forEach(function (sj) {
      if (sj.toLowerCase().indexOf(q) >= 0) {
        var ts = IDX.subjectTeachers[sj] || [];
        if (ts.length === 1) add('teacher', ts[0], ts[0], sj);
      }
    });
    return r.slice(0, 12);
  }

  function render(list) {
    if (!list.length) { out.innerHTML = '<div class="empty">找不到相符的班級、教師或教室</div>'; out.hidden = false; return; }
    out.innerHTML = list.map(function (h, i) {
      var kindTxt = { 'class': '班級', teacher: '教師', room: '場地' }[h.kind];
      return '<button type="button" data-go="' + h.kind + '" data-val="' + attr(h.value) + '"' +
             (i === 0 ? ' class="on"' : '') + '>' +
             '<span class="kind">' + kindTxt + '</span><span>' + esc(h.label) + '</span>' +
             (h.note ? '<span class="kind">' + esc(h.note) + '</span>' : '') + '</button>';
    }).join('');
    out.hidden = false;
  }

  box.addEventListener('input', function () {
    var v = box.value;
    if (!v.trim()) { out.hidden = true; return; }
    render(hits(v));
  });
  box.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
      var first = out.querySelector('button');
      if (first) { first.click(); box.value = ''; out.hidden = true; }
    } else if (e.key === 'Escape') { out.hidden = true; box.blur(); }
  });
  document.addEventListener('click', function (e) {
    if (!out.contains(e.target) && e.target !== box) out.hidden = true;
  });
}

/* ═══════════════════════════════════════════════════════════
   7. 路由
═══════════════════════════════════════════════════════════ */
function currentSem() {
  var h = location.hash.split('?')[1] || '';
  var m = /(?:^|&)sem=([^&]*)/.exec(h);
  return m ? decodeURIComponent(m[1]) : '';
}

function route() {
  if (!DB) return;
  var raw = location.hash.replace(/^#\/?/, '').split('?')[0];
  var parts = raw.split('/').filter(function (x) { return x !== ''; }).map(decodeURIComponent);

  if (!parts.length) { showHome(); return; }
  switch (parts[0]) {
    case 'class':   return parts[1] ? viewClass(parts[1])   : showHome();
    case 'teacher': return parts[1] ? viewTeacher(parts[1]) : showHome();
    case 'room':    return parts[1] ? viewRoom(parts[1])    : showHome();
    case 'sub':     return viewSub(parts[1] || 1, parts[2] || 1);
    case 'all':     return viewAll(parts[1] || 1);
    case 'check':   return viewCheck();
    default:        return showHome();
  }
}

function go(kind, value) {
  var sem = currentSem();
  location.hash = '#/' + kind + '/' + encodeURIComponent(value) + (sem ? '?sem=' + encodeURIComponent(sem) : '');
}

/* ═══════════════════════════════════════════════════════════
   8. 啟動
═══════════════════════════════════════════════════════════ */
function setupChrome() {
  // 分頁
  $$('.tab').forEach(function (t) {
    t.addEventListener('click', function () {
      $$('.tab').forEach(function (x) { x.classList.toggle('is-on', x === t); });
      var name = t.getAttribute('data-tab');
      LAST_HOME_TAB = name;
      $$('.panel').forEach(function (p) {
        p.classList.toggle('is-on', p.getAttribute('data-panel') === name);
      });
    });
  });

  // 全站點擊委派：任何 data-go 元素都能跳頁
  document.addEventListener('click', function (e) {
    var el = e.target.closest ? e.target.closest('[data-go]') : null;
    if (!el) return;
    e.preventDefault();
    go(el.getAttribute('data-go'), el.getAttribute('data-val'));
  });

  $('#backBtn').onclick = function () {
    if (history.length > 1) history.back();
    else location.hash = '#/';
  };
  $('#printBtn').onclick = function () {
    if ($('#viewResult').hidden) { alert('請先查詢出一張課表，再按列印。'); return; }
    window.print();
  };
  $('#shareBtn').onclick = function () {
    var url = location.href;
    var done = function () {
      var b = $('#shareBtn'); var old = b.textContent;
      b.textContent = '✓ 已複製'; setTimeout(function () { b.textContent = old; }, 1600);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(done, function () { prompt('複製這個連結：', url); });
    } else prompt('複製這個連結：', url);
  };

  window.addEventListener('hashchange', route);
}

function applySemesterSelect() {
  var sel = $('#semesterSelect');
  var list = DB.semesters || [];
  if (list.length <= 1) { sel.hidden = true; return; }
  sel.hidden = false;
  sel.innerHTML = list.map(function (s) {
    return '<option value="' + attr(s.code) + '">' + esc(s.name) + '</option>';
  }).join('');
  sel.value = (DB.current && DB.current.code) || list[0].code;
  sel.onchange = function () {
    location.hash = '#/?sem=' + encodeURIComponent(this.value);
    location.reload();
  };
}

function boot() {
  $('#loader').classList.add('show');
  $('#schoolName').textContent = CONFIG.SCHOOL_NAME;
  $('#schoolSub').textContent  = CONFIG.SCHOOL_SUBTITLE;

  loadData(currentSem()).then(function (db) {
    DB = db;
    DB.homerooms = DB.homerooms || {};
    DB.teacherTitles = DB.teacherTitles || {};
    IDX = buildIndex(DB);

    var name = (DB.school && DB.school['學校名稱']) || CONFIG.SCHOOL_NAME;
    var subt = (DB.school && DB.school['副標題']) || CONFIG.SCHOOL_SUBTITLE;
    $('#schoolName').textContent = name;
    $('#schoolSub').textContent  = subt;
    $('#footSchool').textContent = name;
    document.querySelector('meta[name="description"]') ||
      document.head.insertAdjacentHTML('beforeend',
        '<meta name="description" content="' + attr(name + subt) + '">');

    applySemesterSelect();
    buildHome();
    setupSearch();
    renderNowBar();
    setInterval(renderNowBar, 60000);
    route();
    $('#loader').classList.remove('show');
  }).catch(function (err) {
    $('#loader').classList.remove('show');
    $('#main').innerHTML =
      '<div class="notice"><strong>課表載入失敗</strong><br>' + esc(err.message) +
      '<br><br>請確認 config.js 的 API_URL 是否正確，或 data/ 資料夾內是否有課表檔。'+
      '<br><br><a href="#/check" onclick="location.reload()">執行系統檢查</a></div>';
    console.error(err);
  });
}

setupChrome();
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();

})();
