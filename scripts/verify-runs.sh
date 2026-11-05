#!/usr/bin/env bash
# Re-check every run kept on the repository's `runs` release, with no key and no account:
#   1. download <run id>.zip (public),
#   2. every file in it must match the sha256 that result.json lists for it,
#   3. `canary verify` rebuilds the remark from result.json and finds it in the recorded V3 block.
# Prints one line per run, then a total. Exit 1 if any recorded run fails a check.
#
#   bash scripts/verify-runs.sh      (uses backend/target/release/canary if built, else the prebuilt CLI)
set -uo pipefail
REPO="${REPO:-Venkat5599/portalcanary}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CANARY="${CANARY:-$ROOT/backend/target/release/canary}"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
if [ ! -x "$CANARY" ]; then
  # No local build: use the prebuilt CLI from the `cli` release, checked against its published sha256.
  case "$(uname -sm)" in
    "Linux x86_64") ASSET=canary-x86_64-linux ;;
    "Darwin arm64") ASSET=canary-aarch64-macos ;;
    *) echo "no prebuilt CLI for $(uname -sm): cd backend && cargo build --release"; exit 2 ;;
  esac
  U="https://github.com/$REPO/releases/download/cli/$ASSET"
  CANARY="$WORK/canary"
  curl -fsSL -o "$CANARY" "$U" || { echo "could not download $U"; exit 2; }
  want="$(curl -fsSL "$U.sha256")"; got="$(shasum -a 256 "$CANARY" | cut -d' ' -f1)"
  [ "$want" = "$got" ] || { echo "sha256 mismatch for $ASSET: $got != $want"; exit 2; }
  chmod +x "$CANARY"
  echo "using prebuilt $ASSET (sha256 $got)"
fi

ids=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/tags/runs" \
  | python3 -c 'import json,sys; [print(a["name"][:-4]) for a in sorted(json.load(sys.stdin)["assets"], key=lambda a: a["created_at"])]')

total=0; recorded=0; ok=0; failed=0
for id in $ids; do
  total=$((total + 1))
  d="$WORK/$id"; mkdir -p "$d"
  curl -fsSL -o "$d.zip" "https://github.com/$REPO/releases/download/runs/$id.zip" && unzip -q -o "$d.zip" -d "$d"
  line=$(python3 - "$d" <<'EOF'
import hashlib, json, os, sys
d = sys.argv[1]
r = json.load(open(os.path.join(d, "result.json")))
sha = r.get("sha256") or {}
bad = [f for f, h in sha.items() if h and (not os.path.exists(os.path.join(d, f)) or hashlib.sha256(open(os.path.join(d, f), "rb").read()).hexdigest() != h)]
st = r.get("state") or {"kind": "dev"}
where = f"mainnet #{st['block']}" if st.get("kind") == "mainnet" else "fresh chain"
e = r["exit"]
word = lambda c: {0: "pass", 1: "caught", 2: "inconclusive", None: "-"}.get(c, "?")
verdict = "halted" if r.get("halted") else word(e.get("upgrade"))
files = f"{len(sha) - len(bad)}/{len(sha)} files" if sha else "no hash map"
print(f"{r['candidate']['name']:<15} {where:<16} upgrade={verdict:<7} tests={word(e.get('test')):<7} {files}")
EOF
)
  if [ -f "$d/attestation.json" ]; then
    recorded=$((recorded + 1))
    if out=$("$CANARY" verify --run "$d" 2>&1) && echo "$out" | grep -q VERIFIED; then
      ok=$((ok + 1))
      block=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["block_number"])' "$d/attestation.json")
      echo "$id  $line  V3 #$block VERIFIED"
    else
      failed=$((failed + 1)); echo "$id  $line  V3 record FAILED: $(echo "$out" | tail -1)"
    fi
  else
    reason=$( [ -f "$d/attest-error.txt" ] && tail -1 "$d/attest-error.txt" | cut -c1-60 || echo "no record (run predates on-chain records)")
    echo "$id  $line  not recorded: $reason"
  fi
done
echo "runs $total · recorded on V3 $recorded · verified $ok · failed $failed"
[ "$failed" = 0 ]
