import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { getDatabase } from "@netlify/database";
import { cleanSubscription, deliver, notify, publicPushKey } from "../lib/push.mjs";

const groups = {
  daily: ["room", "kitchen", "gear", "dog"],
  weekly: ["laundry", "trash", "living", "bath"],
  extra: ["trailer", "windows", "mop", "dust", "vacuum", "mow", "edge", "vehicle", "garage", "pantry"]
};
const rewards = { trailer: 20, windows: 15, mop: 15, dust: 10, vacuum: 15, mow: 20, edge: 15, vehicle: 20, garage: 25, pantry: 10 };
const familyAge = 365 * 24 * 60 * 60;
const parentAge = 25 * 60;
const dateFormat = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit" });
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const noCache = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };

function periods() {
  const daily = dateFormat.format(new Date());
  const monday = new Date(daily + "T12:00:00Z");
  monday.setUTCDate(monday.getUTCDate() - (monday.getUTCDay() + 6) % 7);
  return { daily, weekly: monday.toISOString().slice(0, 10), extra: daily.slice(0, 7) };
}

function json(data, status = 200, cookies = []) {
  const headers = new Headers(noCache);
  for (const cookie of cookies) headers.append("Set-Cookie", cookie);
  return Response.json(data, { status, headers });
}

function same(a, b) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function sign(secret, value) {
  return createHmac("sha256", secret).update(value).digest("base64url");
}

function issue(secret, role, age) {
  const payload = [role, Math.floor(Date.now() / 1000) + age, randomUUID()].join(".");
  return payload + "." + sign(secret, payload);
}

function verifies(secret, token, role) {
  if (typeof token !== "string" || token.length > 200) return false;
  const [actual, expires, nonce, signature, ...rest] = token.split(".");
  return actual === role && !rest.length && Number(expires) > Date.now() / 1000 &&
    Boolean(nonce && signature && same(signature, sign(secret, [actual, expires, nonce].join("."))));
}

function cookie(name, token, age) {
  return `__Host-${name}=${token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${age}`;
}

function readCookie(req, name) {
  const prefix = "__Host-" + name + "=";
  return req.headers.get("cookie")?.split(/;\s*/).find((part) => part.startsWith(prefix))?.slice(prefix.length);
}

async function allowsAttempt(sql, secret, ip) {
  // Persistent counters share a limit across function instances and deployments.
  const bucket = sign(secret, "login:" + (ip || "unknown"));
  const rows = await sql`
    INSERT INTO chore_pin_attempts (bucket, attempts, starts_at)
    VALUES (${bucket}, 1, now()), ('global', 1, now())
    ON CONFLICT (bucket) DO UPDATE SET
      attempts = CASE WHEN chore_pin_attempts.starts_at < now() - interval '15 minutes'
        THEN 1 ELSE least(chore_pin_attempts.attempts + 1, 1000) END,
      starts_at = CASE WHEN chore_pin_attempts.starts_at < now() - interval '15 minutes'
        THEN now() ELSE chore_pin_attempts.starts_at END
    RETURNING bucket, attempts
  `;
  return rows.every((row) => row.attempts <= (row.bucket === "global" ? 50 : 8));
}

async function board(sql, parent) {
  const current = periods();
  const rows = await sql`
    WITH visible AS (
      SELECT DISTINCT ON (group_id, chore_id) id, group_id, chore_id, status, note, period
      FROM chore_submissions
      WHERE (group_id = 'daily' AND period = ${current.daily})
         OR (group_id = 'weekly' AND period = ${current.weekly})
         OR (group_id = 'extra' AND (period = ${current.extra} OR status = 'submitted'))
      ORDER BY group_id, chore_id, period DESC
    )
    SELECT coalesce((SELECT json_agg(visible) FROM visible), '[]'::json) AS tasks,
      (SELECT coalesce(sum(earned), 0)::integer FROM chore_submissions) AS earned,
      (SELECT json_build_object('checkedAt', checked_at, 'verifiedAt', verified_at,
        'denyEnabled', deny_enabled, 'healthy', healthy) FROM chore_wifi_status) AS wifi
  `;
  const tasks = { daily: {}, weekly: {}, extra: {} };
  for (const row of rows[0].tasks) {
    tasks[row.group_id][row.chore_id] = {
      id: row.id, status: row.status, note: row.note,
      photo: "/api/chores?photo=" + row.id
    };
  }
  return json({ periods: current, tasks, earned: rows[0].earned, wifi: rows[0].wifi, parent });
}

