/* Push service worker: shows a notification on incoming wake-ups and focuses
   an existing tab (or opens one) on click. Payloads contain routing metadata
   only — never message content — because the relay cannot read messages. */

self.addEventListener("push", (event) => {
  let meta = {};
  try {
    meta = event.data ? event.data.json() : {};
  } catch {
    meta = {};
  }
  const title = "New message";
  const body = meta.from ? `You have a new message` : "You have a new message";
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      tag: meta.roomId || "message",
      data: { roomId: meta.roomId },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ("focus" in client) return client.focus();
      }
      return self.clients.openWindow("/");
    }),
  );
});
