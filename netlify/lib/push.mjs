import { createECDH, createHmac } from "node:crypto";
import webPush from "web-push";

function credentials(secret) {
  const pair = createECDH("prime256v1");
  for (let counter = 0; ; counter++) {
    const candidate = createHmac("sha256", secret).update("chore-web-push-v1:" + counter).digest();
    try {
      pair.setPrivateKey(candidate);
      return {
        subject: "https://stevens-family-chores.netlify.app",
        publicKey: pair.getPublicKey().toString("base64url"),
        privateKey: candidate.toString("base64url")
      };
    } catch (error) {
      if (error.code !== "ERR_CRYPTO_INVALID_KEYTYPE") throw error;
    }
  }
}

export function publicPushKey(secret) {
  return credentials(secret).publicKey;
}

export function cleanSubscription(value) {
  if (!value || typeof value.endpoint !== "string" || value.endpoint.length > 2048) return null;
  let url;
  try { url = new URL(value.endpoint); } catch { return null; }
  const supported = (
    (url.hostname === "web.push.apple.com" && /^\/[A-Za-z0-9_-]+$/.test(url.pathname)) ||
    (url.hostname === "fcm.googleapis.com" && /^\/fcm\/send\/[A-Za-z0-9_:-]+$/.test(url.pathname)) ||
    (url.hostname === "updates.push.services.mozilla.com" && /^\/wpush\/v[12]\/[A-Za-z0-9_-]+$/.test(url.pathname))
  );
  if (!supported || url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash) return null;
  const { p256dh, auth } = value.keys ?? {};
  if (typeof p256dh !== "string" || !/^[A-Za-z0-9_-]{87}$/.test(p256dh) ||
      typeof auth !== "string" || !/^[A-Za-z0-9_-]{22}$/.test(auth)) return null;
  return { endpoint: url.href, keys: { p256dh, auth } };
}

export async function deliver(sql, secret, row, message) {
  try {
    await webPush.sendNotification(row.subscription, JSON.stringify(message), {
      vapidDetails: credentials(secret),
      TTL: 3600,
      timeout: 5000,
      ...(message.topic ? { topic: message.topic } : {})
    });
    return true;
  } catch (error) {
    if (error.statusCode === 404 || error.statusCode === 410) {
      await sql`DELETE FROM chore_push_subscriptions WHERE endpoint = ${row.endpoint} AND subscription = ${JSON.stringify(row.subscription)}::jsonb`;
    }
    console.warn("Chore push delivery failed", error.statusCode || error.code || error.name);
    return false;
  }
}

export async function notify(sql, secret, role, message) {
  const rows = await sql`SELECT endpoint, subscription FROM chore_push_subscriptions WHERE role = ${role} ORDER BY updated_at DESC LIMIT 30`;
  await Promise.all(rows.map((row) => deliver(sql, secret, row, message)));
}
