import { describe, expect, it } from "vitest";

import {
  BoundedTextBuffer,
  takeLeadingCodePoints,
} from "../src/bounded-text.ts";
import { isWellFormed } from "./fixtures/well-formed.ts";

const TWO = "é"; // 2 bytes
const THREE = "中"; // 3 bytes
const FOUR = "\u{1F600}"; // 4 bytes, one surrogate pair

function bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

describe("takeLeadingCodePoints", () => {
  it("counts UTF-8 bytes by default and drops a straddling code point", () => {
    const text = `a${THREE}${FOUR}b`; // 1 + 3 + 4 + 1 bytes
    expect(takeLeadingCodePoints(text, 4)).toEqual({
      text: `a${THREE}`,
      size: 4,
    });
    expect(takeLeadingCodePoints(text, 7)).toEqual({
      text: `a${THREE}`,
      size: 4,
    });
    expect(takeLeadingCodePoints(text, 8)).toEqual({
      text: `a${THREE}${FOUR}`,
      size: 8,
    });
  });

  it("counts UTF-16 units when asked and never splits a surrogate pair", () => {
    const text = `a${THREE}${FOUR}b`; // 1 + 1 + 2 + 1 units
    expect(takeLeadingCodePoints(text, 2, "utf16")).toEqual({
      text: `a${THREE}`,
      size: 2,
    });
    expect(takeLeadingCodePoints(text, 3, "utf16")).toEqual({
      text: `a${THREE}`,
      size: 2,
    });
    expect(takeLeadingCodePoints(text, 4, "utf16")).toEqual({
      text: `a${THREE}${FOUR}`,
      size: 4,
    });
  });

  it("the two units disagree on multi-byte BMP text", () => {
    const text = TWO.repeat(10); // 10 units, 20 bytes
    expect(takeLeadingCodePoints(text, 10)).toEqual({
      text: TWO.repeat(5),
      size: 10,
    });
    expect(takeLeadingCodePoints(text, 10, "utf16")).toEqual({
      text,
      size: 10,
    });
  });

  it("a zero limit takes nothing, in either unit", () => {
    expect(takeLeadingCodePoints(`${FOUR}a`, 0)).toEqual({ text: "", size: 0 });
    expect(takeLeadingCodePoints(`${FOUR}a`, 0, "utf16")).toEqual({
      text: "",
      size: 0,
    });
    expect(takeLeadingCodePoints("", 8)).toEqual({ text: "", size: 0 });
  });

  it("a limit past the end returns the whole text with its size", () => {
    const text = `x${FOUR}${TWO}`;
    expect(takeLeadingCodePoints(text, 1_000)).toEqual({
      text,
      size: bytes(text),
    });
    expect(takeLeadingCodePoints(text, 1_000, "utf16")).toEqual({
      text,
      size: text.length,
    });
  });

  it("the reported size measures the returned text in the requested unit", () => {
    const text = `${THREE}${FOUR}${TWO}abc`; // 13 bytes, 7 units
    for (let limit = 0; limit <= 14; limit += 1) {
      const utf8 = takeLeadingCodePoints(text, limit);
      expect(utf8.size).toBe(bytes(utf8.text));
      expect(utf8.size).toBeLessThanOrEqual(limit);
      expect(isWellFormed(utf8.text)).toBe(true);
      expect(text.startsWith(utf8.text)).toBe(true);

      const utf16 = takeLeadingCodePoints(text, limit, "utf16");
      expect(utf16.size).toBe(utf16.text.length);
      expect(utf16.size).toBeLessThanOrEqual(limit);
      expect(isWellFormed(utf16.text)).toBe(true);
      expect(text.startsWith(utf16.text)).toBe(true);
    }
  });
});

describe("BoundedTextBuffer append", () => {
  it("starts empty and ignores empty chunks", () => {
    const buffer = new BoundedTextBuffer(8);
    expect(buffer.hasBytes).toBe(false);
    expect(buffer.byteLength).toBe(0);
    buffer.append("");
    expect(buffer.hasBytes).toBe(false);
    expect(buffer.drain(8)).toEqual({
      text: "",
      clipped: false,
      dropped: false,
    });
  });

  it("keeps text within the cap without dropping", () => {
    const buffer = new BoundedTextBuffer(8);
    buffer.append("abc");
    buffer.append(THREE);
    expect(buffer.byteLength).toBe(6);
    expect(buffer.drain(8)).toEqual({
      text: `abc${THREE}`,
      clipped: false,
      dropped: false,
    });
  });

  it("drops the oldest whole code points past the cap and reports byteLength", () => {
    const buffer = new BoundedTextBuffer(7);
    buffer.append(`ab${THREE}${TWO}${FOUR}`); // 1+1+3+2+4 = 11 bytes
    // Removing "ab" (2) then the 3-byte character (5) covers the 4-byte excess.
    expect(buffer.byteLength).toBe(6);
    expect(buffer.drain(64)).toEqual({
      text: `${TWO}${FOUR}`,
      clipped: false,
      dropped: true,
    });
  });

  it("never splits a surrogate pair when dropping", () => {
    const buffer = new BoundedTextBuffer(5);
    buffer.append(`${FOUR}${FOUR}`); // 8 bytes, excess 3 removes one whole pair
    expect(buffer.byteLength).toBe(4);
    const drained = buffer.drain(64);
    expect(drained).toEqual({ text: FOUR, clipped: false, dropped: true });
    expect(drained.text).not.toContain("�");
  });

  it.each<[number, string]>([
    [0, "a"],
    [0, THREE],
    [1, THREE],
    [1, FOUR],
    [3, FOUR],
  ])(
    "cap %i with a code point larger than the cap ends empty and dropped",
    (cap, codePoint) => {
      const buffer = new BoundedTextBuffer(cap);
      buffer.append(codePoint);
      expect(buffer.hasBytes).toBe(false);
      expect(buffer.byteLength).toBe(0);
      expect(buffer.drain(64)).toEqual({
        text: "",
        clipped: false,
        dropped: true,
      });
    },
  );

  it("keeps exactly one code point when the cap fits it", () => {
    const buffer = new BoundedTextBuffer(3);
    buffer.append(`${THREE}${THREE}`);
    expect(buffer.byteLength).toBe(3);
    expect(buffer.drain(3)).toEqual({
      text: THREE,
      clipped: false,
      dropped: true,
    });
  });
});

