import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { validateHtml } from "../src/html-policy.js";

test("HTML policy permits static documents and rejects active content", () => {
  assert.equal(validateHtml("<!doctype html><title>Safe</title><style>body{color:red}</style><img src='https://example.com/x.png'>").ok, true);
  for (const html of [
    "<title>x</title><form></form>",
    "<title>x</title><iframe src='https://example.com'></iframe>",
    "<title>x</title><script src='https://example.com/x.js'></script>",
    "<title>x</title><img src=x onerror=alert(1)>",
    "<title>x</title><a href='java\nscript:alert(1)'>x</a>",
    "<title>x</title><meta http-equiv='refresh' content='0;url=https://example.com'>"
  ]) assert.equal(validateHtml(html).ok, false, html);
});

test("anonymous create uses an edit secret, versions are immutable, and CSP blocks scripts", async (t) => {
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "planpub-test-"));
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["src/server.js"], {
    cwd: path.resolve(import.meta.dirname, ".."),
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, PUBLIC_BASE_URL: base },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  t.after(() => { child.kill("SIGTERM"); fs.rmSync(dataDir, { recursive: true, force: true }); });
  await waitForHealth(base, child, () => stderr);

  const html1 = "<!doctype html><html><head><title>Version one</title><script>globalThis.pwned=true</script></head><body><h1>One</h1></body></html>";
  const created = await requestJson(`${base}/api/uploads`, { html: html1, filename: "plan.html", description: "Test plan" });
  assert.equal(created.response.status, 201);
  assert.match(created.body.draftId, /^[a-z0-9]{12}$/);
  assert.match(created.body.editToken, /^plan_edit_/);
  assert.equal(created.body.versionNumber, 1);

  const current = await fetch(created.body.publicUrl);
  assert.equal(current.status, 200);
  assert.equal(await current.text(), html1);
  assert.match(current.headers.get("content-security-policy"), /script-src 'none'/);
  assert.equal(current.headers.get("x-plan-draft-version"), "1");

  const forbidden = await requestJson(`${base}/api/uploads`, { html: "<title>Attack</title>", filename: "plan.html", draftId: created.body.draftId, editToken: "plan_edit_wrong" });
  assert.equal(forbidden.response.status, 403);

  const html2 = "<!doctype html><title>Version two</title><h1>Two</h1>";
  const updated = await requestJson(`${base}/api/uploads`, { html: html2, filename: "plan.html", draftId: created.body.draftId, editToken: created.body.editToken });
  assert.equal(updated.response.status, 200);
  assert.equal(updated.body.versionNumber, 2);
  assert.equal("editToken" in updated.body, false);
  assert.equal(await (await fetch(created.body.publicUrl)).text(), html2);
  assert.equal(await (await fetch(`${created.body.publicUrl}/v/1`)).text(), html1);

  const blocked = await requestJson(`${base}/api/uploads`, { html: "<title>Bad</title><form action='/steal'></form>", filename: "bad.html" });
  assert.equal(blocked.response.status, 422);
  assert.match(blocked.body.errors.join(" "), /Blocked <form>/);

  const metadata = await (await fetch(`${base}/api/drafts/${created.body.draftId}`)).json();
  assert.equal(metadata.draft.currentVersion, 2);
  assert.deepEqual(metadata.draft.versions.map((v) => v.versionNumber), [2, 1]);
  assert.equal(JSON.stringify(metadata).includes(created.body.editToken), false);
});

async function requestJson(url, payload) {
  const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  return { response, body: await response.json() };
}
function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => { const { port } = server.address(); server.close(() => resolve(port)); });
    server.on("error", reject);
  });
}
async function waitForHealth(base, child, getStderr) {
  for (let i = 0; i < 60; i += 1) {
    if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}: ${getStderr()}`);
    try { const response = await fetch(`${base}/healthz`); if (response.ok) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`server did not become ready: ${getStderr()}`);
}
