import assert from "node:assert/strict";
import type { CodeOwnersClient } from "../src/lib/github/codeowners";
import {
  renderScanReportSummary,
  renderScanReportWithBaseOwners,
  type ScanReportSummaryInput,
} from "../src/lib/github/scan-report";

const base = { owner: "example", repo: "demo", baseRef: "base-fixture" };
const headRef = "head-fixture";
const input: ScanReportSummaryInput = {
  findings: [
    { type: "Example finding", severity: "LOW", fileLocation: "src/api.ts" },
    { type: "Example finding", severity: "LOW", fileLocation: "src/generated/types.ts" },
  ],
  totalFindings: 3,
  inlineCount: 1,
  commitSha: headRef,
};
const paths = ["docs/guide.md"];
const defaultReport = renderScanReportSummary(input);
const codeowners = "*.ts @example/platform team@example.test\n/docs/ @docs\n/src/generated/\n";
const fixtureClient = (includeBaseFile: boolean): CodeOwnersClient => ({
  rest: {
    repos: {
      async getContent({ path, ref }) {
        if (path === ".github/CODEOWNERS") {
          if (ref === headRef) return { data: "* @head-only" };
          assert.equal(ref, base.baseRef);
          if (includeBaseFile) return { data: codeowners };
        }
        throw { status: 404 };
      },
    },
  },
});

async function run() {
  const annotated = await renderScanReportWithBaseOwners(fixtureClient(true), base, input, paths);
  assert.match(annotated, /By owner/);
  assert.match(annotated, /Owners:\*\* Unowned/);
  assert.match(annotated, /docs\/guide.md.*@docs/);
  console.log(annotated);

  const headOnly = await renderScanReportWithBaseOwners(fixtureClient(false), base, input, paths);
  assert.equal(headOnly, defaultReport);
  console.log("PASS: A head-only CODEOWNERS file is ignored and the baseline report is unchanged.");
}

run().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