async function submit(sql, body, announce) {
  const { group, chore, period, photo } = body;
  if (!Object.hasOwn(groups, group) || !groups[group].includes(chore)) return json({ error: "Unknown chore." }, 400);
  const current = periods();
  if (period !== current[group]) return json({ error: "A new chore period started. Refresh and attach your photo again." }, 409);
  const match = typeof photo === "string" && photo.length <= 100000 && /^data:image\/jpeg;base64,([a-z0-9+/]+={0,2})$/i.exec(photo);
  const bytes = match ? Buffer.from(match[1], "base64") : null;
  if (!bytes || bytes.length < 4 || bytes[0] !== 255 || bytes[1] !== 216 || bytes.at(-2) !== 255 || bytes.at(-1) !== 217) {
    return json({ error: "Attach a valid JPEG proof photo." }, 400);
  }
  let rows;
  try {
    rows = await sql`
      INSERT INTO chore_submissions (id, group_id, chore_id, period, photo)
      VALUES (${randomUUID()}, ${group}, ${chore}, ${period}, decode(${match[1]}, 'base64'))
      ON CONFLICT (group_id, chore_id, period) DO UPDATE
      SET id = excluded.id, photo = excluded.photo, status = 'submitted',
          note = '', submitted_at = now(), reviewed_at = null
      WHERE chore_submissions.status = 'rejected'
      RETURNING NOT EXISTS (
        SELECT 1 FROM chore_submissions queued
        WHERE queued.status = 'submitted' AND (
          (queued.group_id = 'daily' AND queued.period = ${current.daily}) OR
          (queued.group_id = 'weekly' AND queued.period = ${current.weekly}) OR
          queued.group_id = 'extra'
        )
      ) AS was_empty
    `;
  } catch (error) {
    if (error.code !== "23505") throw error;
  }
  if (rows?.[0]?.was_empty) announce("parent", {
    body: "A chore is ready to review.", tab: group, topic: "review-ready"
  });
  return rows?.length ? json({ ok: true }) : json({ error: "This chore already has a submission awaiting review or an approval." }, 409);
}

async function review(sql, body, announce) {
  const { id, decision } = body;
  const note = typeof body.note === "string" ? body.note.trim() : "";
  if (!uuid.test(id) || !["approved", "rejected"].includes(decision) || note.length > 300 || (decision === "rejected" && !note)) {
    return json({ error: "Select a valid submission and include a note for a redo." }, 400);
  }
  const current = periods();
  const rows = await sql`
    UPDATE chore_submissions
    SET status = ${decision}, note = ${decision === "rejected" ? note : ""}, reviewed_at = now(),
      earned = CASE WHEN group_id = 'extra' AND ${decision} = 'approved'
        THEN coalesce((${JSON.stringify(rewards)}::jsonb ->> chore_id)::integer, 0) ELSE 0 END
    WHERE id = ${id} AND status = 'submitted'
      AND (group_id = 'extra' OR (group_id = 'daily' AND period = ${current.daily})
        OR (group_id = 'weekly' AND period = ${current.weekly}))
    RETURNING group_id, earned
  `;
  if (rows.length) {
    const { group_id: group, earned } = rows[0];
    if (decision === "rejected") {
      announce("son", { body: "A chore needs a redo. Open the tracker for the note.", tab: group });
    } else if (earned > 0) {
      announce("son", { body: "You earned $" + earned + " for an extra-credit chore.", tab: group });
    } else {
      announce("son", {
        unlocked: { group, period: current[group], count: groups[group].length },
        body: group === "daily" ? "Wi-Fi and screens are unlocked." : "Sports transport and outings are unlocked.",
        tab: group, topic: group + "-unlocked"
      });
    }
  }
  return rows.length ? json({ ok: true }) : json({ error: "This submission is no longer awaiting review." }, 409);
}

