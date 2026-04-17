import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

type PackageManifest = {
  files?: string[];
};

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function readRepoFile(relativePath: string): string {
  return readFileSync(resolve(repoRoot, relativePath), "utf8");
}

describe("installer artifacts consistency", () => {
  it("keeps the legacy install wrapper delegating to canonical installer", () => {
    const wrapperPath = resolve(repoRoot, "scripts/install.sh");
    expect(existsSync(wrapperPath)).toBe(true);
    expect(readFileSync(wrapperPath, "utf8")).toContain("openclaw-plugin-install.sh");
  });

  it("publishes only existing files from package.json", () => {
    const pkg = JSON.parse(readRepoFile("package.json")) as PackageManifest;
    for (const entry of pkg.files ?? []) {
      expect(existsSync(resolve(repoRoot, entry))).toBe(true);
    }
  });

  it("documents existing script paths in README install instructions", () => {
    const readme = readRepoFile("README.md");
    const scriptPaths = new Set(
      [...readme.matchAll(/\.\/scripts\/[A-Za-z0-9._-]+/g)].map((match) =>
        match[0].replace(/^\.\//, ""),
      ),
    );

    expect(scriptPaths.size).toBeGreaterThan(0);
    for (const scriptPath of scriptPaths) {
      expect(existsSync(resolve(repoRoot, scriptPath))).toBe(true);
    }
  });
});
