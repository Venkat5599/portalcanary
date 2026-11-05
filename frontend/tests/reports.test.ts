// Every report the site serves must check out the way the dashboard checks it:
// - each finding re-classifies from its recorded side runs to the identical finding
//   (lib/tx/verdict.ts is the browser port of the CLI's verdict.rs),
// - each finding hash recomputes (lib/checks.ts), the upgrade's state finding from its evidence file,
// - each attestation payload and report sha256 rebuild from the report bytes.
// Plus: the browser's runtime-API table matches the CLI's (canary-chain/src/apis.rs), and the
// workflow suite packaged for the Test panel matches backend/tests/workflows.
import { test, expect } from "bun:test";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { classify, describe as describeExpect, type Workflow, type SideRun } from "../lib/tx/verdict";
import { findingHash, attestPayload, KNOWN_APIS, detectApis } from "../lib/checks";
import { packSuite } from "../scripts/build-suite";

const ROOT = join(import.meta.dir, "..");
const REPORTS = join(ROOT, "public", "reports");
const BACKEND = join(ROOT, "..", "backend");

const corpus = new Map<string, { wf: Workflow; sha: string }>();
for (const f of readdirSync(join(BACKEND, "tests", "workflows")).filter((f) => f.endsWith(".yaml"))) {
  const raw = readFileSync(join(BACKEND, "tests", "workflows", f));
  const wf = Bun.YAML.parse(raw.toString()) as Workflow;
  corpus.set(wf.id, { wf, sha: createHash("sha256").update(raw).digest("hex") });
}
const ids = readdirSync(REPORTS).filter((d) => existsSync(join(REPORTS, d, "report.json"))).sort();

test("serves the four recorded runs", () => expect(ids).toEqual(["self-compare", "upgrade-ed100x", "upgrade-fee10x", "upgrade-halve-reserved"]));

for (const id of ids) {
  const bytes = readFileSync(join(REPORTS, id, "report.json"));
  const report = JSON.parse(bytes.toString());

  test(`${id}: every finding hash recomputes`, async () => {
    for (const r of report.results) {
      const want = report.manifest.kind === "upgrade" && r.finding.workflow === "upgrade.state"
        ? createHash("sha256").update(readFileSync(join(REPORTS, id, "upgrade.json"))).digest("hex")
        : await findingHash(r.finding);
      expect(want).toBe(r.finding.finding_hash);
    }
  });

  if (report.manifest.kind !== "upgrade") {
    test(`${id}: findings re-classify identically in the browser port`, async () => {
      let checked = 0;
      for (const r of report.results) {
        const entry = corpus.get(r.finding.workflow);
        const recorded = report.manifest.suite.find((s: { workflow: string }) => s.workflow === r.finding.workflow)?.sha256;
        if (!entry || recorded !== entry.sha) continue; // workflow file edited since the run
        const f = await classify(entry.wf, r.baseline as SideRun, r.candidate as SideRun);
        expect(JSON.stringify(f)).toBe(JSON.stringify(r.finding));
        expect(r.baseline.expectations.map((e: { description: string }) => e.description)).toEqual(entry.wf.expect.map(describeExpect));
        checked++;
      }
      expect(checked).toBeGreaterThan(0);
    });
  }

  const att = join(REPORTS, id, "attestation.json");
  if (existsSync(att)) {
    test(`${id}: attestation rebuilds from the report bytes`, async () => {
      const a = JSON.parse(readFileSync(att, "utf8"));
      const x = await attestPayload(new Uint8Array(bytes));
      expect(x.report_sha256).toBe(a.report_sha256);
      expect(x.payload).toBe(a.payload);
      expect(Buffer.from(a.payload_hex.slice(2), "hex").toString()).toBe(a.payload);
    });
  }
}

test("runtime-API table matches the CLI", () => {
  const rs = readFileSync(join(BACKEND, "crates", "canary-chain", "src", "apis.rs"), "utf8");
  const block = rs.slice(rs.indexOf("pub const KNOWN"), rs.indexOf("];", rs.indexOf("pub const KNOWN")));
  const cli = [...block.matchAll(/\("([A-Za-z]+)", "([a-z-]+)"\)/g)].map((m) => [m[1], m[2]]);
  expect(cli.length).toBeGreaterThan(10);
  expect(KNOWN_APIS).toEqual(cli as [string, string][]);
  // and the hashing: Core's id is the well-known blake2_64("Core")
  expect(detectApis([["0xdf6acb689907609b", 5]])[0].name).toBe("Core");
});

test("Test panel's packaged suite matches backend/tests", () => {
  const { json, wasm } = packSuite();
  expect(readFileSync(join(ROOT, "public", "engine", "workflows.json"), "utf8")).toBe(json);
  expect(readFileSync(join(ROOT, "public", "engine", "contracts", "counter.wasm")).equals(wasm)).toBe(true);
});

// The remark `canary attest` writes for a full run (attest.rs test run_payload_from_result_json).
test("run remark rebuilt in the page matches the CLI", async () => {
  const { runPayload } = await import("../lib/runresult");
  const text = readFileSync(join(import.meta.dir, "../../backend/tests/fixtures/run/result.json"), "utf8");
  const { sha, payload } = await runPayload(text);
  expect(sha).toBe("d06ca94c27db9c831dbb13b51b990962511834c89482cf510007cefd5544f36f");
  expect(payload).toBe("canary-run/1 d06ca94c27db9c831dbb13b51b990962511834c89482cf510007cefd5544f36f 959e58764a17 u=1 c=0 t=1 h=0");
});

// "On your node" on a live chain funds each account with at most 5 tokens; workflows that move
// more than that themselves are dev-chain only. transfer.insufficient exceeds the balance on purpose.
test("live-chain cap keeps only workflows that fit in 5 tokens per account", async () => {
  const { largestMove } = await import("../lib/tx/tx");
  const suite: { workflow: Parameters<typeof largestMove>[0] }[] = JSON.parse(readFileSync(join(import.meta.dir, "../public/engine/workflows.json"), "utf8"));
  const cap = 5n * 10n ** 14n;
  const fits = Object.fromEntries(suite.map((s) => [s.workflow.id, largestMove(s.workflow) <= cap]));
  expect(fits).toEqual({
    "balances.keep_alive": false, "balances.transfer.basic": true, "balances.transfer.insufficient": true,
    "contracts.counter": false, "identity.deposit": true,
  });
});

// A run's starting state travels in its name ("canary run <id> · <candidate> · mainnet state")
// and in its kept asset's label ("<candidate> · mainnet state").
test("run titles split into candidate and starting state", async () => {
  const { splitTitle } = await import("../lib/runs");
  expect(splitTitle("halve-reserved · mainnet state")).toEqual({ candidate: "halve-reserved", state: "mainnet" });
  expect(splitTitle("ed100x")).toEqual({ candidate: "ed100x", state: "dev" });
  expect(splitTitle("url")).toEqual({ candidate: "url", state: "dev" });
});

// A dispatch expectation may list alternative error names; V3's newer pallet-balances reports an
// insufficient-funds transfer as Token.FundsUnavailable, older runtimes as Balances.InsufficientBalance.
test("dispatch error alternatives match old and new runtimes", async () => {
  const { errorMatches } = await import("../lib/tx/tx");
  const want = "InsufficientBalance|FundsUnavailable";
  expect(errorMatches(want, "balances.InsufficientBalance")).toBe(true);
  expect(errorMatches(want, '{"token":"FundsUnavailable"}')).toBe(true);
  expect(errorMatches(want, "balances.ExistentialDeposit")).toBe(false);
  expect(errorMatches(want, null)).toBe(false);
});