export default async function chores(req, context) {
  const url = new URL(req.url);
  const secret = Netlify.env.get("CHORE_SESSION_SECRET");
  const pin = Netlify.env.get("CHORE_PARENT_PIN");
  if (!secret || secret.length < 32 || !/^\d{4}$/.test(pin ?? "")) {
    return json({ error: "The shared tracker is awaiting setup." }, 503);
  }
  const parent = verifies(secret, readCookie(req, "chore-parent"), "parent");
  const family = parent || verifies(secret, readCookie(req, "chore-family"), "family");
  try {
    if (url.searchParams.has("wifi")) {
      const key = sign(secret, "oliver-wifi-read-v1");
      if (!same(req.headers.get("authorization") ?? "", "Bearer " + key)) {
        return json({ error: "Invalid Wi-Fi status key." }, 401);
      }
      const { sql } = getDatabase();
      if (req.method === "POST") {
        const raw = await req.text();
        if (raw.length > 128) return json({ error: "Invalid check-in." }, 400);
        let report;
        try { report = JSON.parse(raw); } catch { return json({ error: "Invalid check-in." }, 400); }
        if (!report || (report.healthy !== false &&
            (report.healthy !== true || typeof report.denyEnabled !== "boolean"))) {
          return json({ error: "Invalid check-in." }, 400);
        }
        const healthy = report.healthy;
        const enabled = healthy ? report.denyEnabled : null;
        await sql`
          INSERT INTO chore_wifi_status (healthy, deny_enabled, verified_at)
          VALUES (${healthy}, ${enabled}, CASE WHEN ${healthy} THEN now() END)
          ON CONFLICT (singleton) DO UPDATE SET checked_at = now(),
            healthy = excluded.healthy,
            deny_enabled = coalesce(excluded.deny_enabled, chore_wifi_status.deny_enabled),
            verified_at = coalesce(excluded.verified_at, chore_wifi_status.verified_at)
        `;
        return json({ ok: true });
      }
      if (req.method !== "GET") return json({ error: "Method not allowed." }, 405);
      const period = periods().daily;
      const rows = await sql`
        SELECT count(*)::int AS approved FROM chore_submissions
        WHERE group_id = 'daily' AND period = ${period} AND status = 'approved'
          AND chore_id IN ('room', 'kitchen', 'gear', 'dog')
      `;
      return json({ period, wifiUnlocked: rows[0].approved === groups.daily.length });
    }
    if (req.method === "GET") {
      if (!family) return json({ error: "Join the household to view chores." }, 401);
      const { sql } = getDatabase();
      const photo = url.searchParams.get("photo");
      if (photo !== null) {
        if (!uuid.test(photo)) return json({ error: "Photo not found." }, 404);
        const rows = await sql`SELECT encode(photo, 'base64') AS photo FROM chore_submissions WHERE id = ${photo}`;
        return rows.length
          ? new Response(Buffer.from(rows[0].photo, "base64"), { headers: { ...noCache, "Content-Type": "image/jpeg" } })
          : json({ error: "Photo not found." }, 404);
      }
      if (url.searchParams.has("push")) return json({ key: publicPushKey(secret) });
      return await board(sql, parent);
    }
    if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);
    if (req.headers.get("origin") !== url.origin || !req.headers.get("content-type")?.startsWith("application/json")) {
      return json({ error: "Invalid request origin or format." }, 403);
    }
    const raw = await req.text();
    if (raw.length > 102400) return json({ error: "Photo is too large." }, 413);
    let body;
    try { body = JSON.parse(raw); } catch { return json({ error: "Invalid request." }, 400); }
    if (!body || typeof body !== "object") return json({ error: "Invalid request." }, 400);
    if (body.action === "login") {
      if (typeof body.pin !== "string" || !/^\d{4}$/.test(body.pin)) return json({ error: "Enter four digits." }, 400);
      const { sql } = getDatabase();
      if (!await allowsAttempt(sql, secret, context.ip)) return json({ error: "Too many PIN attempts. Try again in 15 minutes." }, 429);
      if (!same(body.pin, pin)) return json({ error: "That PIN is incorrect." }, 401);
      return json({ ok: true }, 200, [
        cookie("chore-parent", issue(secret, "parent", parentAge), parentAge),
        cookie("chore-family", issue(secret, "family", familyAge), familyAge)
      ]);
    }
    if (body.action === "join") {
      if (!verifies(secret, body.token, "invite")) return json({ error: "This invite link is invalid or expired." }, 403);
      return json({ ok: true }, 200, [cookie("chore-family", issue(secret, "family", familyAge), familyAge)]);
    }
    if (body.action === "logout") return json({ ok: true }, 200, [cookie("chore-parent", "", 0)]);
    if (!family) return json({ error: "Join the household first." }, 401);
    if (body.action === "invite" && parent) return json({ token: issue(secret, "invite", 2 * 60 * 60) });
    if (body.action === "wifi-key" && parent) return json({ key: sign(secret, "oliver-wifi-read-v1") });
    const { sql } = getDatabase();
    if (["push-enable", "push-disable", "push-test"].includes(body.action)) {
      const subscription = cleanSubscription(body.subscription);
      if (!subscription) return json({ error: "This browser’s notification subscription is unsupported." }, 400);
      const serialized = JSON.stringify(subscription);
      const role = parent ? "parent" : "son";
      if (body.action === "push-enable") {
        const rows = await sql`INSERT INTO chore_push_subscriptions (endpoint, role, subscription)
          VALUES (${subscription.endpoint}, ${role}, ${serialized}::jsonb)
          ON CONFLICT (endpoint) DO UPDATE SET role = excluded.role, updated_at = now()
          WHERE chore_push_subscriptions.subscription = excluded.subscription RETURNING role`;
        return rows.length ? json({ ok: true, role }) : json({ error: "Reconnect notifications on this device." }, 409);
      }
      const rows = await sql`SELECT endpoint, subscription FROM chore_push_subscriptions
        WHERE endpoint = ${subscription.endpoint} AND subscription = ${serialized}::jsonb`;
      if (body.action === "push-disable") {
        await sql`DELETE FROM chore_push_subscriptions
          WHERE endpoint = ${subscription.endpoint} AND subscription = ${serialized}::jsonb`;
        return json({ ok: true });
      }
      if (!rows.length) return json({ error: "Enable notifications first." }, 409);
      if (!await deliver(sql, secret, rows[0], { body: "Test notification. Your chore alerts are working." })) {
        return json({ error: "The push service could not accept this test. Try enabling notifications again." }, 502);
      }
      return json({ ok: true });
    }
    const announce = (role, { unlocked, ...message }) => context.waitUntil((async () => {
      if (unlocked) {
        const { group, period, count } = unlocked;
        const approved = await sql`SELECT count(*)::int AS count FROM chore_submissions
          WHERE group_id = ${group} AND period = ${period} AND status = 'approved'`;
        if (approved[0].count !== count) return;
      }
      await notify(sql, secret, role, message);
    })().catch((error) => {
      console.warn("Chore notification failed", error.code || error.name);
    }));
    if (body.action === "submit") return await submit(sql, body, announce);
    if (body.action === "review" && parent) return await review(sql, body, announce);
    return json({ error: "Parent Review Mode is required for this action." }, 403);
  } catch (error) {
    console.error("Chore tracker request failed", error.code || error.name);
    return json({ error: "The tracker could not reach shared storage. Try again shortly." }, 503);
  }
}

export const config = { path: "/api/chores" };
