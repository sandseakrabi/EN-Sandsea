// ================================================================
// EN System — Service Worker
// รองรับ: PWA cache พื้นฐาน + Periodic Background Sync
// (เช็คงานใหม่/อัปเดตสถานะ แม้แอปถูกปิดอยู่ — Android Chrome เท่านั้น)
// ================================================================

const GAS_URL   = 'https://script.google.com/macros/s/AKfycbyNqXw2l5cPPauA3dWlWPPaOdYAdP1J1igCSRiwjehC6PWQneNK_JsAh1jc1Ytv8AADxg/exec';
const ICON      = './icon-EN.png';
const SYNC_TAG  = 'en-check-tickets';
const DB_NAME   = 'en_sw_db';
const DB_STORE  = 'state';

// ---------------------------------------------------------------
// INSTALL / ACTIVATE
// ---------------------------------------------------------------
self.addEventListener('install', function(event) {
  self.skipWaiting();
});

self.addEventListener('activate', function(event) {
  event.waitUntil(self.clients.claim());
});

// ---------------------------------------------------------------
// IndexedDB helpers — เก็บ "เห็นแล้ว" ของ ticket ข้ามรอบ sync
// ใช้แทนตัวแปร JS ธรรมดา เพราะ SW อาจถูกฆ่าทิ้งระหว่างรอบ
// ---------------------------------------------------------------
function dbOpen() {
  return new Promise(function(resolve, reject) {
    var req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = function() {
      req.result.createObjectStore(DB_STORE);
    };
    req.onsuccess = function() { resolve(req.result); };
    req.onerror   = function() { reject(req.error); };
  });
}

function dbGet(key) {
  return dbOpen().then(function(db) {
    return new Promise(function(resolve, reject) {
      var tx = db.transaction(DB_STORE, 'readonly');
      var rq = tx.objectStore(DB_STORE).get(key);
      rq.onsuccess = function() { resolve(rq.result); };
      rq.onerror   = function() { reject(rq.error); };
    });
  });
}

function dbSet(key, value) {
  return dbOpen().then(function(db) {
    return new Promise(function(resolve, reject) {
      var tx = db.transaction(DB_STORE, 'readwrite');
      tx.objectStore(DB_STORE).put(value, key);
      tx.oncomplete = function() { resolve(); };
      tx.onerror    = function() { reject(tx.error); };
    });
  });
}

// ---------------------------------------------------------------
// เรียก GAS ตรงจาก Service Worker (ไม่ผ่านหน้าเว็บ)
// ---------------------------------------------------------------
function gasCallSW(fn, params) {
  return fetch(GAS_URL + '?action=' + encodeURIComponent(fn), {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify(params || {})
  }).then(function(r) {
    var ct = r.headers.get('content-type') || '';
    if (!ct.includes('json')) throw new Error('non-json response from ' + fn);
    return r.json();
  });
}

// ---------------------------------------------------------------
// PERIODIC BACKGROUND SYNC
// ตื่นมาเช็คงานใหม่ + อัปเดตสถานะ เป็นช่วงๆ แม้แอปปิดอยู่
// (เบราว์เซอร์เป็นผู้กำหนดความถี่จริง อาจไม่ตรง minInterval เป๊ะ)
// ---------------------------------------------------------------
self.addEventListener('periodicsync', function(event) {
  if (event.tag === SYNC_TAG) {
    event.waitUntil(checkTicketsInBackground());
  }
});

// เผื่อเบราว์เซอร์/อุปกรณ์ไม่รองรับ periodicsync แต่รองรับ sync ปกติ (one-off, ถูก trigger ตอนเน็ตกลับมา)
self.addEventListener('sync', function(event) {
  if (event.tag === SYNC_TAG) {
    event.waitUntil(checkTicketsInBackground());
  }
});

async function checkTicketsInBackground() {
  var user = await dbGet('current_user');
  if (!user) return; // ยังไม่ login หรือ logout ไปแล้ว

  try {
    if (user.role === 'staff') {
      await checkStaffTicketsSW(user);
    } else if (['tech','it_tech','admin','it_admin','HK_admin'].includes(user.role)) {
      await checkNewTicketsSW(user);
    }
  } catch (e) {
    // เงียบไว้ — รอบหน้าค่อยลองใหม่ ไม่ต้อง throw ให้ระบบ retry รัว ๆ
    console.warn('[SW] checkTicketsInBackground error:', e);
  }
}

