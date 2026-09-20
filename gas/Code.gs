/*********************************************************************
 * ระบบจองคิวออนไลน์ — รพ.สต.บ้านหนองครกใต้
 * หลังบ้าน: Google Apps Script + Google Sheets + LINE Messaging API
 *
 * ตั้งค่าครั้งแรก
 *   1. Project Settings > Script Properties ใส่ 3 ค่า
 *        CHANNEL_ACCESS_TOKEN   จาก Messaging API channel
 *        LOGIN_CHANNEL_ID       Channel ID ของ LINE Login channel (ตัวที่สร้าง LIFF)
 *        STAFF_KEY              รหัสผ่านหน้าเจ้าหน้าที่ — อย่างน้อย 12 ตัวอักษร
 *   2. รันฟังก์ชัน setup() หนึ่งครั้ง (สร้าง/อัปเกรดชีต + ตั้งเวลาแจ้งเตือน)
 *   3. Deploy > New deployment > Web app
 *        Execute as: Me   |   Who has access: Anyone
 *      แล้วนำ URL ที่ลงท้าย /exec ไปใส่ใน config.js (API_URL)
 *
 * ไฟล์นี้เป็น "แหล่งความจริงเดียว" ของตารางเวลาและรายการบริการ
 * หน้าเว็บจะดึงค่าจาก a_config ตอนเปิด ไม่ต้องแก้ config.js ให้ตรงกันอีก
 *********************************************************************/

var VERSION = '2026-09-20.4';

/* ============ ตารางบริการ — แก้ที่นี่ที่เดียว ============ */
var DEPTS = {
  tm: {
    name: 'แพทย์แผนไทย', tag: 'ท', blurb: 'นวด ประคบ พอก อบสมุนไพร',
    days: [1, 2, 3, 4, 5], dayTxt: 'จันทร์–ศุกร์', breakAfter: 2,
    slots: ['09:00–10:00', '10:00–11:00', '11:00–12:00', '13:30–14:30', '15:00–16:00'],
    services: ['ตรวจ / ประเมินอาการแพทย์แผนไทย', 'นวดไทย', 'ประคบสมุนไพร', 'พอกเข่า',
               'อบสมุนไพร', 'รับยาสมุนไพร', 'ปรึกษาด้านสมุนไพร', 'ติดตามผลการรักษา']
  },
  dn: {
    name: 'ทันตกรรม', tag: 'ฟ', blurb: 'ตรวจฟัน ขูดหินปูน อุด ถอน',
    days: [2, 4, 5], dayTxt: 'อังคาร · พฤหัสบดี · ศุกร์', breakAfter: 2,
    slots: ['09:00–10:00', '10:00–11:00', '11:00–12:00', '14:00–15:00', '15:00–16:00'],
    services: ['ตรวจสุขภาพช่องปาก', 'ขูดหินปูน', 'อุดฟัน', 'ถอนฟัน', 'เคลือบฟลูออไรด์',
               'ตรวจ / รักษาอาการปวดฟัน', 'นัดติดตามการรักษา']
  }
};
var RIGHTS = ['บัตรทอง (UC)', 'ข้าราชการ', 'ประกันสังคม', 'ชำระเงินเอง', 'อื่น ๆ'];
var HOLIDAYS = [];                 // วันหยุดพิเศษ รูปแบบ 'YYYY-MM-DD'

var ORG = 'รพ.สต.บ้านหนองครกใต้';
var ORG_SHORT = 'รพ.สต.หนองครกใต้';
var ARRIVE_BEFORE = 15;
var BOOK_AHEAD_DAYS = 14;
var ALLOW_SAME_DAY = true;
var MAX_ACTIVE = 4;                // จำนวนคิวที่ยังไม่ถึงวันนัด ต่อ 1 คน
var TZ = 'Asia/Bangkok';

/* ความยาวสูงสุดของข้อความที่รับจากผู้ใช้ */
var MAX_NAME = 100, MAX_NOTE = 300, MAX_RIGHT = 60;

/* กันเดารหัสผ่านเจ้าหน้าที่ */
var STAFF_MAX_FAIL = 5, STAFF_LOCK_MIN = 15, STAFF_FAIL_DELAY_MS = 1200;

var BOOK_COLS = ['id','createdAt','userId','displayName','dept','service','date','slot','queueNo',
                 'name','idCard','tel','right','note','status','calledAt','updatedAt','remindedAt'];
