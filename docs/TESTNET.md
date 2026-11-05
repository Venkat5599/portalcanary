# Testnet Development

How Portal Canary builds on and deploys to the Portaldot V3 testnet: endpoints, chain parameters, what lives on-chain, how to reproduce every record, and what we hit along the way.

For the dated log of every endpoint check, see [`V3_READINESS.md`](V3_READINESS.md).

## Network

| | PortaldotV3 Testnet | Portaldot Mainnet (baseline) |
|---|---|---|
| Substrate WS | `wss://test-node-v3.portaldot.dev` | `wss://mainnet.portaldot.io` |
| EVM RPC | `https://test-evm-rpc-v3.portaldot.dev` | none |
| EVM chain id | `420420777` (`0x190f1ca9`) | none |
| Explorer | `https://node-console.portaldot.dev` | Portaldot explorer |
| Genesis hash | `0xd4f9acbcf7f52388d8b095abe3c198d19fc510e0343e643e87cfbccb155283bd` | `0x83b5212c69f85f3996f8696bb35bf913af51b176a5f53d0a74fd3a83dc0b8a54` |
| Runtime | `portaldot-v3` spec 3002, tx_version 2 | `portaldot` spec 1002, tx_version 2 |
| Node | `PortaldotV3 Node 3.0.0-dev-fddd43141f2` | 2.0.0 |
| Metadata | V14, 69 pallets | V13, 31 pallets |
| Token | tPOT, 14 decimals on Substrate, 18 on the EVM side | POT, 14 decimals |
| SS58 prefix | 42 | 42 |
| Contracts | WASM contracts and EVM (pallet-revive, `ReviveApi`) | WASM contracts only |
| Block time | 6 s | 60 s |

The endpoints above are the official ones announced on 2026-10-17. The earlier `feso-apps.xyz` endpoints are retired.

### Adding the network to a wallet

- **Substrate wallets** (Talisman, SubWallet, Polkadot.js): add a custom network with the WS URL above.
- **EVM wallets** (MetaMask and similar): the dashboard's wallet button calls `wallet_addEthereumChain` with chain id `420420777`, the EVM RPC above, and `tPOT` as the native currency (18 decimals). Config lives in [`frontend/lib/wallet.ts`](../frontend/lib/wallet.ts).

### Getting tPOT

tPOT comes from the Portaldot team through Discord. Keep keys used for testnet work dedicated to the testnet and fund them with only what they spend.

## What we deploy on V3

### 1. Run records (`system.remark`)

Every Canary run produces `result.json`, which holds the sha256 of every other file in the run. `canary attest` writes the sha256 of `result.json` to V3 as a `system.remark`:

```text
canary-run/1 <sha256 of result.json> <run id> u=<upgrade> c=<compare> t=<test> h=<halted>
```

- Signed by a dedicated testnet key (`CANARY_ATTEST_SEED`, stored only in GitHub Actions secrets).
- Cost: about 0.022 tPOT per record. The key was funded with 10 tPOT on 29 Oct 2026, roughly 450 records.
- On a nonce clash (`1014 Priority is too low`) or an outdated transaction (`1010`), the workflow retries after a short random wait, up to four times.
- If the key runs out of tPOT, the run still completes and the run page shows why it was not recorded.

Status on 29 Oct 2026: 17 kept runs, 6 recorded on V3, 6 verified, 0 failed. Latest record in V3 block #238,224 (run `bbbf22879a6a`).

### 2. `CanaryRegistry` contract (V3 EVM)

[`contracts/src/CanaryRegistry.sol`](../contracts/src/CanaryRegistry.sol), a verdict registry built with Foundry (solc 0.8.28, `evm_version = cancun`). pallet-revive accepts plain solc EVM bytecode, so no `resolc` step is needed.

| | |
|---|---|
| Address | `0x62Eacc58CE0FA37F06F24074AFb7B3F22Df708FF` |
| Deploy tx | `0xadb58c0b7ff356a1304e8422b7f606782c91e39460bca2ab9ace133cc8656ed2` |
| Code size | 2,614 bytes |
| Deploy cost | about 217 tPOT |
| Cost per `attest` | about 27 tPOT, mostly the storage deposit |

Recorded attestations:

| Id | Run | Tx hash | Block |
|---|---|---|---|
| 0 | `upgrade-halve-reserved` | `0x1d15ca01d3bdf11f2062b182dfca7b378c8a05278beb7e6b2f8e49a5a2ab7a30` | #175,877 |
| 1 | `upgrade-ed100x` | `0x0017a02af40acdc883ad8807a1fd6f054b80b4275c8d2e87d33db662a61360eb` | #175,886 |
| 2 | `upgrade-fee10x` | `0xb14a42825cc241b933f92a87cffd5897fd8b13cdc4e49c649e388639d9175248` | #175,891 |
| 3 | `self-compare` | `0x4b4d542edd6275e6f023082fed68ab4e2ea392caea4145ed66b468468cf1bc95` | #175,893 |

