import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "..");
const cliPath = path.join(repoRoot, "bin", "planpub.js");

test("CLI scopes edit tokens to API base URLs", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "planpub-cli-scope-"));
  const htmlFile = path.join(home, "plan.html");
  fs.writeFileSync(htmlFile, "<!doctype html><title>Scoped token</title><h1>Plan</h1>");
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  let bodyA;
  const serverA = await mockServer(async (req, res) => {
    bodyA = await jsonBody(req);
    sendJson(res, 201, { ok: true, draftId: "aaaaaaaaaaaa", versionNumber: 1, publicUrl: "https://a.example/d/aaaaaaaaaaaa", editToken: "plan_edit_server_a" });
  });
  t.after(() => serverA.close());
  const first = await runCli(["upload", htmlFile, "--api-url", serverA.url], home);
  assert.equal(first.code, 0, first.stderr);
  assert.equal(bodyA.editToken, undefined);

  let bodyB;
  const serverB = await mockServer(async (req, res) => {
    bodyB = await jsonBody(req);
    sendJson(res, 201, { ok: true, draftId: "bbbbbbbbbbbb", versionNumber: 1, publicUrl: "https://b.example/d/bbbbbbbbbbbb", editToken: "plan_edit_server_b" });
  });
  t.after(() => serverB.close());
  const second = await runCli(["upload", htmlFile, "--api-url", serverB.url], home);
  assert.equal(second.code, 0, second.stderr);
  assert.equal(bodyB.draftId, null);
  assert.equal(bodyB.editToken, undefined);

  const state = JSON.parse(fs.readFileSync(path.join(home, "drafts.json"), "utf8"));
  assert.equal(Object.keys(state.files).length, 2);
  assert.equal(Object.keys(state.drafts).length, 2);
  assert.equal(fs.statSync(path.join(home, "drafts.json")).mode & 0o777, 0o600);
});

test("CLI refuses redirects instead of forwarding an edit token", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "planpub-cli-redirect-"));
  const htmlFile = path.join(home, "plan.html");
  fs.writeFileSync(htmlFile, "<!doctype html><title>Redirect token</title><h1>Plan</h1>");
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  let sinkRequests = 0;
  const sink = await mockServer(async (req, res) => { sinkRequests += 1; await jsonBody(req); sendJson(res, 200, { ok: true }); });
  t.after(() => sink.close());

  let mode = "create";
  const origin = await mockServer(async (req, res) => {
    if (mode === "redirect") {
      res.writeHead(307, { Location: `${sink.url}/capture` });
      return res.end();
    }
    await jsonBody(req);
    sendJson(res, 201, { ok: true, draftId: "cccccccccccc", versionNumber: 1, publicUrl: "https://c.example/d/cccccccccccc", editToken: "plan_edit_server_c" });
  });
  t.after(() => origin.close());

  assert.equal((await runCli(["upload", htmlFile, "--api-url", origin.url], home)).code, 0);
  mode = "redirect";
  const redirected = await runCli(["upload", htmlFile, "--api-url", origin.url], home);
  assert.equal(redirected.code, 1);
  assert.match(redirected.stderr, /Refusing to forward a draft edit token/);
  assert.equal(sinkRequests, 0);
});

test("CLI fails closed when local token state is corrupted", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "planpub-cli-corrupt-"));
  const htmlFile = path.join(home, "plan.html");
  fs.writeFileSync(htmlFile, "<!doctype html><title>Corrupt state</title>");
  fs.writeFileSync(path.join(home, "drafts.json"), "{not-json", { mode: 0o600 });
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const result = await runCli(["upload", htmlFile, "--api-url", "http://127.0.0.1:9"], home);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Cannot read .*drafts\.json/);
});

function runCli(args, home) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: repoRoot,
      env: { ...process.env, PLANPUB_HOME: home },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function mockServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => handler(req, res).catch((error) => { res.statusCode = 500; res.end(error.message); }));
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise((done) => server.close(done)) });
    });
  });
}

async function jsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}
