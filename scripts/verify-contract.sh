#!/usr/bin/env bash
# Re-check the CanaryRegistry contract on the PortaldotV3 EVM with curl and python3 only: no key,
# no Foundry, no Rust. It checks that
#   1. code is deployed at the address, and the deploy transaction succeeded and created it;
#   2. count() and every stored record, read with get(i);
#   3. each record's reportHash is the sha256 of a report.json committed in examples/, and its
#      regression/difference/inconclusive/pass counts equal that report's summary;
#   4. each attest transaction succeeded and emitted Attested from this contract.
#
#   bash scripts/verify-contract.sh
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RPC="${RPC:-https://test-evm-rpc-v3.portaldot.dev}"
ADDR="${ADDR:-0x62Eacc58CE0FA37F06F24074AFb7B3F22Df708FF}"
DEPLOY_TX="0xadb58c0b7ff356a1304e8422b7f606782c91e39460bca2ab9ace133cc8656ed2"
ATTEST_TXS="0x1d15ca01d3bdf11f2062b182dfca7b378c8a05278beb7e6b2f8e49a5a2ab7a30 0x0017a02af40acdc883ad8807a1fd6f054b80b4275c8d2e87d33db662a61360eb 0xb14a42825cc241b933f92a87cffd5897fd8b13cdc4e49c649e388639d9175248 0x4b4d542edd6275e6f023082fed68ab4e2ea392caea4145ed66b468468cf1bc95"

RPC="$RPC" ADDR="$ADDR" DEPLOY_TX="$DEPLOY_TX" ATTEST_TXS="$ATTEST_TXS" ROOT="$ROOT" python3 - <<'EOF'
import glob, hashlib, json, os, sys, urllib.request
rpc, addr = os.environ["RPC"], os.environ["ADDR"].lower()
def call(method, params):
    req = urllib.request.Request(rpc, json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode(), {"content-type": "application/json", "user-agent": "verify-contract"})
    r = json.load(urllib.request.urlopen(req, timeout=30))
    if "error" in r: raise SystemExit(f"{method}: {r['error']}")
    return r["result"]
fails = 0
def check(ok, what):
    global fails
    fails += 0 if ok else 1
    print(("ok   " if ok else "FAIL ") + what)

chain = int(call("eth_chainId", []), 16)
code = call("eth_getCode", [addr, "latest"])
check(len(code) > 2, f"code at {addr} on chain {chain}: {(len(code) - 2) // 2} bytes")
d = call("eth_getTransactionReceipt", [os.environ["DEPLOY_TX"]])
check(d and d["status"] == "0x1" and (d.get("contractAddress") or "").lower() == addr, f"deploy tx succeeded in block {int(d['blockNumber'], 16)} and created this address")

count = int(call("eth_call", [{"to": addr, "data": "0x06661abd"}, "latest"]), 16)
check(count > 0, f"count() = {count}")

reports = {}
for p in glob.glob(os.path.join(os.environ["ROOT"], "examples", "*", "report.json")):
    raw = open(p, "rb").read()
    reports["0x" + hashlib.sha256(raw).hexdigest()] = (os.path.relpath(p, os.environ["ROOT"]), json.loads(raw)["summary"])

for i in range(count):
    out = call("eth_call", [{"to": addr, "data": "0x9507d39a" + f"{i:064x}"}, "latest"])[2:]
    w = [out[k:k + 64] for k in range(0, 640, 64)]
    report_hash, regs, diffs, inc, passes = "0x" + w[0], int(w[4], 16), int(w[5], 16), int(w[6], 16), int(w[7], 16)
    base, cand = int(w[2], 16), int(w[3], 16)
    hit = reports.get(report_hash)
    if not hit:
        check(False, f"record {i}: reportHash {report_hash[:18]}… matches no committed report.json")
        continue
    path, s = hit
    same = [regs, diffs, inc, passes] == [s.get("regression", 0), s.get("difference", 0), s.get("inconclusive", 0), s.get("pass", 0)]
    check(same, f"record {i}: = sha256({path}); spec {base} -> {cand}; regressions {regs}, differences {diffs}, inconclusive {inc}, passes {passes}")

topic = "0x44506575039602b89b36bc543711dc1f190ee272569f347970ca5d1e8d0d7f8e"  # Attested(uint256,bytes32,bytes32,address,uint16)
for tx in os.environ["ATTEST_TXS"].split():
    r = call("eth_getTransactionReceipt", [tx])
    logs = [l for l in r["logs"] if l["address"].lower() == addr and l["topics"][0] == topic]
    check(r["status"] == "0x1" and len(logs) == 1, f"attest {tx[:18]}… block {int(r['blockNumber'], 16)}: success, Attested id {int(logs[0]['topics'][1], 16) if logs else '?'}")

print(f"{'VERIFIED' if not fails else 'FAILED'}: CanaryRegistry {addr} on chain {chain}, {count} records")
sys.exit(1 if fails else 0)
EOF
