import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import express from "express";
import { customAlphabet } from "nanoid";
import { validateHtml } from "./html-policy.js";

const port = Number(process.env.PORT || 3000);
const dataDir = path.resolve(process.env.DATA_DIR || ".data");
const htmlDir = path.join(dataDir, "html");
const maxHtmlBytes = Number(process.env.MAX_HTML_BYTES || 512 * 1024);
const publicBaseUrl = (process.env.PUBLIC_BASE_URL || `http://localhost:${port}`).replace(/\/+$/, "");
const draftIdPattern = /^[a-z0-9]{12}$/;
const newDraftId = customAlphabet("abcdefghijklmnopqrstuvwxyz0123456789", 12);

fs.mkdirSync(htmlDir, { recursive: true, mode: 0o700 });
const db = new Database(path.join(dataDir, "plans.sqlite"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.exec(`
  CREATE TABLE IF NOT EXISTS drafts (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT,
    edit_token_hash TEXT NOT NULL,
    current_version INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS versions (
    draft_id TEXT NOT NULL REFERENCES drafts(id),
    version_number INTEGER NOT NULL,
    storage_path TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    file_size INTEGER NOT NULL,
    filename TEXT,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    has_inline_script INTEGER NOT NULL DEFAULT 0,
    external_image_hosts_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    PRIMARY KEY (draft_id, version_number)
  );
  CREATE INDEX IF NOT EXISTS versions_draft_idx ON versions(draft_id);
`);

const app = express();
app.set("trust proxy", process.env.TRUST_PROXY === "1" ? 1 : false);
app.use("/api", express.json({ limit: "700kb" }));
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cache-Control", "no-store");
  next();
});

