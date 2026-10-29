import { describe, expect, it } from "vitest";
import { InvalidCurlError, parseCurl } from "./curl";

const CURL = `curl --url 'https://bandcamp.com/search?q=vc-118a%20permutation&item_type=t' \\
  -H 'accept: text/html,application/xhtml+xml' \\
  -H 'accept-encoding: gzip, deflate, br' \\
  -b 'cart_client_id=ABC; identity=7%09secret; js_logged_in=1; __stripe_sid=sid; BACKENDID3=flexo' \\
  -H 'sec-ch-ua: "Not:A-Brand";v="8", "Chromium";v="156"' \\
  -H 'user-agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64)'`;

describe("parseCurl", () => {
  it("reads headers", () => {
    const { headers } = parseCurl(CURL, "bandcamp.com");
    expect(headers["accept"]).toBe("text/html,application/xhtml+xml");
    expect(headers["sec-ch-ua"]).toBe('"Not:A-Brand";v="8", "Chromium";v="156"');
    expect(headers["user-agent"]).toBe("Mozilla/5.0 (Windows NT 10.0; Win64; x64)");
  });

  it("drops the login cookies and keeps the rest", () => {
    const { headers } = parseCurl(CURL, "bandcamp.com");
    expect(headers["cookie"]).toBe("cart_client_id=ABC; __stripe_sid=sid; BACKENDID3=flexo");
  });

  it("drops headers the HTTP client sets itself", () => {
    expect(parseCurl(CURL, "bandcamp.com").headers).not.toHaveProperty("accept-encoding");
  });

  it("reads a cookie header and Windows line breaks", () => {
    const { headers } = parseCurl(
      "curl 'https://bandcamp.com/search?q=a' \\\r\n  -H 'cookie: identity=x; keep=1' \\\r\n  -H 'accept: */*'",
      "bandcamp.com",
    );
    expect(headers["cookie"]).toBe("keep=1");
  });

  it("reads $'...' quoting", () => {
    const { headers } = parseCurl("curl 'https://bandcamp.com/' -H $'x-note: it\\'s fine'", "bandcamp.com");
    expect(headers["x-note"]).toBe("it's fine");
  });

  it("rejects text that is not curl", () => {
    expect(() => parseCurl("wget https://bandcamp.com", "bandcamp.com")).toThrow(InvalidCurlError);
  });

  it("rejects a curl for another site", () => {
    expect(() => parseCurl("curl 'https://example.com/' -H 'accept: */*'", "bandcamp.com")).toThrow(/bandcamp\.com/);
  });

  it("rejects a curl for a look-alike host", () => {
    expect(() => parseCurl("curl 'https://notbandcamp.com/' -H 'accept: */*'", "bandcamp.com")).toThrow(InvalidCurlError);
  });

  it("rejects a curl with an unclosed quote", () => {
    expect(() => parseCurl("curl 'https://bandcamp.com/ -H 'a: b'", "bandcamp.com")).toThrow(InvalidCurlError);
  });

  it("rejects a curl with no headers", () => {
    expect(() => parseCurl("curl 'https://bandcamp.com/'", "bandcamp.com")).toThrow(/no headers/);
  });
});
