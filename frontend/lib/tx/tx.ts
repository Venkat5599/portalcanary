// Live transactions for the dashboard: the `canary test` runner, `attest` and
// `verify`, in the browser. Port of runner.rs / attest.rs plus the step driver
// (backend/driver/src/run.ts). Signing is done by a browser wallet extension or,
// on a local development chain only, by the public dev accounts.
import { ApiPromise, WsProvider } from "@polkadot/api";
import { Keyring } from "@polkadot/keyring";
import { u8aToHex, hexToU8a, stringToHex, hexToString } from "@polkadot/util";
import { blake2AsU8a, cryptoWaitReady, mnemonicGenerate } from "@polkadot/util-crypto";
import {
  classify, summarize, attestPayload, describe, kind, sha256Hex,
  type Workflow, type SideRun, type StepOutcome, type ExpectOutcome, type Finding, type Summary,
} from "./verdict";

export { classify, summarize, attestPayload, exitCode } from "./verdict";
export type { Workflow, SideRun, Finding, Summary } from "./verdict";

export const CANARY_VERSION = "0.1.0-web";
const SYSTEM_ACCOUNT = "0x26aa394eea5630e07c48ae0c9558cef7b99d880ec681799c0cf30e8886371da9";
const TOTAL_ISSUANCE = "0xc2261276cc9d1f8598ea4b6a74b15c2f57c875e4cff74148e4628f264b974c80";
const DEV = ["alice", "bob", "charlie", "dave", "eve", "ferdie"];

/* ---------------- connection ---------------- */
async function rawRpc(ws: string, method: string, params: unknown[] = []): Promise<any> {
  return new Promise((resolve, reject) => {
    const s = new WebSocket(ws);
    const t = setTimeout(() => { s.close(); reject(new Error(`${ws}: no answer`)); }, 20000);
    s.onerror = () => { clearTimeout(t); reject(new Error(`could not connect to ${ws}`)); };
    s.onopen = () => s.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }));
    s.onmessage = (e) => { clearTimeout(t); const m = JSON.parse(e.data); s.close(); m.error ? reject(new Error(m.error.message)) : resolve(m.result); };
  });
}

const apis = new Map<string, Promise<ApiPromise>>();
const providers = new Map<string, WsProvider>();
export function api(ws: string): Promise<ApiPromise> {
  if (!apis.has(ws)) {
    const p = (async () => {
      await cryptoWaitReady();
      const meta: string = await rawRpc(ws, "state_getMetadata");
      const version = parseInt(meta.slice(10, 12), 16);
      // Portaldot's 2021 runtime (metadata V13) encodes DispatchError::Module as
      // { index: u8, error: u8 }; newer polkadot.js assumes the 4-byte error.
      const types: Record<string, string> = version < 14 ? { DispatchErrorModule: "DispatchErrorModuleU8" } : {};
      const provider = new WsProvider(ws, 2500);
      providers.set(ws, provider);
      return ApiPromise.create({ provider, noInitWarn: true, throwOnConnect: true, types });
    })();
    p.catch(() => apis.delete(ws));
    apis.set(ws, p);
  }
  return apis.get(ws)!;
}
const send = async (ws: string, method: string, params: unknown[] = []): Promise<any> => {
  await api(ws);
  return providers.get(ws)!.send(method, params);
};

export type RuntimeId = {
  endpoint: string; spec_name: string | null; spec_version: number | null; transaction_version: number | null;
  genesis_hash: string | null; metadata_sha256: string | null; metadata_version: number | null;
};
export async function identify(ws: string): Promise<RuntimeId> {
  const id: RuntimeId = { endpoint: ws, spec_name: null, spec_version: null, transaction_version: null, genesis_hash: null, metadata_sha256: null, metadata_version: null };
  try {
    const rv = await send(ws, "state_getRuntimeVersion");
    id.spec_name = rv.specName; id.spec_version = rv.specVersion; id.transaction_version = rv.transactionVersion;
    id.genesis_hash = await send(ws, "chain_getBlockHash", [0]);
    const bytes = hexToU8a(await send(ws, "state_getMetadata"));
    if (bytes.length >= 5 && bytes[0] === 0x6d && bytes[1] === 0x65 && bytes[2] === 0x74 && bytes[3] === 0x61) {
      id.metadata_version = bytes[4];
      id.metadata_sha256 = await sha256Hex(bytes);
    }
  } catch { /* fields stay null, as in report.rs */ }
  return id;
}

