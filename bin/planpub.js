#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { validateHtml } from "../src/html-policy.js";
import packageJson from "../package.json" with { type: "json" };

const DEFAULT_API_URL = "https://plan.mohtasham.dev";
const stateDir = process.env.PLANPUB_HOME || path.join(os.homedir(), ".planpub");
const configPath = path.join(stateDir, "config.json");
const draftsPath = path.join(stateDir, "drafts.json");
class CliError extends Error {}

const program = new Command();
program.name("planpub").description("Publish static visual plans.").version(packageJson.version);

program.command("upload")
  .argument("<file>", "HTML file path")
  .option("--draft <draft-id>", "Update a specific locally-owned draft")
  .option("--new", "Always create a new draft")
  .option("--description <text>", "Set a short description")
  .option("--api-url <url>", "Override the publishing service URL")
  .action(async (file, options) => {
    const resolvedFile = path.resolve(file);
    if (!fs.existsSync(resolvedFile)) throw new CliError(`File does not exist: ${resolvedFile}`);
    const html = fs.readFileSync(resolvedFile, "utf8");
    const validation = validateHtml(html);
    if (!validation.ok) throw new CliError(`HTML validation failed:\n- ${validation.errors.join("\n- ")}`);

    const drafts = readJson(draftsPath, { files: {}, drafts: {} });
    const known = options.new ? null : drafts.files[resolvedFile];
    const draftId = options.new ? null : options.draft || known?.draftId || null;
    const draftSecret = draftId ? drafts.drafts[draftId] : null;
    if (draftId && !draftSecret?.editToken) throw new CliError(`No local edit token for draft ${draftId}. Create a new draft or restore ~/.planpub/drafts.json.`);

    const apiUrl = resolveApiUrl(options.apiUrl);
    const payload = {
      html,
      filename: path.basename(resolvedFile),
      draftId,
      editToken: draftSecret?.editToken,
      description: options.description,
      metadata: { ...collectGitMetadata(path.dirname(resolvedFile)), ...collectCiMetadata(), cliVersion: packageJson.version, fileSha256: sha256(html) }
    };
    const response = await fetch(`${apiUrl}/api/uploads`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": `planpub/${packageJson.version}` },
      body: JSON.stringify(payload)
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new CliError(`${body.error || "Upload failed."}${body.errors?.length ? `\n- ${body.errors.join("\n- ")}` : ""}`);

    const editToken = body.editToken || draftSecret?.editToken;
    drafts.files[resolvedFile] = { draftId: body.draftId, publicUrl: body.publicUrl, latestVersionNumber: body.versionNumber, updatedAt: new Date().toISOString() };
    drafts.drafts[body.draftId] = { editToken, publicUrl: body.publicUrl, updatedAt: new Date().toISOString() };
    writeJson(draftsPath, drafts);
    console.log(draftId ? "Updated plan" : "Published plan");
    console.log(`URL: ${body.publicUrl}`);
    console.log(`Draft ID: ${body.draftId}`);
    console.log(`Version: ${body.versionNumber}`);
    for (const warning of body.warnings || []) console.warn(`Warning: ${warning}`);
  });

program.command("list")
  .description("List plans known to this machine")
  .option("--json", "Print JSON")
  .action((options) => {
    const drafts = readJson(draftsPath, { files: {} });
    const rows = Object.entries(drafts.files || {}).map(([file, draft]) => ({ file, ...draft }));
    if (options.json) return console.log(JSON.stringify(rows, null, 2));
    if (!rows.length) return console.log("No local plans yet.");
    for (const row of rows) console.log(`${row.publicUrl}  v${row.latestVersionNumber}  ${row.file}`);
  });

program.command("config")
  .option("--api-url <url>", "Set the publishing service URL")
  .action((options) => {
    if (!options.apiUrl) return console.log(`API URL: ${resolveApiUrl()}`);
    writeJson(configPath, { apiUrl: options.apiUrl.replace(/\/+$/, "") });
    console.log("Plan Publisher configuration saved.");
  });

program.exitOverride();
program.parseAsync(process.argv).catch((error) => {
  if (["commander.helpDisplayed", "commander.version"].includes(error.code)) process.exit(0);
  console.error(error.message || error);
  process.exit(1);
});

function resolveApiUrl(override) {
  const config = readJson(configPath, {});
  return (override || process.env.PLANPUB_API_URL || config.apiUrl || DEFAULT_API_URL).replace(/\/+$/, "");
}
function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; } }
function writeJson(file, value) { fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 }); fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 }); fs.chmodSync(file, 0o600); }
function git(args, cwd) { try { return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return null; } }
function collectGitMetadata(cwd) {
  const root = git(["rev-parse", "--show-toplevel"], cwd);
  const remote = git(["config", "--get", "remote.origin.url"], cwd);
  const parsed = parseRemote(remote);
  const status = git(["status", "--porcelain"], cwd);
  return { repoOrg: parsed.org || (root ? path.basename(path.dirname(root)) : null), repoName: parsed.name || (root ? path.basename(root) : null), repoHost: parsed.host || null, gitBranch: git(["rev-parse", "--abbrev-ref", "HEAD"], cwd), gitCommitSha: git(["rev-parse", "HEAD"], cwd), gitCommitSubject: git(["log", "-1", "--format=%s"], cwd), gitDirty: status === null ? null : status.length > 0 };
}
function parseRemote(remote) {
  if (!remote) return {};
  const cleaned = remote.replace(/\.git$/, "");
  const ssh = cleaned.match(/^[^@]+@([^:]+):([^/]+)\/(.+)$/);
  if (ssh) return { host: ssh[1], org: ssh[2], name: path.basename(ssh[3]) };
  try { const url = new URL(cleaned); const parts = url.pathname.split("/").filter(Boolean); return parts.length >= 2 ? { host: url.hostname, org: parts[0], name: parts.at(-1) } : {}; } catch { return {}; }
}
function collectCiMetadata() {
  if (process.env.GITHUB_ACTIONS === "true") return { ciProvider: "github_actions", ciRunUrl: process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID ? `${process.env.GITHUB_SERVER_URL || "https://github.com"}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : null, ciActor: process.env.GITHUB_ACTOR || null };
  return process.env.CI ? { ciProvider: "unknown" } : {};
}
function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
