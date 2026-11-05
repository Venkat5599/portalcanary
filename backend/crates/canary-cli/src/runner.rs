//! Executes one workflow against one runtime and records evidence.
//!
//! Accounts named in a workflow are namespaced per run and side
//! (`//canary/<run>/<side>/<workflow>/<name>`), so runs never share state and
//! both sides start from equivalent, freshly funded accounts.

use std::collections::BTreeMap;
use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Context};
use canary_chain::{invariant, storage};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::invariants::connect;
use crate::workflow::{Expect, Field, Workflow};

#[derive(Debug, Clone)]
pub struct Driver {
    pub bun: PathBuf,
    pub script: PathBuf,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct EventRec {
    pub name: String,
    pub data: Value,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct StepOutcome {
    pub index: usize,
    pub call: String,
    pub status: String,
    pub block_hash: Option<String>,
    pub dispatch_error: Option<String>,
    #[serde(default)]
    pub tx_hash: Option<String>,
    #[serde(default)]
    pub events: Vec<EventRec>,
}

#[derive(Deserialize)]
struct DriverOut {
    ok: bool,
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    accounts: BTreeMap<String, String>,
    #[serde(default)]
    results: Vec<StepOutcome>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ExpectOutcome {
    pub description: String,
    pub kind: &'static str,
    pub pass: bool,
    pub observed: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct SideRun {
    pub side: String,
    pub endpoint: String,
    pub setup_error: Option<String>,
    pub pre_block: Option<String>,
    pub post_block: Option<String>,
    pub steps: Vec<StepOutcome>,
    /// `account.field` -> signed change, e.g. `receiver.free` -> `+1000`.
    pub deltas: BTreeMap<String, String>,
    pub expectations: Vec<ExpectOutcome>,
}

impl Driver {
    /// Submit raw steps (no workflow namespacing) and return their outcomes.
    pub fn submit(&self, ws: &str, steps: Value) -> anyhow::Result<Vec<StepOutcome>> {
        Ok(self.run(&json!({ "ws": ws, "steps": steps }))?.results)
    }

    fn run(&self, job: &Value) -> anyhow::Result<DriverOut> {
        let mut child = Command::new(&self.bun)
            .arg(&self.script)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .with_context(|| format!("starting driver {}", self.bun.display()))?;
        child.stdin.take().context("driver stdin")?.write_all(job.to_string().as_bytes())?;
        let out = child.wait_with_output()?;
        let text = String::from_utf8_lossy(&out.stdout);
        let line = text.lines().last().ok_or_else(|| anyhow!("driver produced no output"))?;
        let parsed: DriverOut = serde_json::from_str(line).with_context(|| format!("driver output: {line}"))?;
        if !parsed.ok {
            bail!("driver error: {}", parsed.error.unwrap_or_default());
        }
        Ok(parsed)
    }
}

pub struct Namespace<'a> {
    pub run_id: &'a str,
    pub side: &'a str,
}

fn uri(ns: &Namespace, wf: &Workflow, name: &str) -> String {
    if wf.accounts.iter().any(|a| a == name) {
        format!("//canary/{}/{}/{}/{}", ns.run_id, ns.side, wf.id, name)
    } else {
        name.to_string()
    }
}

fn map_names(v: &Value, f: &dyn Fn(&str) -> String) -> Value {
    match v {
        Value::String(s) => Value::String(f(s)),
        Value::Array(a) => Value::Array(a.iter().map(|x| map_names(x, f)).collect()),
        Value::Object(o) => Value::Object(o.iter().map(|(k, x)| (k.clone(), map_names(x, f))).collect()),
        other => other.clone(),
    }
}

fn best_hash(rpc: &mut canary_chain::rpc::WsRpc) -> anyhow::Result<String> {
    rpc.call("chain_getBlockHash", json!([]))?
        .as_str()
        .map(String::from)
        .ok_or_else(|| anyhow!("no best block hash"))
}

type Balances = BTreeMap<String, (u128, u128)>;

fn read_balances(
    rpc: &mut canary_chain::rpc::WsRpc,
    ids: &BTreeMap<String, Vec<u8>>,
    at: &str,
) -> anyhow::Result<Balances> {
    ids.iter()
        .map(|(name, id)| {
            let info = invariant::account(rpc, id, at)?;
            Ok((name.clone(), info.map(|i| (i.free, i.reserved)).unwrap_or((0, 0))))
        })
        .collect()
}

fn signed(post: u128, pre: u128) -> i128 {
    post as i128 - pre as i128
}

fn fmt_signed(v: i128) -> String {
    if v >= 0 { format!("+{v}") } else { v.to_string() }
}

fn parse_i128(s: &str) -> anyhow::Result<i128> {
    s.trim_start_matches('+').parse().with_context(|| format!("not an integer: {s}"))
}


/// A dispatch expectation's `error` may list alternatives (`InsufficientBalance|FundsUnavailable`):
/// runtimes rename errors across versions (pallet-balances moved insufficient-funds failures to
/// `Token.FundsUnavailable`). Any alternative found in the observed error, case-insensitively, matches.
pub(crate) fn error_matches(want: &str, seen: Option<&str>) -> bool {
    let seen = seen.unwrap_or("").to_lowercase();
    want.split('|').map(str::trim).filter(|w| !w.is_empty()).any(|w| seen.contains(&w.to_lowercase()))
}

fn evaluate(
    e: &Expect,
    steps: &[StepOutcome],
    deltas: &BTreeMap<String, i128>,
    rpc: &mut canary_chain::rpc::WsRpc,
    post: &str,
) -> ExpectOutcome {
    let (pass, observed) = match e {
        Expect::Dispatch { step, status, error } => match steps.get(*step) {
            None => (false, "step did not run".into()),
            Some(s) => {
                let err_ok = match error {
                    None => true,
                    Some(want) => error_matches(want, s.dispatch_error.as_deref()),
                };
                let seen = match &s.dispatch_error {
                    Some(d) => format!("{} ({d})", s.status),
                    None => s.status.clone(),
                };
                (s.status == *status && err_ok, seen)
            }
        },
        Expect::Delta { account, field, eq, gt, lt } => {
            let key = format!("{account}.{}", match field { Field::Free => "free", Field::Reserved => "reserved" });
            match deltas.get(&key) {
                None => (false, format!("no observation for {key}")),
                Some(&d) => {
                    let check = |v: &Option<String>, f: fn(i128, i128) -> bool| -> anyhow::Result<bool> {
                        Ok(match v { Some(x) => f(d, parse_i128(x)?), None => true })
                    };
                    let pass = check(eq, |a, b| a == b).and_then(|a| Ok(a && check(gt, |a, b| a > b)? && check(lt, |a, b| a < b)?));
                    match pass {
                        Ok(p) => (p, fmt_signed(d)),
                        Err(err) => (false, format!("bad expectation: {err}")),
                    }
                }
            }
        }
        Expect::Event { step, name, absent, contains } => match steps.get(*step) {
            None => (false, "step did not run".into()),
            Some(s) => {
                let matching: Vec<&EventRec> = s.events.iter().filter(|ev| ev.name.eq_ignore_ascii_case(name)).collect();
                let found = match contains {
                    None => !matching.is_empty(),
                    Some(c) => matching.iter().any(|ev| ev.data.to_string().to_lowercase().contains(&c.to_lowercase())),
                };
                let observed = match (contains, matching.first()) {
                    (Some(_), Some(ev)) => format!("{} {}", ev.name, ev.data),
                    _ => {
                        let names: Vec<&str> = s.events.iter().map(|ev| ev.name.as_str()).collect();
                        if names.is_empty() { "no events".into() } else { names.join(", ") }
                    }
                };
                (found != *absent, observed)
            }
        },
        Expect::Invariant(n) if n == "supply_conservation" => match invariant::supply_at(rpc, post) {
            Ok(s) => (
                s.holds(),
                format!("accounts {} sum {} vs issuance {}", s.accounts, s.sum_free + s.sum_reserved, s.total_issuance),
            ),
            Err(err) => (false, format!("error: {err}")),
        },
        Expect::Invariant(n) => (false, format!("unknown invariant {n}")),
    };
    ExpectOutcome { description: e.describe(), kind: e.kind(), pass, observed }
}

pub fn run_side(wf: &Workflow, ns: &Namespace, ws: &str, driver: &Driver, timeout: Duration) -> SideRun {
    let mut run = SideRun {
        side: ns.side.into(),
        endpoint: ws.into(),
        setup_error: None,
        pre_block: None,
        post_block: None,
        steps: Vec::new(),
        deltas: BTreeMap::new(),
        expectations: Vec::new(),
    };
    if let Err(e) = execute(wf, ns, ws, driver, timeout, &mut run) {
        run.setup_error = Some(format!("{e:#}"));
    }
    run
}

/// The driver reports a step once it is in a block, which can be ahead of the state
/// the transaction pool validates against. Submitting the first step before the
/// funding is visible there gets it rejected as "unable to pay fees" (seen in CI on
/// the baseline == candidate control), so wait for every funded balance at the best block.
fn wait_funded(
    rpc: &mut canary_chain::rpc::WsRpc,
    wf: &Workflow,
    ids: &BTreeMap<String, Vec<u8>>,
    timeout: Duration,
) -> anyhow::Result<()> {
    let deadline = Instant::now() + timeout;
    loop {
        let best = best_hash(rpc)?;
        let balances = read_balances(rpc, ids, &best)?;
        let short = wf.fund.iter().find(|f| {
            let want: u128 = f.amount.parse().unwrap_or(0);
            balances.get(&f.account).is_none_or(|(free, _)| *free < want)
        });
        match short {
            None => return Ok(()),
            Some(f) if Instant::now() >= deadline => {
                bail!("funding of {} not visible at the best block after {}s", f.account, timeout.as_secs())
            }
            Some(_) => std::thread::sleep(Duration::from_millis(500)),
        }
    }
}

fn execute(wf: &Workflow, ns: &Namespace, ws: &str, driver: &Driver, timeout: Duration, run: &mut SideRun) -> anyhow::Result<()> {
    let name = |n: &str| uri(ns, wf, n);
    let uris: Vec<String> = wf.accounts.iter().map(|a| name(a)).collect();

    // Setup: fund namespaced accounts from a dev account. Not Alice: on the dev chain
    // all but ~1,000 POT of her balance is frozen by her validator stake, which a few
    // back-to-back runs exhaust (balances.LiquidityRestrictions). Charlie is unbonded.
    let fund_steps: Vec<Value> = wf
        .fund
        .iter()
        .map(|f| json!({ "call": "Balances.transfer", "signer": "charlie", "args": { "dest": name(&f.account), "value": f.amount } }))
        .collect();
    let setup = driver.run(&json!({ "ws": ws, "steps": fund_steps, "accounts": uris }))?;
    if let Some(bad) = setup.results.iter().find(|r| r.status != "success") {
        bail!("setup step {} {}: {}", bad.index, bad.status, bad.dispatch_error.clone().unwrap_or_default());
    }
    let ids: BTreeMap<String, Vec<u8>> = wf
        .accounts
        .iter()
        .map(|a| {
            let hex = setup.accounts.get(&name(a)).ok_or_else(|| anyhow!("driver returned no key for {a}"))?;
            Ok((a.clone(), storage::from_hex(hex)?))
        })
        .collect::<anyhow::Result<_>>()?;

    let mut rpc = connect(ws, timeout)?;
    wait_funded(&mut rpc, wf, &ids, timeout)?;
    let pre = best_hash(&mut rpc)?;
    let before = read_balances(&mut rpc, &ids, &pre)?;
    run.pre_block = Some(pre);

    let steps: Vec<Value> = wf
        .steps
        .iter()
        .map(|s| {
            json!({ "call": s.call, "signer": name(&s.signer), "sudo": s.sudo, "args": map_names(&s.args, &|x| name(x)) })
        })
        .collect();
    let out = driver.run(&json!({ "ws": ws, "steps": steps }))?;
    run.steps = out.results;

    let post = match run.steps.iter().rev().find_map(|s| s.block_hash.clone()) {
        Some(h) => h,
        None => best_hash(&mut rpc)?,
    };
    let after = read_balances(&mut rpc, &ids, &post)?;
    run.post_block = Some(post.clone());

    let mut deltas: BTreeMap<String, i128> = BTreeMap::new();
    for (acct, (pf, pr)) in &before {
        let (af, ar) = after[acct];
        deltas.insert(format!("{acct}.free"), signed(af, *pf));
        deltas.insert(format!("{acct}.reserved"), signed(ar, *pr));
    }
    run.deltas = deltas.iter().map(|(k, v)| (k.clone(), fmt_signed(*v))).collect();
    run.expectations = wf.expect.iter().map(|e| evaluate(e, &run.steps, &deltas, &mut rpc, &post)).collect();
    Ok(())
}

#[cfg(test)]
mod error_match_tests {
    use super::error_matches;
    #[test]
    fn error_alternatives_match_old_and_new_runtimes() {
        let want = "InsufficientBalance|FundsUnavailable";
        assert!(error_matches(want, Some("balances.InsufficientBalance")));
        assert!(error_matches(want, Some("{\"token\":\"FundsUnavailable\"}")));
        assert!(!error_matches(want, Some("balances.ExistentialDeposit")));
        assert!(!error_matches(want, None));
    }
}
