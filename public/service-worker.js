self.addEventListener("push", (event) => {
  let message = {};
  try { message = event.data?.json() ?? {}; } catch {}
  event.waitUntil(self.registration.showNotification("Family Chore Tracker", {
    body: message.body || "There’s an update in your chore tracker.",
    icon: "/chore-icon.png",
    tag: message.topic,
    data: { tab: message.tab }
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const tab = event.notification.data?.tab;
  const target = new URL("/", self.location.origin);
  if (["daily", "weekly", "extra"].includes(tab)) target.searchParams.set("tab", tab);
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const tracker = windows.find((client) => new URL(client.url).origin === target.origin);
    if (tracker) {
      const page = await tracker.navigate(target.href).catch(() => null);
      if (page) return page.focus();
    }
    return self.clients.openWindow(target.href);
  })());
});