var PAT_COLS  = ['userId','name','idCard','tel','right','consentAt','updatedAt'];

/* ================================================================= */
/*  จุดรับคำขอ                                                       */
/* ================================================================= */
function doPost(e) {
  try {
    var q = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    var handler = {
      config:   a_config,     // เปิดสาธารณะ — เฉพาะตารางเวลา ไม่มีข้อมูลบุคคล
      init:     a_init,
      counts:   a_counts,
      book:     a_book,
      mine:     a_mine,
      cancel:   a_cancel,
      board:    a_board,      // เจ้าหน้าที่ — คิววันนี้ + นัดล่วงหน้า ในคำขอเดียว
      queue:    a_queue,      // เจ้าหน้าที่
      upcoming: a_upcoming,   // เจ้าหน้าที่
      range:    a_range,      // เจ้าหน้าที่
      status:   a_status,     // เจ้าหน้าที่
      call:     a_call        // เจ้าหน้าที่
    }[q.action];
    if (!handler) throw new Error('ไม่รู้จักคำสั่ง: ' + q.action);
    return json(handler(q));
  } catch (err) {
    var msg = String((err && err.message) || err);
    return json({ ok: false, error: msg, code: errCode_(msg) });
  }
}

/** รหัสข้อผิดพลาดให้หน้าเว็บแยกแยะได้ โดยไม่ต้องเดาจากข้อความ */
function errCode_(msg) {
  if (/หมดอายุ|เข้าสู่ระบบ/.test(msg)) return 'AUTH_EXPIRED';
  if (/รหัสผ่านเจ้าหน้าที่|ล็อกชั่วคราว/.test(msg)) return 'STAFF_AUTH';
  return 'ERROR';
}

function doGet() {
  return json({
    ok: true, service: 'ระบบจองคิว ' + ORG, version: VERSION,
    actions: ['config','init','counts','book','mine','cancel','board','queue','upcoming','range','status','call'],
    time: Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm:ss')
  });
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/* ================================================================= */
/*  ตัวช่วยทั่วไป                                                    */
/* ================================================================= */
function prop(k) { return PropertiesService.getScriptProperties().getProperty(k) || ''; }

/** ตัดข้อความให้ไม่เกินความยาวที่กำหนด และตัดช่องว่างหัวท้าย */
function clip_(v, max) { return String(v == null ? '' : v).trim().slice(0, max); }

/**
 * กันสูตรฝังในชีต (formula injection)
 * Google Sheets ตีความข้อความที่ขึ้นต้นด้วย = + - @ ว่าเป็นสูตร
 * เช่นชื่อโปรไฟล์ LINE ที่ตั้งเป็น =IMPORTXML(...) จะดูดข้อมูลทั้งชีตออกไปตอนเจ้าหน้าที่เปิดไฟล์
 * ใส่ ' นำหน้าเพื่อบังคับให้เป็นข้อความล้วน
 */
function cell_(v) {
  var s = String(v == null ? '' : v);
  return /^[=+\-@\t\r]/.test(s) ? "'" + s : s;
}

/** ตรวจเลขบัตรประชาชนไทย 13 หลักด้วย checksum */
function validThaiId_(s) {
  var n = String(s || '').replace(/\D/g, '');
  if (n.length !== 13) return false;
  var sum = 0;
  for (var i = 0; i < 12; i++) sum += Number(n.charAt(i)) * (13 - i);
  return ((11 - sum % 11) % 10) === Number(n.charAt(12));
}

/* ---------------- ชีต ---------------- */
function book_() { return sheet_('bookings', BOOK_COLS); }
function pat_()  { return sheet_('patients', PAT_COLS); }

/** สร้างชีตถ้ายังไม่มี และเติมคอลัมน์ที่ขาดให้ชีตเดิมโดยไม่แตะข้อมูลเก่า */
function sheet_(name, cols) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, cols.length).setValues([cols]).setFontWeight('bold');
    sh.setFrozenRows(1);
    return sh;
  }
  var last = sh.getLastColumn();
  var head = last ? sh.getRange(1, 1, 1, last).getValues()[0] : [];
  var add = cols.filter(function (c) { return head.indexOf(c) < 0; });
  if (add.length) sh.getRange(1, head.length + 1, 1, add.length).setValues([add]).setFontWeight('bold');
  return sh;
}