export type ChainInfo = { chain: string; dev: boolean; symbol: string; decimals: number; ss58: number; spec: string };
export async function chainInfo(ws: string): Promise<ChainInfo> {
  const [chain, props, rv, type] = await Promise.all([
    send(ws, "system_chain"), send(ws, "system_properties").catch(() => ({})),
    send(ws, "state_getRuntimeVersion"), send(ws, "system_chainType").catch(() => null),
  ]);
  const local = /^ws:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(ws);
  const dev = local && (type === "Development" || type === "Local" || /development|local/i.test(chain));
  return {
    chain, dev, spec: `${rv.specName} ${rv.specVersion}`,
    symbol: [].concat(props?.tokenSymbol ?? "POT")[0], decimals: Number([].concat(props?.tokenDecimals ?? 14)[0]), ss58: Number(props?.ss58Format ?? 42),
  };
}

/* ---------------- signers ---------------- */
export type Signer =
  | { kind: "dev"; name: string }                                    // public dev account, dev chains only
  | { kind: "wallet"; extension: string; address: string };          // browser extension account

const keyring = () => new Keyring({ type: "sr25519", ss58Format: 42 });
function devPair(name: string) {
  const uri = name.startsWith("//") ? name : `//${name.charAt(0).toUpperCase()}${name.slice(1)}`;
  return keyring().addFromUri(uri);
}
async function walletSigner(extension: string) {
  const ext = (globalThis as any).injectedWeb3?.[extension];
  if (!ext) throw new Error(`${extension} is not installed`);
  const injected = await ext.enable("Portal Canary");
  return injected.signer;
}
export function signerAddress(s: Signer): string {
  return s.kind === "dev" ? devPair(s.name).address : s.address;
}

/* ---------------- step driver (run.ts) ---------------- */
type Step = { call: string; signer: string; args?: any; sudo?: boolean };
type Resolver = { pair: (name: string) => any | null; fetchFile: (path: string) => Promise<string> };
const camel = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
const camelToSnake = (s: string) => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

function fromEvent(results: StepOutcome[], ref: string): unknown {
  const [, n, name, field] = ref.split(":");
  const ev = results[Number(n)]?.events?.find((e) => e.name.toLowerCase() === name.toLowerCase());
  if (!ev) throw new Error(`${ref}: step ${n} emitted no ${name}`);
  return (ev.data as unknown[])[Number(field)];
}

async function inspectEvents(a: ApiPromise, blockHash: string, txHash: string) {
  const base = { block_hash: blockHash, events: [] as { name: string; data: unknown }[] };
  try {
    const block = await a.rpc.chain.getBlock(blockHash);
    const index = block.block.extrinsics.findIndex((x) => x.hash.toHex() === txHash);
    const at = await a.at(blockHash);
    const records: any = await at.query.system.events();
    const mine = records.filter((r: any) => r.phase.isApplyExtrinsic && r.phase.asApplyExtrinsic.toNumber() === index);
    const events = mine.map(({ event }: any) => ({ name: `${event.section}.${event.method}`, data: event.data.toJSON() }));
    const failed = events.find((e: any) => e.name === "system.ExtrinsicFailed");
    return { ...base, events, status: failed ? "failed" : events.length ? "success" : "undecodable", dispatch_error: failed ? JSON.stringify(failed.data[0]) : null };
  } catch (e: any) {
    return { ...base, status: "undecodable", dispatch_error: `event decode failed: ${e?.message ?? e}` };
  }
}

