/*********************************************************************
 * ระบบจองคิวออนไลน์ — รพ.สต.บ้านหนองครกใต้
 * หลังบ้าน: Google Apps Script + Google Sheets + LINE Messaging API
 *
 * ตั้งค่าครั้งแรก
 *   1. Project Settings > Script Properties ใส่ 3 ค่า
 *        CHANNEL_ACCESS_TOKEN   จาก Messaging API channel
 *        LOGIN_CHANNEL_ID       Channel ID ของ LINE Login channel (ตัวที่สร้าง LIFF)
 *        STAFF_KEY              รหัสผ่านหน้าเจ้าหน้าที่ (ตั้งเองให้เดายาก)
 *   2. รันฟังก์ชัน setup() หนึ่งครั้ง (สร้างชีต + ตั้งเวลาแจ้งเตือน)
 *   3. Deploy > New deployment > Web app
 *        Execute as: Me   |   Who has access: Anyone
 *      แล้วนำ URL ที่ลงท้าย /exec ไปใส่ใน config.js (API_URL)
 *********************************************************************/

/* ---- ต้องตรงกับ DEPTS ใน config.js ---- */
var DEPTS = {
  tm: { name: 'แพทย์แผนไทย', tag: 'ท', days: [1,2,3,4,5],
        slots: ['09:00–10:00','10:00–11:00','11:00–12:00','13:30–14:30','15:00–16:00'] },
  dn: { name: 'ทันตกรรม',     tag: 'ฟ', days: [2,4,5],
        slots: ['09:00–10:00','10:00–11:00','11:00–12:00','14:00–15:00','15:00–16:00'] }
};
var ORG = 'รพ.สต.บ้านหนองครกใต้';
var ARRIVE_BEFORE = 15;
var BOOK_AHEAD_DAYS = 14;
var ALLOW_SAME_DAY = true;   // ต้องตรงกับ ALLOW_SAME_DAY ใน config.js
var TZ = 'Asia/Bangkok';

var BOOK_COLS = ['id','createdAt','userId','displayName','dept','service','date','slot','queueNo',
                 'name','idCard','tel','right','note','status','calledAt','updatedAt'];
var PAT_COLS  = ['userId','name','idCard','tel','right','consentAt','updatedAt'];

/* ================================================================= */
/*  จุดรับคำขอ                                                       */
/* ================================================================= */
function doPost(e) {
  try {
    var q = JSON.parse(e.postData.contents || '{}');
    var handler = {
      init:    a_init,
      counts:  a_counts,
      book:    a_book,
      mine:    a_mine,
      cancel:  a_cancel,
      queue:   a_queue,       // เจ้าหน้าที่
      status:  a_status,      // เจ้าหน้าที่
      call:    a_call         // เจ้าหน้าที่
    }[q.action];
    if (!handler) throw new Error('ไม่รู้จักคำสั่ง: ' + q.action);
    return json(handler(q));
  } catch (err) {
    return json({ ok: false, error: String(err.message || err) });
  }
}

function doGet() {
  return json({ ok: true, service: 'ระบบจองคิว ' + ORG, time: new Date().toISOString() });
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/* ================================================================= */
/*  ตัวช่วย                                                          */
/* ================================================================= */
function prop(k) { return PropertiesService.getScriptProperties().getProperty(k) || ''; }

function book_() { return sheet_('bookings', BOOK_COLS); }
function pat_()  { return sheet_('patients', PAT_COLS); }

function sheet_(name, cols) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, cols.length).setValues([cols]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
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

/** ตรวจ ID token ของ LINE — ห้ามเชื่อ userId ที่ส่งมาจากหน้าเว็บตรง ๆ */
function verify_(idToken) {
  if (!idToken) throw new Error('ไม่พบข้อมูลการเข้าสู่ระบบ กรุณาเปิดหน้าจองจากเมนูในแอป LINE');
  var res = UrlFetchApp.fetch('https://api.line.me/oauth2/v2.1/verify', {
    method: 'post',
    payload: { id_token: idToken, client_id: prop('LOGIN_CHANNEL_ID') },
    muteHttpExceptions: true
  });
  var body = JSON.parse(res.getContentText());
  if (res.getResponseCode() !== 200 || !body.sub)
    throw new Error('การเข้าสู่ระบบหมดอายุ กรุณาปิดหน้านี้แล้วเปิดใหม่');
  return { userId: body.sub, displayName: body.name || '', pictureUrl: body.picture || '' };
}

function staff_(q) {
  var key = prop('STAFF_KEY');
  if (!key || q.key !== key) throw new Error('รหัสผ่านเจ้าหน้าที่ไม่ถูกต้อง');
}

function ymd_(d) { return Utilities.formatDate(d, TZ, 'yyyy-MM-dd'); }
function today_() { return ymd_(new Date()); }
/** นาทีที่ผ่านไปของวันนี้ ตามเวลาประเทศไทย */
function nowMin_() {
  return Number(Utilities.formatDate(new Date(), TZ, 'H')) * 60 +
         Number(Utilities.formatDate(new Date(), TZ, 'm'));
}
/** นาทีเริ่มต้นของช่วงเวลา เช่น '13:30–14:30' → 810 */
function slotStart_(slot) {
  var t = String(slot).split('–')[0].split(':');
  return Number(t[0]) * 60 + Number(t[1]);
}
/** วันในสัปดาห์จากสตริง yyyy-MM-dd โดยไม่เพี้ยนตามเขตเวลาของสคริปต์ */
function dow_(s) {
  var p = String(s).split('-');
  return new Date(Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2]))).getUTCDay();
}
function maskId_(n) {
  n = String(n || '');
  return n.length === 13 ? n.slice(0, 4) + ' •••••• ' + n.slice(-2) : '';
}

