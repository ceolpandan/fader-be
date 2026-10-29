import type { StoreSession } from "./types";

/** The pasted text is not a curl command we can use. */
export class InvalidCurlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidCurlError";
  }
}

/** Cookies that carry a login. Searching works without them, so a session never keeps them. */
const LOGIN_COOKIES = new Set(["identity", "js_logged_in"]);

/** Headers the HTTP client sets itself, or that would only make it misread the answer. */
const DROPPED_HEADERS = new Set(["host", "content-length", "connection", "accept-encoding", "transfer-encoding"]);

/** Curl options whose value is not a header, so it must not be read as the URL. */
const OPTIONS_WITH_VALUE = new Set(["-X", "--request", "-d", "--data", "--data-raw", "--data-binary", "-o", "--output", "-e", "--referer", "-x", "--proxy"]);

/**
 * Reads a curl command copied from the browser ("Copy as cURL") into the headers and cookies it
 * sends. The URL must be on `bandcamp.com`; the rest of the command (method, body, flags) is
 * ignored, since a session only supplies headers. `identity` and `js_logged_in` are dropped.
 */
export function parseCurl(text: string, hostSuffix: string): StoreSession {
  const tokens = tokenise(text);
  if (tokens[0] !== "curl") throw new InvalidCurlError("Paste the command as copied from the browser: it must start with curl");

  const headers: Record<string, string> = {};
  const cookies: string[] = [];
  let url: string | undefined;

  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i] ?? "";
    const value = tokens[i + 1];
    if (token === "-H" || token === "--header") {
      i++;
      const at = value?.indexOf(":") ?? -1;
      if (value === undefined || at < 1) continue;
      const name = value.slice(0, at).trim().toLowerCase();
      const headerValue = value.slice(at + 1).trim();
      if (name === "cookie") cookies.push(headerValue);
      else if (!DROPPED_HEADERS.has(name)) headers[name] = headerValue;
    } else if (token === "-b" || token === "--cookie") {
      i++;
      if (value !== undefined) cookies.push(value);
    } else if (token === "-A" || token === "--user-agent") {
      i++;
      if (value !== undefined) headers["user-agent"] = value;
    } else if (token === "--url") {
      i++;
      url = value;
    } else if (OPTIONS_WITH_VALUE.has(token)) {
      i++;
    } else if (!token.startsWith("-")) {
      url ??= token;
    }
  }

  assertHost(url, hostSuffix);
  const cookie = keptCookies(cookies);
  if (cookie) headers["cookie"] = cookie;
  if (Object.keys(headers).length === 0) throw new InvalidCurlError("The curl has no headers to send");
  return { headers };
}

function assertHost(url: string | undefined, hostSuffix: string): void {
  let host: string;
  try {
    host = new URL(url ?? "").hostname;
  } catch {
    throw new InvalidCurlError("The curl has no URL");
  }
  if (host !== hostSuffix && !host.endsWith(`.${hostSuffix}`)) {
    throw new InvalidCurlError(`The curl must be for ${hostSuffix}`);
  }
}

function keptCookies(cookies: string[]): string {
  return cookies
    .flatMap((header) => header.split(";"))
    .map((pair) => pair.trim())
    .filter((pair) => pair && !LOGIN_COOKIES.has((pair.split("=")[0] ?? "").trim()))
    .join("; ");
}

/** Splits a shell command into words: quotes, `$'...'`, backslash escapes and line continuations. */
function tokenise(text: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inToken = false;
  let i = 0;

  const push = (): void => {
    if (inToken) tokens.push(current);
    current = "";
    inToken = false;
  };

  while (i < text.length) {
    const ch = text[i] ?? "";
    if (ch === "\\" && (text[i + 1] === "\n" || (text[i + 1] === "\r" && text[i + 2] === "\n"))) {
      i += text[i + 1] === "\n" ? 2 : 3;
    } else if (/\s/.test(ch)) {
      push();
      i++;
    } else if (ch === "'") {
      const end = text.indexOf("'", i + 1);
      if (end < 0) throw new InvalidCurlError("The curl has an unclosed quote");
      current += text.slice(i + 1, end);
      inToken = true;
      i = end + 1;
    } else if (ch === "$" && text[i + 1] === "'") {
      const [value, next] = readAnsiC(text, i + 2);
      current += value;
      inToken = true;
      i = next;
    } else if (ch === '"') {
      const [value, next] = readDoubleQuoted(text, i + 1);
      current += value;
      inToken = true;
      i = next;
    } else if (ch === "\\" && i + 1 < text.length) {
      current += text[i + 1];
      inToken = true;
      i += 2;
    } else {
      current += ch;
      inToken = true;
      i++;
    }
  }
  push();
  return tokens;
}

function readDoubleQuoted(text: string, from: number): [string, number] {
  let value = "";
  for (let i = from; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') return [value, i + 1];
    if (ch === "\\" && '"\\$`'.includes(text[i + 1] ?? "")) {
      value += text[i + 1];
      i++;
    } else {
      value += ch;
    }
  }
  throw new InvalidCurlError("The curl has an unclosed quote");
}

function readAnsiC(text: string, from: number): [string, number] {
  let value = "";
  for (let i = from; i < text.length; i++) {
    const ch = text[i];
    if (ch === "'") return [value, i + 1];
    if (ch !== "\\") {
      value += ch;
      continue;
    }
    const next = text[++i] ?? "";
    const hex = /^x([0-9a-fA-F]{1,2})/.exec(text.slice(i));
    const unicode = /^u([0-9a-fA-F]{1,4})/.exec(text.slice(i));
    if (hex) {
      value += String.fromCharCode(parseInt(hex[1] ?? "0", 16));
      i += hex[0].length - 1;
    } else if (unicode) {
      value += String.fromCharCode(parseInt(unicode[1] ?? "0", 16));
      i += unicode[0].length - 1;
    } else {
      value += { n: "\n", r: "\r", t: "\t" }[next] ?? next;
    }
  }
  throw new InvalidCurlError("The curl has an unclosed quote");
}