function head_(sh) {
  var last = sh.getLastColumn();
  return last ? sh.getRange(1, 1, 1, last).getValues()[0] : [];
}

function rows_(sh) {
  var v = sh.getDataRange().getValues();
  if (v.length < 2) return [];
  var head = v[0], out = [];
  for (var i = 1; i < v.length; i++) {
    var o = { _row: i + 1 };
    for (var c = 0; c < head.length; c++) o[head[c]] = v[i][c];
    out.push(o);
  }
  return out;
}

/** เขียนแถวใหม่โดยอิงชื่อคอลัมน์จริงในชีต ไม่ใช่ลำดับที่เขียนไว้ในโค้ด */
function appendObj_(sh, obj) {
  var head = head_(sh);
  sh.appendRow(head.map(function (h) { return obj[h] === undefined ? '' : obj[h]; }));
}
function setCell_(sh, row, colName, value) {
  var i = head_(sh).indexOf(colName);
  if (i >= 0) sh.getRange(row, i + 1).setValue(value);
}

/* ---------------- แคช ---------------- */
function dataVer_() {
  return PropertiesService.getScriptProperties().getProperty('DATA_VER') || '0';
}
function bumpVer_() {
  var p = PropertiesService.getScriptProperties();
  p.setProperty('DATA_VER', String((Number(p.getProperty('DATA_VER')) || 0) + 1));
}
function cacheGet_(k) {
  try { var v = CacheService.getScriptCache().get(k); return v ? JSON.parse(v) : null; }
  catch (e) { return null; }
}
function cachePut_(k, v, sec) {
  try {
    var s = JSON.stringify(v);
    if (s.length < 90000) CacheService.getScriptCache().put(k, s, sec || 45);
  } catch (e) {}
}

/* ---------------- ยืนยันตัวตน ---------------- */
/** ตรวจ ID token กับเซิร์ฟเวอร์ LINE — ห้ามเชื่อ userId ที่ส่งมาจากหน้าเว็บ */
function verify_(idToken) {
  if (!idToken) throw new Error('ไม่พบข้อมูลการเข้าสู่ระบบ กรุณาเปิดหน้าจองจากเมนูในแอป LINE');
  var res = UrlFetchApp.fetch('https://api.line.me/oauth2/v2.1/verify', {
    method: 'post',
    payload: { id_token: idToken, client_id: prop('LOGIN_CHANNEL_ID') },
    muteHttpExceptions: true
  });
  var body;
  try { body = JSON.parse(res.getContentText()); } catch (e) { body = {}; }
  if (res.getResponseCode() !== 200 || !body.sub)
    throw new Error('การเข้าสู่ระบบหมดอายุ กรุณาเข้าสู่ระบบใหม่');
  return { userId: body.sub, displayName: body.name || '', pictureUrl: body.picture || '' };
}

/** เทียบข้อความแบบใช้เวลาคงที่ กันการเดาจากเวลาตอบกลับ */
function eq_(a, b) {
  a = String(a); b = String(b);
  var n = Math.max(a.length, b.length), d = a.length === b.length ? 0 : 1;
  for (var i = 0; i < n; i++) d |= ((a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0));
  return d === 0;
}

/**
 * ตรวจรหัสผ่านเจ้าหน้าที่ พร้อมหน่วงเวลาและล็อกเมื่อผิดติดกันหลายครั้ง
 * Apps Script ไม่เห็น IP ผู้เรียก จึงนับรวมทั้งระบบ
 * ถ้าเจ้าหน้าที่ถูกล็อกไปด้วย ให้รันฟังก์ชัน unlockStaff() ในตัวแก้ไขสคริปต์
 */
function staff_(q) {
  var key = prop('STAFF_KEY');
  if (!key) throw new Error('ระบบยังไม่ได้ตั้งรหัสผ่านเจ้าหน้าที่ กรุณาติดต่อผู้ดูแล');
  var c = CacheService.getScriptCache();
  var fails = Number(c.get('staff_fail')) || 0;
  if (fails >= STAFF_MAX_FAIL)
    throw new Error('ใส่รหัสผ่านผิดเกินกำหนด ระบบล็อกชั่วคราวประมาณ ' + STAFF_LOCK_MIN + ' นาที');
  if (!eq_(q.key || '', key)) {
    c.put('staff_fail', String(fails + 1), STAFF_LOCK_MIN * 60);
    Utilities.sleep(STAFF_FAIL_DELAY_MS);
    var left = STAFF_MAX_FAIL - fails - 1;
    throw new Error('รหัสผ่านเจ้าหน้าที่ไม่ถูกต้อง' + (left > 0 ? ' (เหลืออีก ' + left + ' ครั้ง)' : ''));
  }
  c.remove('staff_fail');
}
function unlockStaff() {
  CacheService.getScriptCache().remove('staff_fail');
  console.log('ปลดล็อกการเข้าสู่ระบบเจ้าหน้าที่แล้ว');
}

