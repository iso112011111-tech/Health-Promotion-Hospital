/* =====================================================================
   วันเวลาแบบไทย — ใช้ร่วมกันทั้งหน้าจองและหน้าเจ้าหน้าที่
   ยึดเขตเวลา Asia/Bangkok เสมอ ไม่ขึ้นกับการตั้งค่าเครื่องผู้ใช้
   คำนวณด้วย UTC ล้วนแล้วค่อยแปลงเป็นข้อความ เดือน/ปีจึงข้ามได้ถูกต้อง
   ===================================================================== */
var DAY_S = ['อา','จ','อ','พ','พฤ','ศ','ส'];
var DAY_L = ['อาทิตย์','จันทร์','อังคาร','พุธ','พฤหัสบดี','ศุกร์','เสาร์'];
var MON   = ['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'];

/** วันและนาทีปัจจุบันตามเวลาประเทศไทย → { date:'YYYY-MM-DD', min:Number } */
function bkkNow() {
  var g = {};
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit',
      day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(new Date()).forEach(function (x) { g[x.type] = x.value; });
  } catch (e) {
    var d = new Date();
    g = { year: d.getFullYear(), month: ('0' + (d.getMonth() + 1)).slice(-2),
          day: ('0' + d.getDate()).slice(-2), hour: d.getHours(), minute: d.getMinutes() };
  }
  return { date: g.year + '-' + g.month + '-' + g.day, min: (+g.hour % 24) * 60 + (+g.minute) };
}

function dObj(s) { var p = String(s).split('-'); return new Date(Date.UTC(+p[0], +p[1] - 1, +p[2])); }

/**
 * true เมื่อเป็นรูปแบบ YYYY-MM-DD ที่มีอยู่จริงบนปฏิทิน
 * ต้องแปลงกลับมาเทียบด้วย เพราะ '2026-02-31' จะถูกเลื่อนเป็น 3 มี.ค. โดยไม่แจ้งเตือน
 */
function isYmd(s) {
  s = String(s);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  var d = dObj(s);
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
/** ถ้าค่าที่ส่งมาไม่ใช่วันที่ใช้ได้ ให้ถอยไปใช้วันนี้แทน กันหน้าเว็บพังทั้งหน้า */
function safeYmd(s) { return isYmd(s) ? String(s) : bkkNow().date; }

function addDays(s, n) {
  var d = dObj(safeYmd(s)); d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function dow(s) { return dObj(safeYmd(s)).getUTCDay(); }
function slotStart(sl) { var t = String(sl).split('–')[0].split(':'); return (+t[0]) * 60 + (+t[1]); }

/** '2026-09-21' → '21 ก.ย. 2569' · full=true → 'จันทร์ที่ 21 ก.ย. 2569' */
function thDate(s, full) {
  var d = dObj(safeYmd(s));
  return (full ? DAY_L[d.getUTCDay()] + 'ที่ ' : '') + d.getUTCDate() + ' ' +
         MON[d.getUTCMonth()] + ' ' + (d.getUTCFullYear() + 543);
}
/** '2026-09-21' → '21 ก.ย.' (ไม่มีปี ใช้ในตารางและรายการที่พื้นที่จำกัด) */
function thShort(s) { var d = dObj(safeYmd(s)); return d.getUTCDate() + ' ' + MON[d.getUTCMonth()]; }

/** จำนวนวันจากวันนี้ → 'วันนี้' 'พรุ่งนี้' 'อีก 3 วัน' */
function thUntil(s) {
  var t = bkkNow().date;
  var n = Math.round((dObj(safeYmd(s)) - dObj(t)) / 864e5);
  return n === 0 ? 'วันนี้' : n === 1 ? 'พรุ่งนี้' : n === 2 ? 'มะรืนนี้'
       : n > 0 ? 'อีก ' + n + ' วัน' : n === -1 ? 'เมื่อวาน' : 'ผ่านมา ' + (-n) + ' วัน';
}
