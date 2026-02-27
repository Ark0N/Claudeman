// Codeman Service Worker — Web Push notifications
// This service worker receives push events from the server and displays OS-level notifications.
// It also handles notification clicks to focus or open the Codeman tab.

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  if (!event.data) return;

  let payload;
  try {
    payload = event.data.json();
  } catch {
    return;
  }

  const { title, body, tag, sessionId, urgency, actions } = payload;

  const options = {
    body: body || '',
    tag: tag || 'codeman-default',
    icon: '/favicon.ico',
    badge: '/favicon.ico',
    data: { sessionId, url: sessionId ? `/?session=${sessionId}` : '/' },
    renotify: true,
    requireInteraction: urgency === 'critical',
  };

  if (actions && actions.length > 0) {
    options.actions = actions;
  }

  event.waitUntil(
    self.registration.showNotification(title || 'Codeman', options)
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const { sessionId, url } = event.notification.data || {};
  const targetUrl = url || '/';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      // Try to find an existing Codeman tab
      for (const client of clients) {
        if (client.url.includes(self.location.origin)) {
          client.postMessage({
            type: 'notification-click',
            sessionId,
            action: event.action || null,
          });
          return client.focus();
        }
      }
      // No existing tab — open a new one
      return self.clients.openWindow(targetUrl);
    })
  );
});
