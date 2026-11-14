import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { getDatabase } from "@netlify/database";

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
      (SELECT coalesce(sum(earned), 0)::integer FROM chore_submissions) AS earned
  `;
  const tasks = { daily: {}, weekly: {}, extra: {} };
  for (const row of rows[0].tasks) {
    tasks[row.group_id][row.chore_id] = {
      id: row.id, status: row.status, note: row.note,
      photo: "/api/chores?photo=" + row.id
    };
  }
  return json({ periods: current, tasks, earned: rows[0].earned, parent });
}

async function submit(sql, body) {
  const { group, chore, period, photo } = body;
  if (!Object.hasOwn(groups, group) || !groups[group].includes(chore)) return json({ error: "Unknown chore." }, 400);
  if (period !== periods()[group]) return json({ error: "A new chore period started. Refresh and attach your photo again." }, 409);
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
      RETURNING id
    `;
  } catch (error) {
    if (error.code !== "23505") throw error;
  }
  return rows?.length ? json({ ok: true }) : json({ error: "This chore already has a submission awaiting review or an approval." }, 409);
}

async function review(sql, body) {
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
    RETURNING id
  `;
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
    if (body.action === "submit") return await submit(getDatabase().sql, body);
    if (body.action === "review" && parent) return await review(getDatabase().sql, body);
    return json({ error: "Parent Review Mode is required for this action." }, 403);
  } catch (error) {
    console.error("Chore tracker request failed", error.code || error.name);
    return json({ error: "The tracker could not reach shared storage. Try again shortly." }, 503);
  }
}

export const config = { path: "/api/chores" };