/* ---------------- วันเวลา ---------------- */
function ymd_(d) { return Utilities.formatDate(d, TZ, 'yyyy-MM-dd'); }
function today_() { return ymd_(new Date()); }
function nowMin_() {
  var s = Utilities.formatDate(new Date(), TZ, 'HH:mm').split(':');
  return Number(s[0]) * 60 + Number(s[1]);
}
function slotStart_(slot) {
  var t = String(slot).split('–')[0].split(':');
  return Number(t[0]) * 60 + Number(t[1]);
}
function dow_(s) {
  var p = String(s).split('-');
  return new Date(Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2]))).getUTCDay();
}
function dateOf_(r) { return r.date instanceof Date ? ymd_(r.date) : String(r.date); }
function maskId_(n) {
  n = String(n || '').replace(/\D/g, '');
  return n.length === 13 ? n.slice(0, 4) + ' •••••• ' + n.slice(-2) : '';
}

/* ================================================================= */
/*  ตารางเวลา (เปิดสาธารณะ — ไม่มีข้อมูลบุคคล)                       */
/* ================================================================= */
function a_config() {
  return {
    ok: true, version: VERSION,
    org: ORG, orgShort: ORG_SHORT,
    depts: DEPTS, rights: RIGHTS, holidays: HOLIDAYS,
    allowSameDay: ALLOW_SAME_DAY, bookAheadDays: BOOK_AHEAD_DAYS, arriveBefore: ARRIVE_BEFORE
  };
}