/** Sign and submit one extrinsic; resolve when it is in a block (or fails). */
async function submit(a: ApiPromise, tx: any, signer: { pair?: any; wallet?: { address: string; signer: any } }, timeoutMs: number) {
  return new Promise<any>((resolveP) => {
    const timer = setTimeout(() => resolveP({ status: "timeout", block_hash: null, dispatch_error: null, events: [] }), timeoutMs);
    const cb = ({ status, events, dispatchError }: any) => {
      if (status.isInvalid || status.isDropped || status.isUsurped) {
        clearTimeout(timer);
        resolveP({ status: status.type.toLowerCase(), block_hash: null, dispatch_error: null, events: [] });
      }
      if (!status.isInBlock) return;
      clearTimeout(timer);
      if (events.length === 0) { inspectEvents(a, status.asInBlock.toHex(), tx.hash.toHex()).then(resolveP); return; }
      let err: string | null = null;
      if (dispatchError) {
        if (dispatchError.isModule) { const m = a.registry.findMetaError(dispatchError.asModule); err = `${m.section}.${m.name}`; }
        else err = dispatchError.toString();
      }
      resolveP({
        status: err ? "failed" : "success", block_hash: status.asInBlock.toHex(), dispatch_error: err,
        events: events.map(({ event }: any) => ({ name: `${event.section}.${event.method}`, data: event.data.toJSON() })),
      });
    };
    const p = signer.pair
      ? tx.signAndSend(signer.pair, { nonce: -1 }, cb)
      : tx.signAndSend(signer.wallet!.address, { nonce: -1, signer: signer.wallet!.signer }, cb);
    p.catch((e: Error) => { clearTimeout(timer); resolveP({ status: "rejected", block_hash: null, dispatch_error: e.message, events: [] }); });
  });
}

async function runSteps(ws: string, steps: Step[], r: Resolver, funder: { pair?: any; wallet?: { address: string; signer: any } } | null, timeoutMs = 90_000) {
  const a = await api(ws);
  const results: StepOutcome[] = [];
  const resolveArg = async (v: unknown): Promise<unknown> => {
    if (typeof v === "string") {
      const p = r.pair(v);
      if (p) return p.address;
      if (v.startsWith("file:")) return r.fetchFile(v.slice(5));
      if (v.startsWith("step:")) return fromEvent(results, v);
    }
    if (Array.isArray(v)) return Promise.all(v.map(resolveArg));
    return v;
  };
  for (const [index, step] of steps.entries()) {
    const [pallet, method] = step.call.split(".");
    // Newer pallet-balances renamed `transfer` to `transferAllowDeath` (same semantics).
    const alias = method === "transfer" && !(a.tx as any)[camel(pallet)]?.transfer && (a.tx as any)[camel(pallet)]?.transferAllowDeath ? "transferAllowDeath" : null;
    const fn = (a.tx as any)[camel(pallet)]?.[alias ?? method];
    if (!fn) { results.push({ index, call: step.call, status: "unknown_call", block_hash: null, dispatch_error: null, events: [] }); continue; }
    const names: string[] = fn.meta.args.map((x: any) => x.name.toString());
    let ordered: unknown[];
    try {
      ordered = Array.isArray(step.args)
        ? await Promise.all(step.args.map(resolveArg))
        : await Promise.all(names.map((n) => resolveArg((step.args ?? {})[n] ?? (step.args ?? {})[camelToSnake(n)])));
    } catch (e: any) {
      results.push({ index, call: step.call, status: "unresolved", block_hash: null, dispatch_error: e.message, events: [] });
      continue;
    }
    let tx = fn(...ordered);
    if (step.sudo) tx = a.tx.sudo.sudo(tx);
    const signer = step.signer === "$funder" ? funder! : { pair: r.pair(step.signer) };
    if (!signer?.pair && !signer?.wallet) { results.push({ index, call: step.call, status: "unresolved", block_hash: null, dispatch_error: `no key for ${step.signer}`, events: [] }); continue; }
    const out = await submit(a, tx, signer, timeoutMs);
    results.push({ index, call: alias ? `${step.call} (as ${pallet}.${alias})` : step.call, signer: step.signer, tx_hash: tx.hash.toHex(), ...out });
  }
  return results;
}

