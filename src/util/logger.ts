const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const GRAY = "\x1b[90m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const MAGENTA = "\x1b[35m";
const BLUE = "\x1b[34m";

function color(code: string, text: string): string {
  return `${code}${text}${RESET}`;
}

function timestamp(): string {
  return color(GRAY, new Date().toISOString().slice(11, 23));
}

export function colorMethod(method: string): string {
  switch (method) {
    case "GET":
      return color(BLUE, method);
    case "POST":
      return color(GREEN, method);
    case "PUT":
    case "PATCH":
      return color(YELLOW, method);
    case "DELETE":
      return color(RED, method);
    default:
      return color(CYAN, method);
  }
}

export function colorStatus(status: number): string {
  if (status >= 500) return color(RED + BOLD, String(status));
  if (status >= 400) return color(YELLOW, String(status));
  if (status >= 300) return color(CYAN, String(status));
  return color(GREEN, String(status));
}

export function colorDuration(ms: number): string {
  if (ms >= 1000) return color(RED, `${ms}ms`);
  if (ms >= 300) return color(YELLOW, `${ms}ms`);
  return color(GRAY, `${ms}ms`);
}

export const logger = {
  request(method: string, url: string): void {
    console.log(`${timestamp()} ${color(GRAY, "→")} ${colorMethod(method)} ${url}`);
  },
  response(method: string, url: string, status: number, ms: number): void {
    console.log(
      `${timestamp()} ${color(GRAY, "←")} ${colorMethod(method)} ${url} ` +
        `${colorStatus(status)} ${colorDuration(ms)}`,
    );
  },
  info(message: string): void {
    console.log(`${timestamp()} ${color(GREEN + BOLD, "INFO")}  ${message}`);
  },
  warn(message: string): void {
    console.warn(`${timestamp()} ${color(YELLOW + BOLD, "WARN")}  ${message}`);
  },
  error(message: string, err?: unknown): void {
    console.error(`${timestamp()} ${color(RED + BOLD, "ERROR")} ${message}`);
    if (err !== undefined) console.error(color(DIM, String(err instanceof Error ? err.stack ?? err.message : err)));
  },
};

export function highlightId(id: number | string): string {
  return color(MAGENTA + BOLD, String(id));
}

export function formatIdList(ids: number[], cap = 5): string {
  const shown = ids.slice(0, cap).map(highlightId);
  const suffix = ids.length > cap ? color(DIM, `, …+${ids.length - cap} more`) : "";
  return `${color(GRAY, "[")}${shown.join(color(GRAY, ", "))}${suffix}${color(GRAY, "]")}`;
}