/* ================================================================= */
/*  คำสั่งฝั่งประชาชน                                                */
/* ================================================================= */
function a_init(q) {
  var u = verify_(q.idToken);
  var p = null;
  rows_(pat_()).forEach(function (r) { if (String(r.userId) === u.userId) p = r; });
  return {
    ok: true,
    profile: u,
    patient: p ? {
      name: p.name, tel: String(p.tel), right: p.right,
      hasIdCard: !!p.idCard, idCardMask: maskId_(p.idCard),
      consent: !!p.consentAt
    } : null
  };
}

function a_counts(q) {
  var dep = DEPTS[q.dept];
  if (!dep) throw new Error('ไม่พบแผนกที่เลือก');
  var from = today_(), counts = {};
  rows_(book_()).forEach(function (r) {
    if (r.dept !== q.dept || r.status === 'cancelled') return;
    var d = r.date instanceof Date ? ymd_(r.date) : String(r.date);
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
  if (!q.service) throw new Error('ไม่พบบริการที่เลือก');

  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(q.date))) throw new Error('วันที่ไม่ถูกต้อง');
  if (dep.days.indexOf(dow_(q.date)) < 0)
    throw new Error('แผนก' + dep.name + 'ไม่เปิดให้บริการในวันที่เลือก');

  var todayS = today_();
  if (q.date < todayS) throw new Error('ไม่สามารถจองย้อนหลังได้');
  if (q.date === todayS) {
    if (!ALLOW_SAME_DAY) throw new Error('กรุณาเลือกวันนัดล่วงหน้าอย่างน้อย 1 วัน');
    if (slotStart_(q.slot) <= nowMin_()) throw new Error('ช่วงเวลาที่เลือกผ่านไปแล้ว กรุณาเลือกช่วงอื่น');
  }

  var max = new Date(); max.setDate(max.getDate() + BOOK_AHEAD_DAYS);
  if (q.date > ymd_(max)) throw new Error('จองล่วงหน้าได้ไม่เกิน ' + BOOK_AHEAD_DAYS + ' วัน');
  if (!q.name || String(q.name).trim().length < 3) throw new Error('กรุณากรอกชื่อ–นามสกุล');
  if (!q.consent) throw new Error('กรุณายินยอมให้เก็บข้อมูลส่วนบุคคล');

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sh = book_(), all = rows_(sh);

    /* กันจองซ้ำ: คนเดิม แผนกเดิม วันเดิม ที่ยังไม่ถูกยกเลิก */
    var dup = all.filter(function (r) {
      return String(r.userId) === u.userId && r.dept === q.dept &&
             (r.date instanceof Date ? ymd_(r.date) : String(r.date)) === q.date &&
             r.status !== 'cancelled';
    });
    if (dup.length) throw new Error('คุณมีคิวแผนก' + dep.name + 'ในวันดังกล่าวอยู่แล้ว (' + dup[0].queueNo + ')');

    /* เลขคิวไล่ตามลำดับ แยกตามแผนกและวัน */
    var n = 0;
    all.forEach(function (r) {
      if (r.dept === q.dept && (r.date instanceof Date ? ymd_(r.date) : String(r.date)) === q.date) n++;
    });
    var queueNo = dep.tag + '-' + ('00' + (n + 1)).slice(-3);
    var id = Utilities.getUuid().slice(0, 8);
    var now = new Date();

    var idCard = String(q.idCard || '');
    if (!idCard) {  /* ไม่ได้กรอกใหม่ → ใช้ของเดิมที่บันทึกไว้ */
      rows_(pat_()).forEach(function (r) { if (String(r.userId) === u.userId) idCard = String(r.idCard || ''); });
    }
    if (idCard.length !== 13) throw new Error('เลขบัตรประชาชนไม่ถูกต้อง');

    sh.appendRow([id, now, u.userId, u.displayName, q.dept, q.service, q.date, q.slot, queueNo,
                  String(q.name).trim(), "'" + idCard, "'" + String(q.tel || ''), q.right || '',
                  String(q.note || ''), 'booked', '', now]);

    savePatient_(u.userId, q.name, idCard, q.tel, q.right);
    try { pushTicket_(u.userId, { queueNo: queueNo, dept: q.dept, service: q.service,
                                 date: q.date, slot: q.slot, name: q.name, right: q.right }); } catch (e) {}
    return { ok: true, id: id, queueNo: queueNo };
  } finally {
    lock.releaseLock();
  }
}

