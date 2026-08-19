import * as parse5 from "parse5";

const BLOCKED_TAGS = new Set(["form", "iframe", "frame", "frameset", "object", "embed", "applet", "base", "link"]);
const URL_ATTRS = new Set(["href", "src", "action", "formaction", "poster", "srcdoc", "xlink:href"]);
const BLOCKED_PROTOCOLS = ["javascript:", "vbscript:", "file:"];
const ALLOWED_SCRIPT_TYPES = new Set(["", "text/javascript", "application/javascript"]);
const MAX_DEPTH = 512;

export function validateHtml(html, { maxBytes = 512 * 1024 } = {}) {
  const errors = [];
  const warnings = [];
  if (typeof html !== "string" || html.trim() === "") {
    return result(["HTML document is empty."], warnings, null, false, []);
  }
  const bytes = Buffer.byteLength(html, "utf8");
  if (bytes > maxBytes) errors.push(`HTML document is ${bytes} bytes; maximum is ${maxBytes} bytes.`);

  let document;
  try {
    document = parse5.parse(html, { scriptingEnabled: false });
  } catch {
    return result(["HTML document could not be parsed."], warnings, null, false, []);
  }

  let title = null;
  let hasInlineScript = false;
  let tooDeep = false;
  const externalImageHosts = new Set();
  const stack = [{ node: document, depth: 0 }];

  while (stack.length) {
    const { node, depth } = stack.pop();
    if (node.tagName) {
      const tag = node.tagName.toLowerCase();
      if (BLOCKED_TAGS.has(tag)) errors.push(`Blocked <${tag}> tag found.`);
      const attrs = new Map((node.attrs || []).map((attr) => [attr.name.toLowerCase(), String(attr.value || "").trim()]));
      if (tag === "script") {
        hasInlineScript = true;
        if (attrs.has("src")) errors.push("External script sources are not allowed.");
        const scriptType = (attrs.get("type") || "").toLowerCase();
        if (!ALLOWED_SCRIPT_TYPES.has(scriptType)) errors.push(`Unsupported script type "${scriptType}" found.`);
      }
      for (const [name, value] of attrs) {
        if (name.startsWith("on")) errors.push(`Blocked inline event handler attribute "${name}" found.`);
        if (name === "srcdoc") errors.push('Blocked "srcdoc" attribute found.');
        if (URL_ATTRS.has(name)) {
          const normalized = value.replace(/[\u0000-\u0020]+/g, "").toLowerCase();
          if (BLOCKED_PROTOCOLS.some((protocol) => normalized.startsWith(protocol))) {
            errors.push(`Blocked unsafe URL in "${name}" attribute.`);
          }
        }
        if (name === "style" && /expression\s*\(|behavior\s*:|url\s*\(\s*javascript:/i.test(value)) {
          errors.push("Blocked unsafe inline CSS.");
        }
      }
      if (tag === "meta" && (attrs.get("http-equiv") || "").toLowerCase() === "refresh") {
        errors.push("Blocked meta refresh tag found.");
      }
      if (tag === "img") {
        const host = externalHost(attrs.get("src"));
        if (host) externalImageHosts.add(host);
      }
      if (tag === "title" && !title) title = collectText(node).trim().slice(0, 140) || null;
    }
    if (depth >= MAX_DEPTH) {
      tooDeep = true;
      continue;
    }
    for (const child of [...(node.childNodes || [])].reverse()) stack.push({ node: child, depth: depth + 1 });
  }

  if (tooDeep) errors.push(`HTML is nested more than ${MAX_DEPTH} levels deep.`);
  if (!title) warnings.push("No <title> found; the filename will be used.");
  return result(errors, warnings, title, hasInlineScript, [...externalImageHosts].sort());
}

function result(errors, warnings, title, hasInlineScript, externalImageHosts) {
  return {
    ok: errors.length === 0,
    errors: [...new Set(errors)],
    warnings: [...new Set(warnings)],
    title,
    stats: { hasInlineScript, externalImageHosts }
  };
}

function externalHost(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  try {
    const url = new URL(raw.startsWith("//") ? `https:${raw}` : raw);
    return ["http:", "https:"].includes(url.protocol) ? url.hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}

function collectText(node) {
  let value = "";
  for (const child of node.childNodes || []) {
    if (child.nodeName === "#text") value += child.value || "";
    value += collectText(child);
  }
  return value;
}