/* ================================================================= */
/*  คำสั่งฝั่งประชาชน                                                */
/* ================================================================= */
function a_init(q) {
  var u = verify_(q.idToken);
  var p = null;
  rows_(pat_()).forEach(function (r) { if (String(r.userId) === u.userId) p = r; });
  return {
    ok: true, profile: u,
    patient: p ? {
      name: String(p.name || '').replace(/^'/, ''),
      tel: String(p.tel || '').replace(/^'/, ''),
      right: p.right,
      hasIdCard: !!p.idCard, idCardMask: maskId_(p.idCard),
      consent: !!p.consentAt
    } : null
  };
}

function a_counts(q) {
  verify_(q.idToken);                       /* ปิดไม่ให้เรียกจากภายนอกโดยไม่ผ่าน LINE */
  var dep = DEPTS[q.dept];
  if (!dep) throw new Error('ไม่พบแผนกที่เลือก');
  var from = today_(), counts = {};
  rows_(book_()).forEach(function (r) {
    if (r.dept !== q.dept || r.status === 'cancelled') return;
    var d = dateOf_(r);
    if (d < from) return;
    var k = d + '|' + r.slot;
    counts[k] = (counts[k] || 0) + 1;
  });
  return { ok: true, counts: counts };
}

function a_book(q) {
  var u = verify_(q.idToken);
  var dep = DEPTS[q.dept];
  if (!dep) throw new Error('ไม่พบแผนกที่เลือก');
  if (dep.slots.indexOf(q.slot) < 0) throw new Error('ช่วงเวลาไม่ถูกต้อง');
  if (dep.services.indexOf(String(q.service)) < 0)
    throw new Error('ไม่พบบริการที่เลือกในแผนก' + dep.name);

  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(q.date))) throw new Error('วันที่ไม่ถูกต้อง');
  if (dep.days.indexOf(dow_(q.date)) < 0)
    throw new Error('แผนก' + dep.name + 'ไม่เปิดให้บริการในวันที่เลือก');
  if (HOLIDAYS.indexOf(q.date) > -1) throw new Error('วันที่เลือกเป็นวันหยุดให้บริการ');

  var todayS = today_();
  if (q.date < todayS) throw new Error('ไม่สามารถจองย้อนหลังได้');
  if (q.date === todayS) {
    if (!ALLOW_SAME_DAY) throw new Error('กรุณาเลือกวันนัดล่วงหน้าอย่างน้อย 1 วัน');
    if (slotStart_(q.slot) <= nowMin_()) throw new Error('ช่วงเวลาที่เลือกผ่านไปแล้ว กรุณาเลือกช่วงอื่น');
  }
  var max = new Date(); max.setDate(max.getDate() + BOOK_AHEAD_DAYS);
  if (q.date > ymd_(max)) throw new Error('จองล่วงหน้าได้ไม่เกิน ' + BOOK_AHEAD_DAYS + ' วัน');

  var name = clip_(q.name, MAX_NAME);
  if (name.length < 3) throw new Error('กรุณากรอกชื่อ–นามสกุล');
  if (!q.consent) throw new Error('กรุณายินยอมให้เก็บข้อมูลส่วนบุคคล');

  var right = clip_(q.right, MAX_RIGHT);
  if (right && RIGHTS.indexOf(right) < 0) right = 'อื่น ๆ';
  var note = clip_(q.note, MAX_NOTE);
  var tel = String(q.tel || '').replace(/\D/g, '').slice(0, 10);
  if (tel.length < 9) throw new Error('เบอร์โทรศัพท์ไม่ถูกต้อง');

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sh = book_(), all = rows_(sh);

    var mine = all.filter(function (r) {
      return String(r.userId) === u.userId && r.status !== 'cancelled';
    });
    var dup = mine.filter(function (r) { return r.dept === q.dept && dateOf_(r) === q.date; });
    if (dup.length)
      throw new Error('คุณมีคิวแผนก' + dep.name + 'ในวันดังกล่าวอยู่แล้ว (' + dup[0].queueNo + ')');

    var active = mine.filter(function (r) { return dateOf_(r) >= todayS; }).length;
    if (active >= MAX_ACTIVE)
      throw new Error('คุณมีคิวที่ยังไม่ถึงวันนัด ' + active + ' รายการแล้ว ' +
                      'จองเพิ่มได้ไม่เกิน ' + MAX_ACTIVE + ' รายการ กรุณายกเลิกคิวเดิมก่อน');

    /* เลขคิวไล่ตามลำดับ แยกตามแผนกและวัน */
    var n = 0;
    all.forEach(function (r) { if (r.dept === q.dept && dateOf_(r) === q.date) n++; });
    var queueNo = dep.tag + '-' + ('00' + (n + 1)).slice(-3);
    var id = Utilities.getUuid().slice(0, 8);
    var now = new Date();

    var idCard = String(q.idCard || '').replace(/\D/g, '');
    if (!idCard) {
      rows_(pat_()).forEach(function (r) {
        if (String(r.userId) === u.userId) idCard = String(r.idCard || '').replace(/\D/g, '');
      });
    }
    if (!validThaiId_(idCard)) throw new Error('เลขบัตรประชาชนไม่ถูกต้อง');

    appendObj_(sh, {
      id: id, createdAt: now, userId: u.userId, displayName: cell_(clip_(u.displayName, MAX_NAME)),
      dept: q.dept, service: cell_(String(q.service)), date: q.date, slot: q.slot, queueNo: queueNo,
      name: cell_(name), idCard: "'" + idCard, tel: "'" + tel, right: cell_(right),
      note: cell_(note), status: 'booked', calledAt: '', updatedAt: now, remindedAt: ''
    });
    savePatient_(u.userId, name, idCard, tel, right);
    bumpVer_();

    var pushed = pushTicket_(u.userId, { queueNo: queueNo, dept: q.dept, service: q.service,
      date: q.date, slot: q.slot, name: name, right: right });
    return { ok: true, id: id, queueNo: queueNo, pushed: pushed };
  } finally {
    lock.releaseLock();
  }
}

function savePatient_(userId, name, idCard, tel, right) {
  var sh = pat_(), found = null;
  rows_(sh).forEach(function (r) { if (String(r.userId) === userId) found = r; });
  var now = new Date();
  var obj = { userId: userId, name: cell_(name), idCard: "'" + idCard,
              tel: "'" + tel, right: cell_(right), consentAt: now, updatedAt: now };
  if (found) {
    obj.consentAt = found.consentAt || now;
    var head = head_(sh);
    sh.getRange(found._row, 1, 1, head.length)
      .setValues([head.map(function (h) { return obj[h] === undefined ? '' : obj[h]; })]);
  } else {
    appendObj_(sh, obj);
  }
}