describe("BoundedTextBuffer drain", () => {
  it("takes everything when the budget covers the buffer", () => {
    const buffer = new BoundedTextBuffer(64);
    buffer.append("hello");
    expect(buffer.drain(5)).toEqual({
      text: "hello",
      clipped: false,
      dropped: false,
    });
    expect(buffer.hasBytes).toBe(false);
  });

  it("clips to leading whole code points and keeps the remainder in order", () => {
    const buffer = new BoundedTextBuffer(64);
    buffer.append(`a${THREE}b${FOUR}c`); // 1+3+1+4+1
    expect(buffer.drain(5)).toEqual({
      text: `a${THREE}b`,
      clipped: true,
      dropped: false,
    });
    expect(buffer.byteLength).toBe(5);
    expect(buffer.drain(4)).toEqual({
      text: FOUR,
      clipped: true,
      dropped: false,
    });
    expect(buffer.drain(4)).toEqual({
      text: "c",
      clipped: false,
      dropped: false,
    });
  });

  it("drain(0) returns empty clipped text and consumes nothing", () => {
    const buffer = new BoundedTextBuffer(64);
    buffer.append("xy");
    expect(buffer.drain(0)).toEqual({
      text: "",
      clipped: true,
      dropped: false,
    });
    expect(buffer.byteLength).toBe(2);
    expect(buffer.drain(2)).toEqual({
      text: "xy",
      clipped: false,
      dropped: false,
    });
  });

  it("a budget below the first code point returns empty clipped text", () => {
    const buffer = new BoundedTextBuffer(64);
    buffer.append(`${FOUR}a`);
    expect(buffer.drain(3)).toEqual({
      text: "",
      clipped: true,
      dropped: false,
    });
    expect(buffer.byteLength).toBe(5);
    expect(buffer.drain(4)).toEqual({
      text: FOUR,
      clipped: true,
      dropped: false,
    });
  });

  it("drain on an empty buffer still resets the dropped flag", () => {
    const buffer = new BoundedTextBuffer(1);
    buffer.append("ab");
    buffer.drain(0);
    expect(buffer.drain(0)).toEqual({
      text: "",
      clipped: true,
      dropped: false,
    });
    buffer.drain(64);
    buffer.markDropped();
    expect(buffer.drain(64)).toEqual({
      text: "",
      clipped: false,
      dropped: true,
    });
    expect(buffer.drain(64)).toEqual({
      text: "",
      clipped: false,
      dropped: false,
    });
  });

  it("dropped is sticky across appends until one drain", () => {
    const buffer = new BoundedTextBuffer(2);
    buffer.append("abc");
    buffer.append("d");
    buffer.append("");
    expect(buffer.drain(1)).toEqual({
      text: "c",
      clipped: true,
      dropped: true,
    });
    expect(buffer.drain(1)).toEqual({
      text: "d",
      clipped: false,
      dropped: false,
    });
  });

  it("markDropped records producer-side loss without appending", () => {
    const buffer = new BoundedTextBuffer(64);
    buffer.markDropped();
    expect(buffer.hasBytes).toBe(false);
    expect(buffer.drain(64)).toEqual({
      text: "",
      clipped: false,
      dropped: true,
    });
    buffer.append("later");
    expect(buffer.drain(64)).toEqual({
      text: "later",
      clipped: false,
      dropped: false,
    });
  });

  it("reports byteLength after mixed appends and drains", () => {
    const buffer = new BoundedTextBuffer(10);
    buffer.append(`${THREE}${TWO}`);
    expect(buffer.byteLength).toBe(5);
    buffer.append("abcdef"); // 11 bytes, excess 1 drops the 3-byte character
    expect(buffer.byteLength).toBe(8);
    buffer.drain(2);
    expect(buffer.byteLength).toBe(6);
    expect(bytes(buffer.drain(64).text)).toBe(6);
    expect(buffer.byteLength).toBe(0);
  });
});
