#!/usr/bin/env python3
"""Turn one upgrade-check run's files into the markdown posted on the pull request.

    summary.py <out dir>   -> prints markdown; exit code 0 always (the verdict is decided by the action)
"""
import json, os, sys

out = sys.argv[1]
def load(name):
    p = os.path.join(out, name)
    try:
        return json.load(open(p))
    except Exception:
        return None

POT = 10 ** 14
def pot(planck):
    v = int(str(planck).lstrip("+"))
    s = f"{abs(v) / POT:,.4f}".rstrip("0").rstrip(".")
    return ("-" if v < 0 else "") + s

up, cmp, rep, fork = load("upgrade.json"), load("compare.json"), load("report.json"), load("fork-meta.json")
lines = ["<!-- portal-canary-upgrade-check -->", "### Portal Canary · upgrade check", ""]

where = f"mainnet state at block #{fork['block']:,} ({fork['accounts']:,} accounts)" if fork else "a fresh dev chain"
if not up:
    err = open(os.path.join(out, "upgrade.txt")).read()[-600:] if os.path.exists(os.path.join(out, "upgrade.txt")) else "no output"
    lines += [f"**Could not apply the runtime** on {where}.", "", "```", err.strip(), "```"]
    print("\n".join(lines)); sys.exit(0)

st = up["state"]
halted = not str(up.get("liveness", "")).startswith("ok")
verdict = "🔴 **Chain halts after the upgrade**" if halted else (
    f"🔴 **{st['severity']}: {st['rationale']}**" if st["verdict"] == "REGRESSION" else
    f"🟡 **{st['verdict']}: {st['rationale']}**" if st["verdict"] != "PASS" else
    f"🟢 **Pass: {st['rationale']}**")
lines += [verdict, "", f"Upgraded a copy of {where} with `setCode`, spec {up['spec_before']} → {up['spec_after']}.", ""]
b, a = st["before"], st["after"]
lines += ["| | before | after |", "|---|---|---|",
          f"| blocks | #{b['block_number']} | #{a['block_number']} ({up['liveness']}) |",
          f"| accounts | {b['accounts']:,} | {a['accounts']:,} |",
          f"| total issuance | {pot(b['total_issuance'])} POT | {pot(a['total_issuance'])} POT |",
          f"| held by accounts | {pot(int(b['sum_free']) + int(b['sum_reserved']))} POT | {pot(int(a['sum_free']) + int(a['sum_reserved']))} POT |", ""]
ch = st.get("changes") or []
if ch:
    lines += [f"<details{' open' if st['verdict'] == 'REGRESSION' else ''}><summary>{len(ch)} account{'s' if len(ch) != 1 else ''} changed</summary>", "",
              "| account | free | reserved | change |", "|---|---|---|---|"]
    for c in ch[:25]:
        lines.append(f"| `{c['address']}` | {pot(c['free_before'])} → {pot(c['free_after'])} | {pot(c['reserved_before'])} → {pot(c['reserved_after'])} | {pot(c['total_delta'])} |")
    if len(ch) > 25:
        lines.append(f"| … {len(ch) - 25} more in `upgrade.json` | | | |")
    lines += ["", "</details>", ""]

if cmp:
    risks = cmp.get("risks") or []
    order = ["critical", "breaking", "migration", "behaviour", "client"]
    counts = {k: sum(1 for r in risks if r["severity"] == k) for k in order}
    lines.append(f"**Runtime diff:** {len(cmp.get('changes', []))} changes, {len(risks)} risks" +
                 (" (" + ", ".join(f"{n} {k}" for k, n in counts.items() if n) + ")" if risks else "") + ".")
    if risks:
        lines += ["", "<details><summary>Risks</summary>", ""]
        for r in sorted(risks, key=lambda r: order.index(r["severity"]) if r["severity"] in order else 9)[:15]:
            lines.append(f"- **{r['severity']}** · {r['title']}: {r['why']}")
        lines += ["", "</details>"]
    lines.append("")

if rep:
    s = rep["summary"]
    lines.append(f"**Workflows** (on both chains): {s['statement']}")
    rows = [(x["finding"]["workflow"], x["finding"]["verdict"], x["finding"]["severity"]) for x in rep.get("results", [])]
    if rows:
        lines += ["", "| workflow | verdict | severity |", "|---|---|---|"] + [f"| `{w}` | {v} | {sv} |" for w, v, sv in rows]
    lines.append("")

lines.append(f"<sub>Portal Canary upgrade-check · runtime sha256 `{up['wasm_sha256'][:16]}…` · files attached to the workflow run</sub>")
print("\n".join(lines))
