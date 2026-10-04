export const AUTO_REMEDIATION_ARMORIQ_SCOPE = {
  allow: ["fs.readwrite ./src/**", "github.pull_request.create"],
  deny: ["github.pull_request.merge", "github.push"],
} as const;

export function isAllowedAutoRemediationPath(filePath: string): boolean {
  if (!filePath || filePath.includes("\\") || filePath.startsWith("/")) return false;

  const segments = filePath.split("/");
  return (
    segments[0] === "src" &&
    segments.length > 1 &&
    segments.every((segment) => segment !== "" && segment !== "." && segment !== "..")
  );
}

export function applyScopedUnifiedDiff(
  patch: string,
  expectedPath: string,
  source: string,
): string {
  if (!isAllowedAutoRemediationPath(expectedPath)) {
    throw new Error("Remediation path is outside the allowed src/** scope");
  }

  const lines = patch.replace(/\r\n/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  const firstHunk = lines.findIndex((line) => line.startsWith("@@ "));
  const headers = firstHunk < 0 ? [] : lines.slice(0, firstHunk);
  const oldHeaders = headers.filter((line) => line.startsWith("--- "));
  const newHeaders = headers.filter((line) => line.startsWith("+++ "));
  const oldPath = oldHeaders[0]?.slice(6).split("\t", 1)[0];
  const newPath = newHeaders[0]?.slice(6).split("\t", 1)[0];
  if (
    oldHeaders.length !== 1 ||
    newHeaders.length !== 1 ||
    oldPath !== expectedPath ||
    newPath !== expectedPath
  ) {
    throw new Error("Patch must modify only the finding file within src/**");
  }

  const sourceHasTrailingNewline = source.endsWith("\n");
  const sourceLines = source.replace(/\r\n/g, "\n").split("\n");
  if (sourceHasTrailingNewline) sourceLines.pop();

  const result: string[] = [];
  let sourceIndex = 0;
  let hunkCount = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const hunk = lines[index].match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (!hunk) continue;

    hunkCount += 1;
    const oldStart = Number(hunk[1]);
    const expectedOldCount = hunk[2] === undefined ? 1 : Number(hunk[2]);
    const expectedNewCount = hunk[4] === undefined ? 1 : Number(hunk[4]);
    const targetIndex = oldStart === 0 ? 0 : oldStart - 1;
    if (targetIndex < sourceIndex || targetIndex > sourceLines.length) {
      throw new Error("Patch hunk is outside the current file");
    }
    result.push(...sourceLines.slice(sourceIndex, targetIndex));
    sourceIndex = targetIndex;

    let oldCount = 0;
    let newCount = 0;
    while (index + 1 < lines.length && !lines[index + 1].startsWith("@@ ")) {
      const line = lines[index + 1];
      index += 1;
      if (line.startsWith("\\")) continue;
      if (line.startsWith(" ")) {
        const context = line.slice(1);
        if (sourceLines[sourceIndex] !== context) throw new Error("Patch context does not match");
        result.push(context);
        sourceIndex += 1;
        oldCount += 1;
        newCount += 1;
      } else if (line.startsWith("-")) {
        if (sourceLines[sourceIndex] !== line.slice(1)) throw new Error("Patch removal does not match");
        sourceIndex += 1;
        oldCount += 1;
      } else if (line.startsWith("+")) {
        result.push(line.slice(1));
        newCount += 1;
      } else {
        throw new Error("Patch contains an invalid hunk line");
      }
    }

    if (oldCount !== expectedOldCount || newCount !== expectedNewCount) {
      throw new Error("Patch hunk line counts are invalid");
    }
  }

  if (hunkCount === 0) throw new Error("Patch contains no unified diff hunks");
  result.push(...sourceLines.slice(sourceIndex));
  return result.join("\n") + (sourceHasTrailingNewline ? "\n" : "");
}