/* ---------------- state reads (canary-chain invariant.rs) ---------------- */
function leU128(hex: string, offset: number): bigint {
  const h = hex.slice(2 + offset * 2, 2 + offset * 2 + 32);
  let n = 0n;
  for (let i = h.length - 2; i >= 0; i -= 2) n = (n << 8n) | BigInt(parseInt(h.slice(i, i + 2), 16));
  return n;
}
function decodeAccount(hex: string): { free: bigint; reserved: bigint } {
  const len = (hex.length - 2) / 2;
  const header = ({ 72: 8, 76: 12, 80: 16 } as Record<number, number>)[len];
  if (header === undefined) throw new Error(`unrecognised AccountInfo length ${len} bytes`);
  return { free: leU128(hex, header), reserved: leU128(hex, header + 16) };
}
const accountKey = (id: Uint8Array) => SYSTEM_ACCOUNT + u8aToHex(blake2AsU8a(id, 128)).slice(2) + u8aToHex(id).slice(2);

async function readBalances(ws: string, ids: Record<string, Uint8Array>, at: string) {
  const out: Record<string, [bigint, bigint]> = {};
  for (const [name, id] of Object.entries(ids)) {
    const raw = await send(ws, "state_getStorage", [accountKey(id), at]);
    const info = raw ? decodeAccount(raw) : null;
    out[name] = info ? [info.free, info.reserved] : [0n, 0n];
  }
  return out;
}

export type Supply = { accounts: number; decode_errors: number; sum_free: bigint; sum_reserved: bigint; total_issuance: bigint };
export async function supplyAt(ws: string, at: string, onPage?: (n: number) => void): Promise<Supply> {
  const ti = await send(ws, "state_getStorage", [TOTAL_ISSUANCE, at]);
  if (!ti) throw new Error("Balances.TotalIssuance is empty");
  const s: Supply = { accounts: 0, decode_errors: 0, sum_free: 0n, sum_reserved: 0n, total_issuance: leU128(ti, 0) };
  let start: string | null = null;
  for (;;) {
    const keys: string[] = await send(ws, "state_getKeysPaged", [SYSTEM_ACCOUNT, 1000, start, at]);
    if (!keys.length) break;
    const res = await send(ws, "state_queryStorageAt", [keys, at]);
    for (const [, v] of res[0]?.changes ?? []) {
      if (!v) continue;
      s.accounts++;
      try { const i = decodeAccount(v); s.sum_free += i.free; s.sum_reserved += i.reserved; } catch { s.decode_errors++; }
    }
    onPage?.(s.accounts);
    start = keys[keys.length - 1];
    if (keys.length < 1000) break;
  }
  return s;
}

/* ---------------- runner (runner.rs) ---------------- */
const fmtSigned = (v: bigint) => (v >= 0n ? `+${v}` : `${v}`);
const parseI = (s: string) => BigInt(s.replace(/^\+/, ""));

/** `error` may list alternatives ("InsufficientBalance|FundsUnavailable"), as runner.rs error_matches. */
export function errorMatches(want: string, seen: string | null | undefined): boolean {
  const got = (seen ?? "").toLowerCase();
  return want.split("|").map((w) => w.trim()).filter(Boolean).some((w) => got.includes(w.toLowerCase()));
}

