import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * This repository is public and English-only. The scan covers every file git tracks (or would
 * track), so a stray comment, test name or log line in another script is caught before it ships.
 */
function repositoryFiles(): string[] {
  const output = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { encoding: "utf8" });
  return output.split("\n").filter(Boolean);
}

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Bopomofo}]/u;

describe("repository hygiene", () => {
  it("contains no CJK characters", () => {
    const files = repositoryFiles();
    // Proof the scan actually read the repository, so it cannot pass by reading nothing.
    expect(files).toContain("README.md");
    expect(files.length).toBeGreaterThan(20);
    const offenders = files.filter((file) => CJK.test(readFileSync(file, "utf8")));
    expect(offenders).toEqual([]);
  });

  it("the CJK check would catch a stray character", () => {
    expect(CJK.test(`const label = "${String.fromCodePoint(0x4e2d)}";`)).toBe(true);
    expect(CJK.test(`Plain English, an em dash ${String.fromCodePoint(0x2014)} and a check mark ${String.fromCodePoint(0x2713)}.`)).toBe(false);
  });
});