const uploadBuckets = new Map();
app.post("/api/uploads", uploadRateLimit, async (req, res, next) => {
  try {
    const { html, filename, draftId, editToken, description, metadata = {} } = req.body || {};
    const validation = validateHtml(html, { maxBytes: maxHtmlBytes });
    if (!validation.ok) {
      return res.status(422).json({ ok: false, error: "HTML validation failed.", errors: validation.errors, warnings: validation.warnings });
    }

    const existing = draftId ? getDraft(draftId) : null;
    if (draftId && !existing) return res.status(404).json({ ok: false, error: "Draft not found." });
    if (existing && !validEditToken(editToken, existing.edit_token_hash)) {
      return res.status(403).json({ ok: false, error: "Missing or invalid draft edit token." });
    }

    const id = existing?.id || newUniqueDraftId();
    const createdToken = existing ? null : `plan_edit_${crypto.randomBytes(32).toString("base64url")}`;
    const now = new Date().toISOString();
    const title = validation.title || existing?.title || cleanText(filename, 255) || "Untitled Plan";
    const nextVersion = (existing?.current_version || 0) + 1;
    const digest = sha256(html);
    const relativePath = path.join(id, `${nextVersion}-${digest.slice(0, 12)}.html`);
    const absolutePath = path.join(htmlDir, relativePath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true, mode: 0o700 });
    atomicWrite(absolutePath, html);

    const commit = db.transaction(() => {
      if (!existing) {
        db.prepare(`INSERT INTO drafts (id, title, description, edit_token_hash, current_version, created_at, updated_at)
                    VALUES (?, ?, ?, ?, 0, ?, ?)`)
          .run(id, title, cleanText(description, 1000), sha256(createdToken), now, now);
      }
      db.prepare(`INSERT INTO versions (
          draft_id, version_number, storage_path, sha256, file_size, filename, metadata_json,
          has_inline_script, external_image_hosts_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          id,
          nextVersion,
          relativePath,
          digest,
          Buffer.byteLength(html, "utf8"),
          cleanText(filename, 255),
          JSON.stringify(safeMetadata(metadata)),
          validation.stats.hasInlineScript ? 1 : 0,
          JSON.stringify(validation.stats.externalImageHosts),
          now
        );
      db.prepare(`UPDATE drafts SET title = ?, description = COALESCE(?, description), current_version = ?, updated_at = ? WHERE id = ?`)
        .run(title, cleanText(description, 1000), nextVersion, now, id);
    });

    try {
      commit();
    } catch (error) {
      fs.rmSync(absolutePath, { force: true });
      throw error;
    }

    const body = {
      ok: true,
      draftId: id,
      versionNumber: nextVersion,
      publicUrl: `${publicBaseUrl}/d/${id}`,
      rawUrl: `${publicBaseUrl}/d/${id}/raw`,
      warnings: validation.warnings
    };
    if (createdToken) body.editToken = createdToken;
    res.status(existing ? 200 : 201).json(body);
  } catch (error) {
    next(error);
  }
});

app.get("/healthz", (req, res) => {
  db.prepare("SELECT 1").get();
  res.json({ ok: true });
});

app.get("/api/drafts/:draftId", (req, res) => {
  if (!draftIdPattern.test(req.params.draftId)) return res.status(404).json({ ok: false, error: "Draft not found." });
  const draft = getDraft(req.params.draftId);
  if (!draft) return res.status(404).json({ ok: false, error: "Draft not found." });
  const versions = db.prepare(`SELECT version_number AS versionNumber, sha256, file_size AS fileSize, filename, created_at AS createdAt
                               FROM versions WHERE draft_id = ? ORDER BY version_number DESC`).all(draft.id);
  res.json({
    ok: true,
    draft: {
      id: draft.id,
      title: draft.title,
      description: draft.description,
      currentVersion: draft.current_version,
      createdAt: draft.created_at,
      updatedAt: draft.updated_at,
      publicUrl: `${publicBaseUrl}/d/${draft.id}`,
      versions
    }
  });
});

for (const route of ["/d/:draftId", "/d/:draftId/raw"]) {
  app.get(route, (req, res) => serveDraft(req, res));
}
for (const route of ["/d/:draftId/v/:versionNumber", "/d/:draftId/v/:versionNumber/raw"]) {
  app.get(route, (req, res) => serveDraft(req, res, Number(req.params.versionNumber)));
}

app.get("/", (req, res) => res.type("html").send(renderHome()));
app.use((req, res) => res.status(404).type("html").send(renderNotFound()));
app.use((error, req, res, _next) => {
  console.error(error);
  res.status(500).json({ ok: false, error: "Internal server error." });
});

const server = app.listen(port, "0.0.0.0", () => console.log(`Plan Publisher listening on ${port}`));
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => { db.close(); process.exit(0); }));
}

function serveDraft(req, res, requestedVersion) {
  const id = req.params.draftId;
  if (!draftIdPattern.test(id)) return res.status(404).type("html").send(renderNotFound());
  const draft = getDraft(id);
  if (!draft) return res.status(404).type("html").send(renderNotFound());
  const versionNumber = requestedVersion ?? draft.current_version;
  if (!Number.isInteger(versionNumber) || versionNumber < 1) return res.status(404).type("html").send(renderNotFound());
  const version = db.prepare("SELECT * FROM versions WHERE draft_id = ? AND version_number = ?").get(id, versionNumber);
  if (!version) return res.status(404).type("html").send(renderNotFound());
  const html = fs.readFileSync(path.join(htmlDir, version.storage_path), "utf8");
  res.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src https: data:; connect-src 'none'; media-src 'none'; font-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
  res.setHeader("X-Plan-Draft-Id", id);
  res.setHeader("X-Plan-Draft-Version", String(versionNumber));
  res.setHeader("X-Postplan-Draft-Id", id);
  res.setHeader("X-Postplan-Draft-Version", String(versionNumber));
  res.status(200).type("html").send(html);
}

function getDraft(id) {
  if (!draftIdPattern.test(String(id || ""))) return null;
  return db.prepare("SELECT * FROM drafts WHERE id = ?").get(id) || null;
}

function validEditToken(token, expectedHash) {
  if (typeof token !== "string" || !token.startsWith("plan_edit_")) return false;
  const actual = Buffer.from(sha256(token), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function newUniqueDraftId() {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const id = newDraftId();
    if (!getDraft(id)) return id;
  }
  throw new Error("Could not allocate draft id.");
}

function atomicWrite(destination, content) {
  const temp = `${destination}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temp, content, { mode: 0o600 });
  fs.renameSync(temp, destination);
}

function safeMetadata(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const allowed = ["repoOrg", "repoName", "repoHost", "gitBranch", "gitCommitSha", "gitCommitSubject", "gitDirty", "ciProvider", "ciRunUrl", "ciActor", "cliVersion", "fileSha256"];
  return Object.fromEntries(allowed.filter((key) => ["string", "boolean"].includes(typeof value[key])).map((key) => [key, typeof value[key] === "string" ? value[key].slice(0, 500) : value[key]]));
}

function cleanText(value, maxLength) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maxLength) : null;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function uploadRateLimit(req, res, next) {
  const key = req.ip || "unknown";
  const now = Date.now();
  const current = uploadBuckets.get(key);
  if (!current || current.resetAt <= now) {
    uploadBuckets.set(key, { count: 1, resetAt: now + 60_000 });
    return next();
  }
  current.count += 1;
  if (current.count > Number(process.env.UPLOAD_RATE_LIMIT_MAX || 20)) {
    res.setHeader("Retry-After", String(Math.ceil((current.resetAt - now) / 1000)));
    return res.status(429).json({ ok: false, error: "Upload rate limit exceeded." });
  }
  next();
}

function renderHome() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Plan Publisher</title><style>
:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;background:#090b0f;color:#edf2f7;font:15px/1.55 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.shell{max-width:880px;margin:auto;padding:72px 22px}.eyebrow{color:#f59e0b;font:700 12px/1.2 ui-monospace,monospace;letter-spacing:.12em;text-transform:uppercase}h1{max-width:700px;margin:18px 0 14px;font-size:clamp(40px,8vw,76px);line-height:.98;letter-spacing:-.055em}.lede{max-width:620px;color:#98a2b3;font-size:18px}.grid{display:grid;grid-template-columns:1.1fr .9fr;gap:14px;margin-top:46px}.card{min-width:0;border:1px solid #202630;border-radius:18px;background:#10141b;padding:22px}.card h2{margin:0 0 10px;font-size:16px}.card p,.note{color:#98a2b3}.step{display:flex;gap:12px;margin:16px 0}.n{display:grid;place-items:center;flex:0 0 28px;height:28px;border-radius:50%;background:#2a2010;color:#fbbf24;font:700 12px ui-monospace,monospace}pre{overflow:auto;margin:16px 0 0;padding:15px;border:1px solid #29313d;border-radius:10px;background:#080a0e;color:#d8dee9;font:13px/1.55 ui-monospace,SFMono-Regular,monospace}.pill{display:inline-block;margin:4px 4px 0 0;padding:5px 9px;border:1px solid #29313d;border-radius:99px;color:#c7d0dc;font-size:12px}@media(max-width:680px){.shell{padding-top:44px}.grid{grid-template-columns:1fr}h1{font-size:48px}}
</style></head><body><main class="shell"><div class="eyebrow">plan.mohtasham.dev · static by design</div><h1>Ship the plan.<br>Not the setup.</h1><p class="lede">One HTML file becomes a public, phone-friendly review link. No account required. Every update creates an immutable version.</p><section class="grid"><article class="card"><h2>Publish in one command</h2><pre>npx --yes github:MohtashamMurshid/plan-publisher \\
  upload ./plan.html</pre><p class="note">The draft edit secret stays in <code>~/.planpub/</code>. The public URL cannot overwrite your plan.</p></article><article class="card"><h2>Deliberately constrained</h2><div><span class="pill">inline CSS</span><span class="pill">HTTPS images</span><span class="pill">version history</span></div><div class="step"><span class="n">×</span><div>Scripts, API requests, forms, iframes and redirects are blocked.</div></div><div class="step"><span class="n">✓</span><div>Ideal for plans, architecture briefs, reports and approval pages.</div></div></article></section></main></body></html>`;
}

function renderNotFound() {
  return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Plan not found</title><style>body{margin:0;background:#090b0f;color:#edf2f7;font:16px system-ui;display:grid;place-items:center;min-height:100vh}main{padding:24px;text-align:center}p{color:#98a2b3}</style></head><body><main><h1>Plan not found</h1><p>This draft does not exist.</p></main></body></html>';
}