function a_mine(q) {
  var u = verify_(q.idToken);
  var from = today_(), out = [];
  rows_(book_()).forEach(function (r) {
    var d = dateOf_(r);
    if (String(r.userId) !== u.userId || r.status === 'cancelled' || d < from) return;
    out.push({ id: r.id, dept: r.dept, service: r.service, date: d, slot: r.slot,
               queueNo: r.queueNo, status: r.status });
  });
  out.sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : (a.slot < b.slot ? -1 : 1); });
  return { ok: true, items: out, max: MAX_ACTIVE };
}

function a_cancel(q) {
  var u = verify_(q.idToken);
  var sh = book_(), hit = null;
  rows_(sh).forEach(function (r) { if (r.id === q.id && String(r.userId) === u.userId) hit = r; });
  if (!hit) throw new Error('ไม่พบคิวที่ต้องการยกเลิก');
  if (hit.status === 'cancelled') return { ok: true };
  if (dateOf_(hit) < today_()) throw new Error('คิวที่ผ่านวันนัดไปแล้วยกเลิกไม่ได้');
  setCell_(sh, hit._row, 'status', 'cancelled');
  setCell_(sh, hit._row, 'updatedAt', new Date());
  bumpVer_();
  push_(u.userId, [{ type: 'text',
    text: 'ยกเลิกคิว ' + hit.queueNo + ' เรียบร้อยแล้ว\nหากต้องการนัดใหม่ กดที่เมนู “จองคิวรับบริการ” ได้ตลอดเวลา' }]);
  return { ok: true };
}

/* ================================================================= */
/*  คำสั่งฝั่งเจ้าหน้าที่                                            */
/* ================================================================= */
function mapRow_(r) {
  return { id: r.id, dept: r.dept, service: r.service, date: dateOf_(r), slot: r.slot,
           queueNo: r.queueNo, name: String(r.name || '').replace(/^'/, ''),
           tel: String(r.tel || '').replace(/^'/, ''), right: r.right,
           note: String(r.note || '').replace(/^'/, ''), status: r.status };
}
function bySlot_(a, b) {
  return a.slot < b.slot ? -1 : a.slot > b.slot ? 1 : (a.queueNo < b.queueNo ? -1 : a.queueNo > b.queueNo ? 1 : 0);
}

/** คิววันที่เลือก + นัดล่วงหน้าทั้งหมด ในคำขอเดียว อ่านชีตครั้งเดียวและแคช 45 วินาที */
function a_board(q) {
  staff_(q);
  var date = q.date || today_();
  var ck = 'board|' + dataVer_() + '|' + date;
  var hit = cacheGet_(ck);
  if (hit) { hit.cached = true; return hit; }

  var t = today_(), items = [], up = [];
  rows_(book_()).forEach(function (r) {
    var d = dateOf_(r);
    if (d === date) items.push(mapRow_(r));
    if (d > t && r.status !== 'cancelled') up.push(mapRow_(r));
  });
  items.sort(bySlot_);
  up.sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : bySlot_(a, b); });

  var res = { ok: true, date: date, today: t, items: items, upcoming: up, cached: false };
  cachePut_(ck, res, 45);
  return res;
}

function a_queue(q) {
  staff_(q);
  var date = q.date || today_(), out = [];
  rows_(book_()).forEach(function (r) {
    if (dateOf_(r) !== date) return;
    if (q.dept && q.dept !== 'all' && r.dept !== q.dept) return;
    out.push(mapRow_(r));
  });
  out.sort(bySlot_);
  return { ok: true, date: date, items: out };
}

function a_upcoming(q) {
  staff_(q);
  var t = today_(), out = [];
  rows_(book_()).forEach(function (r) {
    var d = dateOf_(r);
    if (d <= t || r.status === 'cancelled') return;
    out.push(mapRow_(r));
  });
  out.sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : bySlot_(a, b); });
  return { ok: true, items: out, today: t };
}