async function evaluate(e: Workflow["expect"][number], steps: StepOutcome[], deltas: Record<string, bigint>, ws: string, post: string): Promise<ExpectOutcome> {
  let pass = false, observed = "";
  if ("dispatch" in e) {
    const { step, status, error } = e.dispatch;
    const s = steps[step];
    if (!s) observed = "step did not run";
    else {
      const errOk = error == null || errorMatches(error, s.dispatch_error);
      observed = s.dispatch_error != null ? `${s.status} (${s.dispatch_error})` : s.status;
      pass = s.status === status && errOk;
    }
  } else if ("delta" in e) {
    const { account, field, eq, gt, lt } = e.delta;
    const key = `${account}.${field}`;
    const d = deltas[key];
    if (d === undefined) observed = `no observation for ${key}`;
    else {
      try {
        pass = (eq == null || d === parseI(eq)) && (gt == null || d > parseI(gt)) && (lt == null || d < parseI(lt));
        observed = fmtSigned(d);
      } catch (err: any) { pass = false; observed = `bad expectation: ${err.message}`; }
    }
  } else if ("event" in e) {
    const { step, name, absent = false, contains } = e.event;
    const s = steps[step];
    if (!s) observed = "step did not run";
    else {
      const matching = s.events.filter((ev) => ev.name.toLowerCase() === name.toLowerCase());
      const found = contains == null ? matching.length > 0 : matching.some((ev) => JSON.stringify(ev.data).toLowerCase().includes(contains.toLowerCase()));
      observed = contains != null && matching[0]
        ? `${matching[0].name} ${JSON.stringify(matching[0].data)}`
        : s.events.length ? s.events.map((ev) => ev.name).join(", ") : "no events";
      pass = found !== absent;
    }
  } else if (e.invariant === "supply_conservation") {
    try {
      const s = await supplyAt(ws, post);
      pass = s.decode_errors === 0 && s.sum_free + s.sum_reserved === s.total_issuance;
      observed = `accounts ${s.accounts} sum ${s.sum_free + s.sum_reserved} vs issuance ${s.total_issuance}`;
    } catch (err: any) { observed = `error: ${err.message}`; }
  } else observed = `unknown invariant ${e.invariant}`;
  return { description: describe(e), kind: kind(e), pass, observed };
}

export type Funder = { signer: Signer };
export type Progress = (msg: string) => void;
type Ctx = { runId: string; secret: string; funder: Signer; timeoutMs: number; fetchFile: (p: string) => Promise<string>; log: Progress; fundCap?: bigint; prefunded?: Set<string> };

/** One wallet transaction that funded every test account of a run on one chain. */
export type Funding = { network: string; tx_hash: string; block_hash: string; block_number: number | null; accounts: number; total: string };

/** The per-run key of one test account: derived from a secret that lives only in this tab. */
const testPair = (kr: any, ctx: Ctx, side: string, wfId: string, account: string) => kr.addFromUri(`${ctx.secret}//canary/${ctx.runId}/${side}/${wfId}/${account}`);

/**
 * A wallet signs once per chain: every test account of every selected workflow, on every side
 * that runs on this chain, funded in one utility.batchAll. The workflows then run with their own
 * test keys, so the wallet is not asked again.
 */
async function prefund(ctx: Ctx, suite: SuiteEntry[], sides: { side: "baseline" | "candidate"; ws: string }[], ws: string): Promise<Funding> {
  const a = await api(ws);
  const kr = keyring();
  const bal = (a.tx as any).balances;
  const transfer = bal.transferKeepAlive ?? bal.transfer ?? bal.transferAllowDeath;
  const calls: any[] = [];
  let total = 0n;
  for (const { workflow: wf } of suite)
    for (const { side } of sides.filter((x) => x.ws === ws))
      for (const f of funded(wf, ctx.fundCap)) {
        calls.push(transfer(testPair(kr, ctx, side, wf.id, f.account).address, f.amount));
        total += BigInt(f.amount);
      }
  const batch = (a.tx as any).utility?.batchAll;
  if (calls.length > 1 && !batch) throw new Error("this chain has no utility.batchAll; fund from a dev account instead");
  const tx = calls.length === 1 ? calls[0] : batch(calls);
  ctx.log(`funding ${calls.length} test accounts in one transaction: approve it in your wallet`);
  const out = await submit(a, tx, await funderHandle(ctx.funder), ctx.timeoutMs);
  if (out.status !== "success") throw new Error(`funding transaction ${out.status}: ${out.dispatch_error ?? ""}`);
  const header = await send(ws, "chain_getHeader", [out.block_hash]).catch(() => null);
  return { network: ws, tx_hash: tx.hash.toHex(), block_hash: out.block_hash, block_number: header ? parseInt(header.number, 16) : null, accounts: calls.length, total: total.toString() };
}

