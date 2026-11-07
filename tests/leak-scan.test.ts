import { describe, expect, it } from "vitest";
import { scanForLeaks } from "./live/leak-scan.js";

const kinds = (text: string) => scanForLeaks(text).map((f) => f.kind).sort();

describe("scanForLeaks", () => {
  it("finds a feed scheme, a query string, a token path, a jwt, a bearer header and a bare token", () => {
    expect(kinds("source: webcal://p1.example.com/published/abc")).toEqual(["feed-scheme"]);
    expect(kinds("image: https://media.example.com/a.jpg?sig=zzz")).toEqual(["url-with-query"]);
    expect(kinds("link: https://x.example.com/cal/Ab3dEf6hIj9lMn2pQr5tUv8")).toEqual(["url-token-path"]);
    expect(kinds("t: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sig")).toEqual(["jwt-like"]);
    expect(kinds("Authorization: Bearer abc")).toEqual(["bearer-header"]);
    expect(kinds("id: Ab3dEf6hIj9lMn2pQr5tUv8Ab3dEf6hIj9lMn2pQr5")).toEqual(["bare-token"]);
  });

  it("ignores the stock avatar CDN without a query, but not with one", () => {
    expect(kinds("image: https://skylight-frame-res.cloudinary.com/image/upload/v1/avatars/avatar_cat.png")).toEqual([]);
    // A long token-like path segment would be flagged anywhere else; on the stock host it is allowed.
    expect(kinds("image: https://skylight-frame-res.cloudinary.com/image/upload/Ab3dEf6hIj9lMn2pQr5tUv8")).toEqual([]);
    expect(kinds("image: https://other.example.com/image/upload/Ab3dEf6hIj9lMn2pQr5tUv8")).toEqual(["url-token-path"]);
    expect(kinds("image: https://skylight-frame-res.cloudinary.com/image/upload/v1/a.png?sig=1")).toEqual(["url-with-query"]);
  });

  it("ignores links in text a person wrote", () => {
    expect(kinds("  description: Join https://meet.example.com/room/Ab3dEf6hIj9lMn2pQr5tUv8?pwd=1")).toEqual([]);
    expect(kinds("  Location: https://maps.example.com/p?q=1")).toEqual([]);
  });

  it("does not flag ordinary output", () => {
    expect(kinds("id: 123456\nname: Dinner\ndate: 2026-11-06\ncolor: #aabbcc\nhttps://example.com/recipes/pasta")).toEqual([]);
  });

  it("counts repeats", () => {
    const f = scanForLeaks("a: webcal://x.example.com/1\nb: webcals://y.example.com/2");
    expect(f).toEqual([{ kind: "feed-scheme", count: 2 }]);
  });

  it("never returns any input text", () => {
    const marker = "MARKERVALUE9x8y7z6w5v4u3t2s1r0q";
    const out = JSON.stringify(scanForLeaks(`feed: webcal://p1.example.com/${marker}\nk: https://a.example.com/x?t=${marker}`));
    expect(out).not.toContain("MARKERVALUE");
    expect(out).not.toContain("example.com");
  });
});
