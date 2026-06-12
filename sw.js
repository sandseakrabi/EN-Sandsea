const CACHE_NAME = 'en-system-v2';
const ASSETS = [
  './',
  './index.html',
  'https://fonts.googleapis.com/css2?family=Sarabun:wght@400;600;700&display=swap'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(c => c.addAll(ASSETS)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  if (e.request.url.includes('script.google.com')) return;
  e.respondWith(
    caches.match(e.request).then(r => r || fetch(e.request).catch(() => caches.match('./index.html')))
  );
});

// ================================================================
// PUSH NOTIFICATION — รับ push จาก GAS แล้วแสดง notification
// ================================================================
self.addEventListener('push', e => {
  let data = { title: '🔧 EN System', body: 'มีงานใหม่เข้ามา', ticketId: '' };
  try {
    if (e.data) data = Object.assign(data, e.data.json());
  } catch(err) {
    if (e.data) data.body = e.data.text();
  }

  const options = {
    body:    data.body,
    icon:    './icon-EN.png',
    badge:   './icon-EN.png',
    tag:     data.ticketId || 'en-notify',   // tag เดิม = replace แทน stack
    renotify: true,
    vibrate: [200, 100, 200],
    data:    { ticketId: data.ticketId || '' },
    actions: [
      { action: 'open', title: '📋 เปิดดูงาน' },
      { action: 'dismiss', title: 'ปิด' }
    ]
  };

  e.waitUntil(self.registration.showNotification(data.title, options));
});

// ================================================================
// NOTIFICATION CLICK — กดแจ้งเตือน → เปิด app โฟกัสทันที
// ================================================================
self.addEventListener('notificationclick', e => {
  e.notification.close();
  if (e.action === 'dismiss') return;

  const ticketId = (e.notification.data && e.notification.data.ticketId) || '';

  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      // ถ้ามีหน้าต่างเปิดอยู่แล้ว → focus แล้วส่ง message ให้ scroll ไปที่ ticket
      for (const client of list) {
        if (client.url.includes('index.html') || client.url.endsWith('/')) {
          client.focus();
          if (ticketId) client.postMessage({ type: 'OPEN_TICKET', ticketId });
          return;
        }
      }
      // ถ้าไม่มีหน้าต่าง → เปิดใหม่
      const url = ticketId ? './?ticket=' + ticketId : './';
      return clients.openWindow(url);
    })
  );
});