/** On a live chain each test account is funded with at most `cap`; these are what a workflow then holds. */
const funded = (wf: Workflow, cap?: bigint) => (wf.fund ?? []).map((f) => ({ ...f, amount: cap != null && BigInt(f.amount) > cap ? cap.toString() : f.amount }));
/** The largest balance a workflow's own steps move (transfer value, contract endowment). */
export function largestMove(wf: Workflow): bigint {
  // A step written to exceed the balance (expected to fail) needs no funds of its own.
  const funds = (wf.fund ?? []).reduce((a, f) => a + BigInt(f.amount), 0n);
  const failing = new Set((wf.expect as { dispatch?: { step: number; status: string } }[]).filter((e) => e.dispatch?.status === "failed").map((e) => e.dispatch!.step));
  let max = 0n;
  wf.steps.forEach((s, i) => {
    for (const [k, v] of Object.entries((s.args ?? {}) as Record<string, unknown>)) {
      if ((k !== "value" && k !== "endowment") || typeof v !== "string" || !/^\d+$/.test(v)) continue;
      const n = BigInt(v);
      if (failing.has(i) && n > funds) continue;
      if (n > max) max = n;
    }
  });
  return max;
}

async function funderHandle(f: Signer) {
  return f.kind === "dev" ? { pair: devPair(f.name) } : { wallet: { address: f.address, signer: await walletSigner(f.extension) } };
}

async function runSide(wf: Workflow, side: "baseline" | "candidate", ws: string, ctx: Ctx): Promise<SideRun> {
  const run: SideRun = { side, endpoint: ws, setup_error: null, pre_block: null, post_block: null, steps: [], deltas: {}, expectations: [] };
  try {
    const kr = keyring();
    const accounts = wf.accounts ?? [];
    // Fresh per-run accounts, derived from a secret that lives only in this tab.
    const pairs: Record<string, any> = {};
    for (const a of accounts) pairs[a] = testPair(kr, ctx, side, wf.id, a);
    const resolver: Resolver = {
      pair: (n) => pairs[n] ?? (DEV.includes(n) || n.startsWith("//") ? (ctx.funder.kind === "dev" ? devPair(n) : null) : null),
      fetchFile: ctx.fetchFile,
    };
    const fund = funded(wf, ctx.fundCap);
    // A wallet already funded this chain's accounts in one batch; dev accounts fund per workflow.
    const funder = ctx.prefunded?.has(ws) ? null : await funderHandle(ctx.funder);
    if (funder) {
      ctx.log(`${wf.id} · ${side}: funding ${accounts.join(", ")}`);
      const fundSteps: Step[] = fund.map((f) => ({ call: "Balances.transfer", signer: "$funder", args: { dest: f.account, value: f.amount } }));
      const setup = await runSteps(ws, fundSteps, resolver, funder, ctx.timeoutMs);
      const bad = setup.find((r) => r.status !== "success");
      if (bad) throw new Error(`setup step ${bad.index} ${bad.status}: ${bad.dispatch_error ?? ""}`);
    }
    const ids: Record<string, Uint8Array> = Object.fromEntries(accounts.map((n) => [n, pairs[n].publicKey]));

    // wait until every funding is visible at the best block (runner.rs wait_funded)
    const deadline = Date.now() + ctx.timeoutMs;
    for (;;) {
      const best = await send(ws, "chain_getBlockHash", []);
      const bal = await readBalances(ws, ids, best);
      const short = fund.find((f) => (bal[f.account]?.[0] ?? 0n) < BigInt(f.amount));
      if (!short) break;
      if (Date.now() > deadline) throw new Error(`funding of ${short.account} not visible at the best block after ${ctx.timeoutMs / 1000}s`);
      await new Promise((r) => setTimeout(r, 500));
    }
    const pre = await send(ws, "chain_getBlockHash", []);
    const before = await readBalances(ws, ids, pre);
    run.pre_block = pre;

    ctx.log(`${wf.id} · ${side}: ${wf.steps.map((s) => s.call).join(", ")}`);
    run.steps = await runSteps(ws, wf.steps.map((s) => ({ call: s.call, signer: s.signer, sudo: s.sudo, args: s.args })), resolver, funder, ctx.timeoutMs);
    const post = [...run.steps].reverse().find((s) => s.block_hash)?.block_hash ?? (await send(ws, "chain_getBlockHash", []));
    const after = await readBalances(ws, ids, post);
    run.post_block = post;
    const deltas: Record<string, bigint> = {};
    for (const acct of Object.keys(before).sort()) {
      deltas[`${acct}.free`] = after[acct][0] - before[acct][0];
      deltas[`${acct}.reserved`] = after[acct][1] - before[acct][1];
    }
    run.deltas = Object.fromEntries(Object.keys(deltas).sort().map((k) => [k, fmtSigned(deltas[k])]));
    ctx.log(`${wf.id} · ${side}: checking ${wf.expect.length} expectations`);
    for (const e of wf.expect) run.expectations.push(await evaluate(e, run.steps, deltas, ws, post));
    // Return what is left to the funder, so a run on a public testnet costs only fees and deposits.
    await sweep(ws, Object.values(pairs), signerAddress(ctx.funder)).catch(() => {});
  } catch (e: any) {
    run.setup_error = e?.message ?? String(e);
  }
  return run;
}