// ── ฝั่งช่าง/admin: เช็คงานใหม่ที่ status = open ──
async function checkNewTicketsSW(user) {
  var result = await gasCallSW('getTickets', { userJson: JSON.stringify(user), filterStatus: 'open' });
  var tickets = (result && result.tickets) ? result.tickets : [];

  var seenIds = (await dbGet('seen_ticket_ids')) || {};
  var isFirstRun = (await dbGet('seen_ticket_ids')) == null;

  var currentIds = {};
  tickets.forEach(function(t) { currentIds[t.TicketID] = true; });

  if (!isFirstRun) {
    for (var id in currentIds) {
      if (!seenIds[id]) {
        var t = tickets.find(function(x) { return x.TicketID === id; });
        await showTicketNotificationSW(t);
      }
    }
  }
  await dbSet('seen_ticket_ids', currentIds);
}

// ── ฝั่งพนักงาน: เช็คการเปลี่ยนสถานะของใบงานตัวเอง ──
var STATUS_LABEL_SW = {
  'open':        '📋 รอช่างรับงาน',
  'in_progress': '🔧 ช่างรับงานแล้ว กำลังดำเนินการ',
  'on_hold':     '⏸ รออะไหล่ / ติดปัญหา',
  'done':        '✅ ดำเนินการเสร็จแล้ว',
  'oo_closed':   '🔒 ปิดใบงานแล้ว'
};

async function checkStaffTicketsSW(user) {
  var result = await gasCallSW('getTickets', { userJson: JSON.stringify(user), filterStatus: 'all' });
  var tickets = (result && result.tickets) ? result.tickets : [];

  var seenStatus = (await dbGet('seen_staff_status')) || {};
  var isFirstRun = (await dbGet('seen_staff_status')) == null;

  var nextStatus = {};
  for (var i = 0; i < tickets.length; i++) {
    var t = tickets[i];
    nextStatus[t.TicketID] = t.Status;
    if (!isFirstRun && seenStatus[t.TicketID] !== undefined && seenStatus[t.TicketID] !== t.Status) {
      await showStaffNotificationSW(t);
    }
  }
  await dbSet('seen_staff_status', nextStatus);
}

// ---------------------------------------------------------------
// แสดง Notification (ทำงานได้แม้ไม่มีหน้าเว็บเปิดอยู่เลย)
// ---------------------------------------------------------------
async function showTicketNotificationSW(t) {
  if (!t) return;
  var title = '🔧 งานใหม่เข้ามา';
  var body  = (t.JobType || '') + ' — ' + (t.Location || '') +
              '\n' + String(t.Detail || '').substring(0, 60);

  await self.registration.showNotification(title, {
    body: body,
    icon: ICON,
    badge: ICON,
    tag: t.TicketID,
    renotify: true,
    vibrate: [200, 100, 200],
    data: { ticketId: t.TicketID }
  });
}

async function showStaffNotificationSW(t) {
  var label    = STATUS_LABEL_SW[t.Status] || t.Status;
  var techName = t.TechName ? ' โดย ' + t.TechName : '';
  var title    = 'อัปเดตใบงาน';
  var body     = label + techName + '\n' + (t.JobType || '') + ' — ' + (t.Location || '');

  await self.registration.showNotification(title, {
    body: body,
    icon: ICON,
    badge: ICON,
    tag: t.TicketID + '-' + t.Status + '-' + Date.now(),
    renotify: true,
    vibrate: [300, 100, 300],
    data: { ticketId: t.TicketID }
  });
}

// ---------------------------------------------------------------
// คลิก Notification → เปิด/โฟกัสแอป พร้อม ?ticket=ID
// ---------------------------------------------------------------
self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  var ticketId = event.notification.data && event.notification.data.ticketId;
  var targetUrl = self.registration.scope + (ticketId ? '?ticket=' + encodeURIComponent(ticketId) : '');

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(clientList) {
      for (var i = 0; i < clientList.length; i++) {
        var client = clientList[i];
        if ('focus' in client) {
          client.focus();
          if (ticketId && 'postMessage' in client) {
            client.postMessage({ type: 'OPEN_TICKET', ticketId: ticketId });
          }
          return;
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
    })
  );
});

// ---------------------------------------------------------------
// รับข้อความจากหน้าเว็บ (index.html postMessage)
// ใช้ตอน login/logout เพื่อบันทึก/ลบ user ที่ใช้เช็คงานใน background
// ---------------------------------------------------------------
self.addEventListener('message', function(event) {
  var msg = event.data || {};
  if (msg.type === 'SET_USER') {
    event.waitUntil(dbSet('current_user', msg.user));
  } else if (msg.type === 'CLEAR_USER') {
    event.waitUntil(
      Promise.all([
        dbSet('current_user', null),
        dbSet('seen_ticket_ids', null),
        dbSet('seen_staff_status', null)
      ])
    );
  }
});
