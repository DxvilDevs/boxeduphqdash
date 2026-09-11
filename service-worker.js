const CACHE_NAME = 'boxed-up-hq-v5-checklists';
const APP_FILES = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './config.js',
  './manifest.webmanifest',
  './assets/logo.png',
  './assets/icon-32.png',
  './assets/icon-48.png',
  './assets/icon-96.png',
  './assets/icon-180.png',
  './assets/icon-192.png',
  './assets/icon-512.png',
  './assets/maskable-192.png',
  './assets/maskable-512.png'
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(APP_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  if (event.request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const response = await fetch(event.request);
        const cache = await caches.open(CACHE_NAME);
        cache.put('./index.html', response.clone());
        return response;
      } catch (_) {
        return (await caches.match(event.request)) || (await caches.match('./index.html'));
      }
    })());
    return;
  }

  event.respondWith((async () => {
    const networkFirst = ['script', 'style'].includes(event.request.destination)
      || /\/(config\.js|manifest\.webmanifest)$/.test(url.pathname);

    if (networkFirst) {
      try {
        const response = await fetch(event.request);
        if (response.ok) {
          const cache = await caches.open(CACHE_NAME);
          cache.put(event.request, response.clone());
        }
        return response;
      } catch (_) {
        return caches.match(event.request);
      }
    }

    const cached = await caches.match(event.request);
    if (cached) return cached;
    const response = await fetch(event.request);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(event.request, response.clone());
    }
    return response;
  })());
});

const DB_NAME = 'boxed-up-hq-pwa';
const STORE = 'kv';

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function kvGet(key, fallback = null) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result ?? fallback);
    req.onerror = () => reject(req.error);
  });
}

async function kvSet(key, value) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function localDayKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function dueBucket(task) {
  if (!task?.due_date || task.status === 'Done') return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const due = new Date(`${task.due_date}T00:00:00`);
  if (Number.isNaN(due.getTime())) return null;
  const days = Math.round((due.getTime() - today.getTime()) / 86400000);
  if (days > 2) return null;
  if (days === 2) return { key: '2-days', body: `Due in 2 days${task.tracker_name ? ` • ${task.tracker_name}` : ''}` };
  if (days === 1) return { key: 'tomorrow', body: `Due tomorrow${task.tracker_name ? ` • ${task.tracker_name}` : ''}` };
  if (days === 0) return { key: 'today', body: `Due today${task.tracker_name ? ` • ${task.tracker_name}` : ''}` };
  return { key: `overdue-${localDayKey(today)}`, body: `Overdue by ${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'}${task.tracker_name ? ` • ${task.tracker_name}` : ''}` };
}

async function checkReminderTasks() {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  const tasks = await kvGet('reminderTasks', []);
  const notified = await kvGet('notified', {});
  let changed = false;

  for (const task of tasks) {
    const bucket = dueBucket(task);
    if (!bucket) continue;
    const noticeKey = `${task.id}:${bucket.key}`;
    if (notified[noticeKey]) continue;

    await self.registration.showNotification(`Boxed Up HQ • ${task.title}`, {
      body: bucket.body,
      icon: './assets/icon-192.png',
      badge: './assets/icon-96.png',
      tag: `boxed-up-${noticeKey}`,
      renotify: false,
      data: { url: task.url || './' },
      actions: [{ action: 'open', title: 'Open task' }]
    });
    notified[noticeKey] = Date.now();
    changed = true;
  }

  if (changed) {
    const cutoff = Date.now() - 45 * 86400000;
    for (const [key, timestamp] of Object.entries(notified)) {
      if (timestamp < cutoff) delete notified[key];
    }
    await kvSet('notified', notified);
  }
}

self.addEventListener('message', event => {
  const message = event.data || {};
  if (message.type === 'SYNC_REMINDER_TASKS') {
    event.waitUntil(kvSet('reminderTasks', Array.isArray(message.tasks) ? message.tasks : []).then(checkReminderTasks));
  } else if (message.type === 'CHECK_REMINDERS') {
    event.waitUntil(checkReminderTasks());
  } else if (message.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('periodicsync', event => {
  if (event.tag === 'boxed-up-due-reminders') event.waitUntil(checkReminderTasks());
});

self.addEventListener('sync', event => {
  if (event.tag === 'boxed-up-due-reminders') event.waitUntil(checkReminderTasks());
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || './', self.registration.scope).href;
  event.waitUntil((async () => {
    const windows = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) {
      if ('focus' in client) {
        await client.navigate(target);
        return client.focus();
      }
    }
    if (clients.openWindow) return clients.openWindow(target);
  })());
});