Because storage deposits make contract records costly, the cheap `system.remark` is the primary record and the registry is the EVM showcase.

## Verify everything yourself

No key, no account and no Rust toolchain needed: without a local build, `verify-runs.sh` downloads the prebuilt `canary` from the [`cli` release](https://github.com/Venkat5599/portalcanary/releases/tag/cli) and checks its sha256, and `verify-contract.sh` uses only `curl` and `python3`.

```bash
# Every run on the `runs` release: file hashes, remark rebuilt, remark found in its V3 block
scripts/verify-runs.sh

# CanaryRegistry: code + deploy tx, every record against the committed report.json, every attest tx
scripts/verify-contract.sh

# One run
canary verify --run examples/upgrade-halve-reserved

# Registry entry count
cast call --rpc-url https://test-evm-rpc-v3.portaldot.dev \
  0x62Eacc58CE0FA37F06F24074AFb7B3F22Df708FF "count()(uint256)"

# Endpoint health, layer by layer (DNS, TCP, WebSocket, RPC, runtime APIs)
canary doctor --ws wss://test-node-v3.portaldot.dev

# Structural diff of mainnet against V3
canary compare --baseline wss://mainnet.portaldot.io --candidate wss://test-node-v3.portaldot.dev
```

`canary verify` checks that the run file matches the attested hash, that the remark's chain has the expected genesis hash, and that the remark is present in the attested block. The run page in the dashboard repeats these checks in the browser.

## Writing to V3

```bash
# Record a run (signs with CANARY_SIGNER_URI when --signer env)
canary attest --run <dir> --ws wss://test-node-v3.portaldot.dev --signer env --timeout 120

# Record a run in the registry contract (needs Foundry's `cast` and CANARY_EVM_KEY in env or .env.canary)
bun scripts/registry-attest.ts examples/<run>
```

| Secret | Where it lives | Used for |
|---|---|---|
| `CANARY_ATTEST_SEED` | GitHub Actions secrets | signs each run's `system.remark` |
| `CANARY_EVM_KEY` | local `.env.canary` (git-ignored) | signs `CanaryRegistry.attest` |
| `CANARY_GH_TOKEN` | Vercel function env | starts runs from the dashboard |

Seeds and keys are never printed or written to run files; `attestation.json` records the signer as `env`.

CI wiring: [`.github/workflows/canary-run.yml`](../.github/workflows/canary-run.yml) records each run on V3; [`.github/workflows/daily-check.yml`](../.github/workflows/daily-check.yml) reruns known cases and flags any run that was not recorded.

## Local development node

For offline work, the Portaldot dev node (named "testnet" in the download, but it is a local dev chain on the mainnet-era runtime):

```bash
curl -LO https://github.com/portaldotVolunteer/Portaldot-node/raw/main/portaldot-testnet-ubuntu.tar.gz
tar -xzf portaldot-testnet-ubuntu.tar.gz
./portaldot-testnet-ubuntu/portaldot_dev --dev --tmp
# ws://127.0.0.1:9944
```

Results from this node do not transfer to mainnet automatically: with the same spec_version it differs from mainnet in 12 constants (for example `Babe.EpochDuration` 120 vs 1200). Canary reports this instead of assuming the two match.

## Findings from building on V3

- **V3 is a new chain, not an upgrade of mainnet.** Mainnet to V3: 969 structural changes and 111 risks (3 critical). 21 pallet indices moved and the slot duration changed, so applying the V3 runtime to mainnet with `setCode` would halt block production and break every client that encodes calls by index.
- **Mainnet metadata is V13.** Current Substrate tooling decodes V14 and up, so `canary-chain` decodes V13 and V14 itself over raw JSON-RPC and SCALE.
- **V3 metadata hash is not stable.** Same size and spec version, but the sha256 changes every few minutes. One byte at offset 549,822, inside the default value of `Revive.EthBlockBuilderIR`, is computed from live state. Tools that pin metadata by hash (including the `CheckMetadataHash` off-chain flow) will see "new" metadata with no runtime change. Canary judges these changes on structure, so the V3 vs V3 control reports 0 changes.
- **Paged-key RPC quirk.** `getKeysPaged(prefix, n, undefined, at)` returned nothing on this node while raw `state_getKeysPaged` with `null` worked, so the fork code talks raw JSON-RPC.
- **Concurrent signers clash.** Two runs signing with one key at the same moment produced `1014 Priority is too low`; the record step now retries.
- **Storage deposits dominate EVM costs.** Budget about 27 tPOT per registry write before attesting many runs.