async function sweep(ws: string, pairs: any[], to: string) {
  const a = await api(ws);
  if (!(a.tx as any).balances?.transferAll) return;
  // A test identity holds a deposit, which can't be transferred: clear it first so the deposit
  // comes back too, and the run costs the funder only fees.
  const clear = (a.tx as any).identity?.clearIdentity;
  const q = (a.query as any).identity?.identityOf;
  if (clear && q) await Promise.all(pairs.map(async (p) => {
    const has = await q(p.address).then((v: any) => (v?.isSome ?? !v?.isEmpty) === true).catch(() => false);
    if (has) await submit(a, clear(), { pair: p }, 30_000);
  }));
  // Only accounts holding more than a transfer fee are worth sweeping.
  const ed = BigInt((a.consts as any).balances?.existentialDeposit?.toString() ?? "0");
  const rich: any[] = [];
  for (const p of pairs) if ((await freeBalance(ws, p.address)) > ed * 2n) rich.push(p);
  await Promise.all(rich.map((p) => submit(a, (a.tx as any).balances.transferAll(to, false), { pair: p }, 30_000)));
}

export type SuiteEntry = { workflow: Workflow; path: string; sha256: string };
export type TestArgs = {
  baseline: string; candidate: string; suite: SuiteEntry[]; funder: Signer; injected?: string | null;
  timeoutMs?: number; fetchFile: (p: string) => Promise<string>; log?: Progress; onResult?: (r: any) => void;
  /** live chains: fund each test account with at most this much */
  fundCap?: bigint;
  /** a wallet funded the test accounts: one transaction per chain */
  onFunding?: (f: Funding) => void;
};
export async function runTest(a: TestArgs) {
  const runId = String(Math.floor(Date.now() / 1000));
  const ctx: Ctx = { runId, secret: mnemonicGenerate(12), funder: a.funder, timeoutMs: a.timeoutMs ?? 90_000, fetchFile: a.fetchFile, log: a.log ?? (() => {}), fundCap: a.fundCap };
  ctx.log("identifying runtimes");
  const manifest = {
    run_id: runId, canary_version: CANARY_VERSION, started_unix: Number(runId), suite_path: "tests/workflows",
    suite: a.suite.map((s) => ({ workflow: s.workflow.id, path: s.path, sha256: s.sha256 })),
    baseline: await identify(a.baseline), candidate: await identify(a.candidate), injected: a.injected ?? null,
  };
  if (a.funder.kind !== "dev") {
    const sides = [{ side: "baseline" as const, ws: a.baseline }, { side: "candidate" as const, ws: a.candidate }];
    ctx.prefunded = new Set();
    for (const ws of [...new Set(sides.map((x) => x.ws))]) {
      const f = await prefund(ctx, a.suite, sides, ws);
      ctx.prefunded.add(ws);
      ctx.log(`funded ${f.accounts} accounts · block #${f.block_number ?? "?"} · ${f.tx_hash.slice(0, 14)}…`);
      a.onFunding?.(f);
    }
  }
  const results: any[] = [];
  for (const { workflow: wf } of a.suite) {
    const b = await runSide(wf, "baseline", a.baseline, ctx);
    const c = await runSide(wf, "candidate", a.candidate, ctx);
    const finding = await classify(wf, b, c);
    const r = { finding, baseline: b, candidate: c, reproduce: `canary reproduce ${wf.id} --run runs/${runId}` };
    results.push(r);
    a.onResult?.(r);
  }
  return { manifest, summary: summarize(results), results };
}