function a_range(q) {
  staff_(q);
  var from = String(q.from || ''), to = String(q.to || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to))
    throw new Error('ช่วงวันที่ไม่ถูกต้อง');
  var ck = 'range|' + dataVer_() + '|' + from + '|' + to;
  var hit = cacheGet_(ck);
  if (hit) return hit;

  var days = {};
  rows_(book_()).forEach(function (r) {
    var d = dateOf_(r);
    if (d < from || d > to) return;
    if (!days[d]) days[d] = {};
    if (!days[d][r.dept]) days[d][r.dept] =
      { total: 0, booked: 0, checkin: 0, done: 0, noshow: 0, cancelled: 0 };
    var b = days[d][r.dept];
    if (r.status !== 'cancelled') b.total++;
    if (b[r.status] !== undefined) b[r.status]++;
  });
  var res = { ok: true, from: from, to: to, days: days };
  cachePut_(ck, res, 60);
  return res;
}

function a_status(q) {
  staff_(q);
  if (['booked','checkin','done','noshow','cancelled'].indexOf(q.status) < 0)
    throw new Error('สถานะไม่ถูกต้อง');
  var sh = book_(), hit = null;
  rows_(sh).forEach(function (r) { if (r.id === q.id) hit = r; });
  if (!hit) throw new Error('ไม่พบคิวนี้');
  setCell_(sh, hit._row, 'status', q.status);
  setCell_(sh, hit._row, 'updatedAt', new Date());
  bumpVer_();
  return { ok: true };
}

function a_call(q) {
  staff_(q);
  var sh = book_(), hit = null;
  rows_(sh).forEach(function (r) { if (r.id === q.id) hit = r; });
  if (!hit) throw new Error('ไม่พบคิวนี้');
  setCell_(sh, hit._row, 'calledAt', new Date());
  bumpVer_();
  var dep = DEPTS[hit.dept] || { name: hit.dept };
  var sent = push_(String(hit.userId), [{ type: 'text',
    text: 'ถึงคิวของท่านแล้ว\n\nหมายเลขคิว ' + hit.queueNo + '\n' + dep.name + ' · ' + hit.service +
          (q.room ? '\nเชิญที่ ' + clip_(q.room, 60) : '') + '\n\nกรุณาติดต่อเจ้าหน้าที่ค่ะ' }]);
  return { ok: true, pushed: sent };
}

/* ================================================================= */
/*  ส่งข้อความเข้า LINE                                              */
/* ================================================================= */
/** คืนค่า true เมื่อส่งสำเร็จ — ผู้เรียกต้องบอกผู้ใช้ตามความจริง */
function push_(to, messages) {
  var token = prop('CHANNEL_ACCESS_TOKEN');
  if (!token) { console.warn('ยังไม่ได้ตั้ง CHANNEL_ACCESS_TOKEN'); return false; }
  try {
    var res = UrlFetchApp.fetch('https://api.line.me/v2/bot/message/push', {
      method: 'post', contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + token },
      payload: JSON.stringify({ to: to, messages: messages }),
      muteHttpExceptions: true
    });
    if (res.getResponseCode() >= 300) {
      console.warn('ส่งข้อความ LINE ไม่สำเร็จ: ' + res.getContentText());
      return false;
    }
    return true;
  } catch (e) {
    console.warn('ส่งข้อความ LINE ไม่สำเร็จ: ' + e);
    return false;
  }
}

function thDate_(s, full) {
  var DAY = ['อาทิตย์','จันทร์','อังคาร','พุธ','พฤหัสบดี','ศุกร์','เสาร์'];
  var MON = ['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'];
  var p = String(s).split('-');
  var d = new Date(Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2])));
  return (full ? DAY[d.getUTCDay()] + 'ที่ ' : '') + d.getUTCDate() + ' ' +
         MON[d.getUTCMonth()] + ' ' + (d.getUTCFullYear() + 543);
}