function savePatient_(userId, name, idCard, tel, right) {
  var sh = pat_(), found = null;
  rows_(sh).forEach(function (r) { if (String(r.userId) === userId) found = r; });
  var now = new Date();
  var vals = [userId, String(name).trim(), "'" + idCard, "'" + String(tel || ''), right || '', now, now];
  if (found) {
    vals[5] = found.consentAt || now;
    sh.getRange(found._row, 1, 1, PAT_COLS.length).setValues([vals]);
  } else {
    sh.appendRow(vals);
  }
}

function a_mine(q) {
  var u = verify_(q.idToken);
  var from = today_(), out = [];
  rows_(book_()).forEach(function (r) {
    var d = r.date instanceof Date ? ymd_(r.date) : String(r.date);
    if (String(r.userId) !== u.userId || r.status === 'cancelled' || d < from) return;
    out.push({ id: r.id, dept: r.dept, service: r.service, date: d, slot: r.slot,
               queueNo: r.queueNo, status: r.status });
  });
  out.sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
  return { ok: true, items: out };
}

function a_cancel(q) {
  var u = verify_(q.idToken);
  var sh = book_(), hit = null;
  rows_(sh).forEach(function (r) { if (r.id === q.id && String(r.userId) === u.userId) hit = r; });
  if (!hit) throw new Error('ไม่พบคิวที่ต้องการยกเลิก');
  if (hit.status === 'cancelled') return { ok: true };
  sh.getRange(hit._row, BOOK_COLS.indexOf('status') + 1).setValue('cancelled');
  sh.getRange(hit._row, BOOK_COLS.indexOf('updatedAt') + 1).setValue(new Date());
  try {
    push_(u.userId, [{ type: 'text',
      text: 'ยกเลิกคิว ' + hit.queueNo + ' เรียบร้อยแล้ว\nหากต้องการนัดใหม่ กดที่เมนู “จองคิวรับบริการ” ได้ตลอดเวลา' }]);
  } catch (e) {}
  return { ok: true };
}