/* ---------------- attest / verify (attest.rs) ---------------- */
export type Attestation = {
  network: string; chain: string | null; genesis_hash: string | null; payload: string; payload_hex: string;
  report_sha256: string; signer: string; tx_hash: string; block_hash: string; block_number: number | null;
};
export async function attest(ws: string, reportBytes: Uint8Array, signer: Signer): Promise<Attestation> {
  const { payload, report_sha256 } = await attestPayload(reportBytes);
  const payload_hex = stringToHex(payload);
  const a = await api(ws);
  const tx = a.tx.system.remark(payload_hex);
  const out = await submit(a, tx, await funderHandle(signer), 120_000);
  if (out.status !== "success") throw new Error(`remark not included: ${out.status} ${out.dispatch_error ?? ""}`);
  const [chain, genesis_hash, header] = await Promise.all([
    send(ws, "system_chain").catch(() => null), send(ws, "chain_getBlockHash", [0]).catch(() => null), send(ws, "chain_getHeader", [out.block_hash]).catch(() => null),
  ]);
  return {
    network: ws, chain, genesis_hash, payload, payload_hex, report_sha256,
    signer: signer.kind === "dev" ? signer.name : signer.address, tx_hash: tx.hash.toHex(),
    block_hash: out.block_hash, block_number: header ? parseInt(header.number, 16) : null,
  };
}
/** Sign any canary payload as a system.remark (used to record a run made elsewhere). */
export async function remark(ws: string, payload: string, signer: Signer) {
  const a = await api(ws);
  const tx = a.tx.system.remark(stringToHex(payload));
  const out = await submit(a, tx, await funderHandle(signer), 120_000);
  if (out.status !== "success") throw new Error(`remark not included: ${out.status} ${out.dispatch_error ?? ""}`);
  const header = await send(ws, "chain_getHeader", [out.block_hash]).catch(() => null);
  return { tx_hash: tx.hash.toHex(), block_hash: out.block_hash as string, block_number: header ? parseInt(header.number, 16) : null };
}
export async function verify(att: Attestation, reportBytes: Uint8Array, ws?: string) {
  const { payload, report_sha256 } = await attestPayload(reportBytes);
  const checks: { what: string; ok: boolean; detail: string }[] = [
    { what: "report file matches attested hash", ok: report_sha256 === att.report_sha256, detail: report_sha256 },
    { what: "payload rebuilt from report matches", ok: payload === att.payload, detail: payload },
  ];
  const net = ws ?? att.network;
  const genesis = await send(net, "chain_getBlockHash", [0]);
  checks.push({ what: "same chain (genesis hash)", ok: genesis === att.genesis_hash, detail: genesis });
  const block = await send(net, "chain_getBlock", [att.block_hash]);
  const needle = att.payload_hex.replace(/^0x/, "").toLowerCase();
  const found = (block?.block?.extrinsics ?? []).some((x: string) => x.toLowerCase().includes(needle));
  checks.push({ what: "remark present in attested block", ok: found, detail: att.block_hash });
  return checks;
}

/* ---------------- wallet helpers ---------------- */
export async function walletAccounts(extension: string): Promise<{ address: string; name?: string }[]> {
  const ext = (globalThis as any).injectedWeb3?.[extension];
  if (!ext) throw new Error(`${extension} is not installed`);
  return (await ext.enable("Portal Canary")).accounts.get();
}
export async function freeBalance(ws: string, address: string): Promise<bigint> {
  const id = keyring().decodeAddress(address);
  const raw = await send(ws, "state_getStorage", [accountKey(id)]);
  return raw ? decodeAccount(raw).free : 0n;
}
export { hexToString };