function pushTicket_(userId, b) {
  var dep = DEPTS[b.dept], acc = b.dept === 'dn' ? '#0B8B96' : '#12A37A';
  function row(k, v) {
    return { type: 'box', layout: 'baseline', spacing: 'sm', contents: [
      { type: 'text', text: k, color: '#87A49A', size: 'sm', flex: 2 },
      { type: 'text', text: String(v), wrap: true, color: '#11302A', size: 'sm', flex: 5, align: 'end' }] };
  }
  return push_(userId, [{
    type: 'flex',
    altText: 'บัตรคิว ' + b.queueNo + ' · ' + dep.name + ' · ' + thDate_(b.date) + ' ' + b.slot,
    contents: {
      type: 'bubble',
      header: { type: 'box', layout: 'vertical', backgroundColor: acc, paddingAll: '16px', contents: [
        { type: 'text', text: 'บัตรคิวออนไลน์', color: '#FFFFFF', size: 'xxs' },
        { type: 'text', text: dep.name, color: '#FFFFFF', size: 'lg', weight: 'bold' }] },
      body: { type: 'box', layout: 'vertical', spacing: 'md', contents: [
        { type: 'box', layout: 'baseline', contents: [
          { type: 'text', text: 'หมายเลขคิว', size: 'xs', color: '#87A49A', flex: 4 },
          { type: 'text', text: b.queueNo, size: 'xxl', weight: 'bold', color: acc, align: 'end', flex: 5 }] },
        { type: 'separator' },
        row('บริการ', b.service), row('วันที่', thDate_(b.date, true)), row('เวลา', b.slot + ' น.'),
        row('ผู้รับบริการ', b.name), row('สิทธิ', b.right || '-'), row('สถานที่', ORG),
        { type: 'text', size: 'xxs', color: '#87A49A', wrap: true,
          text: 'กรุณามาถึงก่อนเวลานัด ' + ARRIVE_BEFORE + ' นาที และแสดงบัตรคิวนี้ต่อเจ้าหน้าที่' }] }
    }
  }]);
}

/* ================================================================= */
/*  แจ้งเตือนล่วงหน้า 1 วัน — รันทุกวัน 19:00                        */
/*  บันทึก remindedAt กันส่งซ้ำเมื่อ Google รัน trigger ซ้ำ           */
/* ================================================================= */
function sendReminders() {
  var t = new Date(); t.setDate(t.getDate() + 1);
  var target = ymd_(t), sh = book_(), sent = 0, skipped = 0;
  rows_(sh).forEach(function (r) {
    if (dateOf_(r) !== target || r.status !== 'booked') return;
    if (r.remindedAt) { skipped++; return; }
    var dep = DEPTS[r.dept] || { name: r.dept };
    var ok = push_(String(r.userId), [{ type: 'text',
      text: 'เตือนนัดหมายพรุ่งนี้\n\nหมายเลขคิว ' + r.queueNo + '\n' + dep.name + ' · ' + r.service +
            '\n' + thDate_(target, true) + ' เวลา ' + r.slot + ' น.\n' + ORG +
            '\n\nกรุณามาถึงก่อนเวลานัด ' + ARRIVE_BEFORE + ' นาที\nหากไม่สะดวก ยกเลิกได้ที่เมนู “จองคิวรับบริการ”' }]);
    if (ok) { setCell_(sh, r._row, 'remindedAt', new Date()); sent++; }
  });
  console.log('แจ้งเตือนวันที่ ' + target + ' · ส่งสำเร็จ ' + sent + ' · ข้ามเพราะเคยส่งแล้ว ' + skipped);
}

/* ================================================================= */
/*  ติดตั้ง / อัปเกรด — รันฟังก์ชันนี้หลังวางโค้ดใหม่ทุกครั้ง         */
/* ================================================================= */
function setup() {
  book_(); pat_();                 /* สร้างชีต และเติมคอลัมน์ที่ขาด เช่น remindedAt */
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'sendReminders') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('sendReminders').timeBased().atHour(19).everyDays(1).inTimezone(TZ).create();

  var msg = ['เวอร์ชัน ' + VERSION];
  var missing = ['CHANNEL_ACCESS_TOKEN','LOGIN_CHANNEL_ID','STAFF_KEY']
    .filter(function (k) { return !prop(k); });
  if (missing.length) msg.push('⚠️ ยังไม่ได้ตั้ง Script Properties: ' + missing.join(', '));
  var key = prop('STAFF_KEY');
  if (key && key.length < 12)
    msg.push('⚠️ STAFF_KEY สั้นเกินไป (' + key.length + ' ตัว) ควรยาวอย่างน้อย 12 ตัวอักษร ' +
             'เพราะ URL ของ API เป็นข้อมูลสาธารณะ รหัสนี้คือด่านเดียวที่กั้นข้อมูลคนไข้');
  if (!missing.length && key && key.length >= 12) msg.push('✅ พร้อมใช้งาน Deploy เป็น Web app ได้เลย');
  console.log(msg.join('\n'));
}