/* ================================================================= */
/*  คำสั่งฝั่งเจ้าหน้าที่                                            */
/* ================================================================= */
function a_queue(q) {
  staff_(q);
  var date = q.date || today_(), out = [];
  rows_(book_()).forEach(function (r) {
    var d = r.date instanceof Date ? ymd_(r.date) : String(r.date);
    if (d !== date) return;
    if (q.dept && q.dept !== 'all' && r.dept !== q.dept) return;
    out.push({ id: r.id, dept: r.dept, service: r.service, slot: r.slot, queueNo: r.queueNo,
               name: r.name, tel: String(r.tel).replace(/^'/, ''), right: r.right,
               note: r.note, status: r.status });
  });
  out.sort(function (a, b) {
    return a.slot < b.slot ? -1 : a.slot > b.slot ? 1 : (a.queueNo < b.queueNo ? -1 : 1);
  });
  return { ok: true, date: date, items: out };
}

function a_status(q) {
  staff_(q);
  var allowed = ['booked','checkin','done','noshow','cancelled'];
  if (allowed.indexOf(q.status) < 0) throw new Error('สถานะไม่ถูกต้อง');
  var sh = book_(), hit = null;
  rows_(sh).forEach(function (r) { if (r.id === q.id) hit = r; });
  if (!hit) throw new Error('ไม่พบคิวนี้');
  sh.getRange(hit._row, BOOK_COLS.indexOf('status') + 1).setValue(q.status);
  sh.getRange(hit._row, BOOK_COLS.indexOf('updatedAt') + 1).setValue(new Date());
  return { ok: true };
}

function a_call(q) {
  staff_(q);
  var sh = book_(), hit = null;
  rows_(sh).forEach(function (r) { if (r.id === q.id) hit = r; });
  if (!hit) throw new Error('ไม่พบคิวนี้');
  sh.getRange(hit._row, BOOK_COLS.indexOf('calledAt') + 1).setValue(new Date());
  push_(String(hit.userId), [{ type: 'text',
    text: 'ถึงคิวของท่านแล้ว\n\nหมายเลขคิว ' + hit.queueNo + '\n' +
          (DEPTS[hit.dept] ? DEPTS[hit.dept].name : hit.dept) + ' · ' + hit.service +
          (q.room ? '\nเชิญที่ ' + q.room : '') + '\n\nกรุณาติดต่อเจ้าหน้าที่ค่ะ' }]);
  return { ok: true };
}

/* ================================================================= */
/*  ส่งข้อความเข้า LINE                                              */
/* ================================================================= */
function push_(to, messages) {
  var token = prop('CHANNEL_ACCESS_TOKEN');
  if (!token) return;
  var res = UrlFetchApp.fetch('https://api.line.me/v2/bot/message/push', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + token },
    payload: JSON.stringify({ to: to, messages: messages }),
    muteHttpExceptions: true
  });
  if (res.getResponseCode() >= 300) console.warn('LINE push failed: ' + res.getContentText());
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
  push_(userId, [{
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
        row('บริการ', b.service),
        row('วันที่', thDate_(b.date, true)),
        row('เวลา', b.slot + ' น.'),
        row('ผู้รับบริการ', b.name),
        row('สิทธิ', b.right || '-'),
        row('สถานที่', ORG),
        { type: 'text', size: 'xxs', color: '#87A49A', wrap: true,
          text: 'กรุณามาถึงก่อนเวลานัด ' + ARRIVE_BEFORE + ' นาที และแสดงบัตรคิวนี้ต่อเจ้าหน้าที่' }] }
    }
  }]);
}

/* ================================================================= */
/*  แจ้งเตือนล่วงหน้า 1 วัน (ตั้งเวลารันทุกวัน 19:00)                */
/* ================================================================= */
function sendReminders() {
  var t = new Date(); t.setDate(t.getDate() + 1);
  var target = ymd_(t), n = 0;
  rows_(book_()).forEach(function (r) {
    var d = r.date instanceof Date ? ymd_(r.date) : String(r.date);
    if (d !== target || r.status !== 'booked') return;
    var dep = DEPTS[r.dept] || { name: r.dept };
    try {
      push_(String(r.userId), [{ type: 'text',
        text: 'เตือนนัดหมายพรุ่งนี้\n\nหมายเลขคิว ' + r.queueNo + '\n' + dep.name + ' · ' + r.service +
              '\n' + thDate_(d, true) + ' เวลา ' + r.slot + ' น.\n' + ORG +
              '\n\nกรุณามาถึงก่อนเวลานัด ' + ARRIVE_BEFORE + ' นาที\nหากไม่สะดวก ยกเลิกได้ที่เมนู “จองคิวรับบริการ”' }]);
      n++;
    } catch (e) { console.warn(e); }
  });
  console.log('ส่งการแจ้งเตือน ' + n + ' รายการ สำหรับวันที่ ' + target);
}

/* ================================================================= */
/*  ติดตั้งครั้งแรก — รันฟังก์ชันนี้หนึ่งครั้ง                       */
/* ================================================================= */
function setup() {
  book_(); pat_();
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'sendReminders') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('sendReminders').timeBased().atHour(19).everyDays(1)
    .inTimezone(TZ).create();

  var missing = ['CHANNEL_ACCESS_TOKEN', 'LOGIN_CHANNEL_ID', 'STAFF_KEY']
    .filter(function (k) { return !prop(k); });
  console.log(missing.length
    ? '⚠️ ยังไม่ได้ตั้งค่า Script Properties: ' + missing.join(', ')
    : '✅ ติดตั้งเรียบร้อย พร้อม Deploy เป็น Web app ได้เลย');
}
