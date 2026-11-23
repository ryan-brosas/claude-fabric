import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Read } from "../../src/providers/tools/read.ts";

test("byte-limited Read reports only the whole lines it returned", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fabric-read-"));
  try {
    const line = "x".repeat(1000);
    await writeFile(join(dir, "long.txt"), Array(100).fill(line).join("\n"));
    const out = await Read.run({ file_path: "long.txt" }, { cwd: dir });
    const body = Array.from({ length: 50 }, (_, n) => String(n + 1).padStart(6) + "\t" + line).join("\n");
    expect(out).toBe(body + "\n[Showing lines 1-50 of 100. Use offset=51 to continue.]");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

const numbered = (lines: string[], first = 1): string =>
  lines.map((line, n) => String(first + n).padStart(6) + "\t" + line).join("\n");

async function withFile(content: string, check: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "fabric-read-"));
  try {
    await writeFile(join(dir, "file.txt"), content);
    await check(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("like main, an empty file is one numbered empty line", async () => {
  await withFile("", async (cwd) => {
    expect(await Read.run({ file_path: "file.txt" }, { cwd })).toBe("     1\t");
  });
});

test("like main, a trailing newline creates a numbered empty final line", async () => {
  await withFile("first\n", async (cwd) => {
    expect(await Read.run({ file_path: "file.txt" }, { cwd })).toBe("     1\tfirst\n     2\t");
  });
});

test("like main, CRLF lines retain their carriage returns", async () => {
  await withFile("first\r\nsecond\r\n", async (cwd) => {
    expect(await Read.run({ file_path: "file.txt" }, { cwd })).toBe("     1\tfirst\r\n     2\tsecond\r\n     3\t");
  });
});

test("like main, an offset past the end returns an empty string", async () => {
  await withFile("first\nsecond", async (cwd) => {
    expect(await Read.run({ file_path: "file.txt", offset: 3 }, { cwd })).toBe("");
  });
});

test("like main, limit 1.9 reads one line", async () => {
  await withFile("one\ntwo\nthree", async (cwd) => {
    expect(await Read.run({ file_path: "file.txt", limit: 1.9 }, { cwd }))
      .toBe("     1\tone\n[Showing lines 1-1 of 3. Use offset=2 to continue.]");
  });
});

test("a zero limit is clamped to one instead of main's empty page", async () => {
  await withFile("one\ntwo\nthree", async (cwd) => {
    expect(await Read.run({ file_path: "file.txt", limit: 0 }, { cwd }))
      .toBe("     1\tone\n[Showing lines 1-1 of 3. Use offset=2 to continue.]");
  });
});

test("a negative limit is clamped to one instead of main's negative slice", async () => {
  await withFile("one\ntwo\nthree", async (cwd) => {
    expect(await Read.run({ file_path: "file.txt", limit: -1 }, { cwd }))
      .toBe("     1\tone\n[Showing lines 1-1 of 3. Use offset=2 to continue.]");
  });
});

for (const delta of [-1, 0, 1]) {
  test(`Read at ${delta} byte from the byte cap`, async () => {
    const lines = [...Array(25).fill("a".repeat(1960)), "b".repeat(1993 + delta)];
    await withFile(lines.join("\n"), async (cwd) => {
      const out = await Read.run({ file_path: "file.txt" }, { cwd });
      const expected = delta <= 0 ? numbered(lines)
        : numbered(lines.slice(0, 25)) + "\n[Showing lines 1-25 of 26. Use offset=26 to continue.]";
      expect(out).toBe(expected);
      expect(Buffer.byteLength(out)).toBeLessThanOrEqual(50 * 1024);
      if (delta === 0) expect(Buffer.byteLength(out)).toBe(50 * 1024);
    });
  });
}

test("a continuation notice is reserved when the body alone would exactly fill the cap", async () => {
  const lines = [...Array(25).fill("a".repeat(1960)), "b".repeat(1993), "last"];
  await withFile(lines.join("\n"), async (cwd) => {
    const out = await Read.run({ file_path: "file.txt" }, { cwd });
    expect(out).toBe(numbered(lines.slice(0, 25)) + "\n[Showing lines 1-25 of 27. Use offset=26 to continue.]");
    expect(Buffer.byteLength(out)).toBeLessThanOrEqual(50 * 1024);
    expect(await Read.run({ file_path: "file.txt", offset: 26 }, { cwd })).toBe(numbered(lines.slice(25), 26));
  });
});

test("UTF-8 bytes, not UTF-16 characters, decide the boundary", async () => {
  const lines = [...Array(25).fill("a".repeat(1960)), "é".repeat(996) + "a"];
  await withFile(lines.join("\n"), async (cwd) => {
    const exact = await Read.run({ file_path: "file.txt" }, { cwd });
    expect(exact).toBe(numbered(lines));
    expect(Buffer.byteLength(exact)).toBe(50 * 1024);
    await writeFile(join(cwd, "file.txt"), [...lines.slice(0, -1), lines.at(-1) + "😀"].join("\n"));
    const over = await Read.run({ file_path: "file.txt" }, { cwd });
    expect(over).toBe(numbered(lines.slice(0, 25)) + "\n[Showing lines 1-25 of 26. Use offset=26 to continue.]");
    expect(Buffer.byteLength(over)).toBeLessThanOrEqual(50 * 1024);
  });
});

for (const count of [2000, 2001]) {
  test(`Read with ${count} short lines`, async () => {
    const lines = Array(count).fill("short");
    await withFile(lines.join("\n"), async (cwd) => {
      const out = await Read.run({ file_path: "file.txt" }, { cwd });
      const suffix = count === 2000 ? "" : "\n[Showing lines 1-2000 of 2001. Use offset=2001 to continue.]";
      expect(out).toBe(numbered(lines.slice(0, 2000)) + suffix);
    });
  });
}

test("multiple overlong lines stay on one page and keep their cut markers", async () => {
  const lines = ["x".repeat(50 * 1024 + 1), "y".repeat(2001), "z".repeat(1999) + "😀" + "end", "tail"];
  await withFile(lines.join("\n"), async (cwd) => {
    const out = await Read.run({ file_path: "file.txt" }, { cwd });
    expect(out.split("\n")).toHaveLength(4);
    expect(out).toBe(numbered(["x".repeat(2000) + "…", "y".repeat(2000) + "…", "z".repeat(1999) + "…", "tail"]));
    expect(out).not.toContain("\uFFFD");
    expect(Buffer.byteLength(out)).toBeLessThanOrEqual(50 * 1024);
  });
});

test("byte-limited pages count cut lines before giving the next offset", async () => {
  const lines = Array(30).fill("a".repeat(2001));
  const cut = "a".repeat(2000) + "…";
  await withFile(lines.join("\n"), async (cwd) => {
    const first = await Read.run({ file_path: "file.txt" }, { cwd });
    expect(first).toBe(numbered(Array(25).fill(cut)) + "\n[Showing lines 1-25 of 30. Use offset=26 to continue.]");
    expect(Buffer.byteLength(first)).toBeLessThanOrEqual(50 * 1024);
    expect(await Read.run({ file_path: "file.txt", offset: 26 }, { cwd })).toBe(numbered(Array(5).fill(cut), 26));
  });
});

test("offset and limit set the lines and the next offset", async () => {
  await withFile(["one", "two", "three", "four", "five"].join("\n"), async (cwd) => {
    expect(await Read.run({ file_path: "file.txt", offset: 2, limit: 2 }, { cwd }))
      .toBe("     2\ttwo\n     3\tthree\n[Showing lines 2-3 of 5. Use offset=4 to continue.]");
  });
});

test("following byte-limited offsets rebuilds every long line exactly once", async () => {
  const lines = Array.from({ length: 2100 }, (_, n) => String(n).padStart(4, "0") + "x".repeat(996));
  await withFile(lines.join("\n"), async (cwd) => {
    const rebuilt: string[] = [];
    let offset = 1;
    for (;;) {
      const out = await Read.run({ file_path: "file.txt", offset }, { cwd });
      expect(Buffer.byteLength(out)).toBeLessThanOrEqual(50 * 1024);
      const match = /\n\[Showing lines (\d+)-(\d+) of (\d+)\. Use offset=(\d+) to continue\.\]$/.exec(out);
      const body = match ? out.slice(0, match.index) : out;
      const page = body.split("\n");
      for (const [n, line] of page.entries()) {
        expect(line.slice(0, 7)).toBe(String(offset + n).padStart(6) + "\t");
        rebuilt.push(line.slice(7));
      }
      if (!match) break;
      expect(Number(match[1])).toBe(offset);
      expect(Number(match[2])).toBe(offset + page.length - 1);
      expect(Number(match[3])).toBe(lines.length);
      expect(Number(match[4])).toBe(offset + page.length);
      offset = Number(match[4]);
    }
    expect(rebuilt.join("\n")).toBe(lines.join("\n"));
  });
});
