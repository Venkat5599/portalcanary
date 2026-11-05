import type { Metadata } from "next";
import "./deck.css";
import Scale from "./Scale";

export const metadata: Metadata = {
  title: "Portal Canary · pitch deck",
  description: "Test a Portaldot runtime upgrade on a copy of today's mainnet, before it touches mainnet. Venkat.",
};

const SITE = "portal-canary-app.vercel.app";
const REPO = "github.com/Venkat5599/portalcanary";
const N = 10;

function Slide({ n, kicker, children }: { n: number; kicker?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="frame">
      <div className="slide">
        {kicker && <p className="kicker">{kicker}</p>}
        <div className="body">{children}</div>
        <div className="foot"><span>Portal Canary · Venkat</span><span>{String(n).padStart(2, "0")} / {N}</span></div>
      </div>
    </section>
  );
}

export default function Deck() {
  return (
    <main className="deck">
      <Scale />
      <div className="wrap">
        <Slide n={1}>
          <div style={{ margin: "auto 0", display: "grid", gap: 28 }}>
            <p className="kicker"><b>Node Operations &amp; Tooling</b> · Portaldot</p>
            <h1>Portal Canary</h1>
            <p className="lead">I test a Portaldot runtime upgrade on a copy of today&apos;s mainnet, and check every account, before the upgrade ever touches mainnet.</p>
            <p className="mute" style={{ fontSize: 20 }}>Venkat · <a href={`https://${SITE}`}>{SITE}</a> · <a href={`https://${REPO}`}>{REPO}</a></p>
          </div>
        </Slide>

        <Slide n={2} kicker="The problem">
          <h2>An upgrade can look perfect and still destroy money.</h2>
          <div className="grid" style={{ gridTemplateColumns: "repeat(3, 1fr)", marginTop: 40 }}>
            <div className="card"><h3><span className="ok">✓</span> setCode accepted</h3><p>The extrinsic succeeds and spec_version goes from 1002 to 1006.</p></div>
            <div className="card"><h3><span className="ok">✓</span> Blocks keep coming</h3><p>Three new blocks under the new runtime, finalized, no error anywhere.</p></div>
            <div className="card" style={{ borderColor: "#5a2523" }}><h3><span className="bad">✗</span> Every balance survived</h3><p>286.305 POT gone from 9 real accounts. Total supply still claims it exists.</p></div>
          </div>
          <p style={{ marginTop: 36, maxWidth: 1040 }}>I built a runtime whose migration halves every reserved balance and ran it on a copy of mainnet. Every signal the chain gives said the upgrade worked. The only thing that showed it was checking the money, account by account.</p>
        </Slide>

        <Slide n={3} kicker="Why Portaldot">
          <h2>This has to be built for Portaldot specifically.</h2>
          <div className="grid" style={{ gridTemplateColumns: "1fr 1fr", marginTop: 36 }}>
            <div className="card"><h3>Mainnet speaks an old format</h3><p>Portaldot mainnet runs a 2021 runtime with metadata V13. Current Substrate tooling reads V14 and up, so it can&apos;t decode mainnet at all. I wrote a decoder for both V13 and V14.</p></div>
            <div className="card"><h3>No upgrade-testing API on mainnet</h3><p>Mainnet exposes 13 runtime APIs and none of them is for trying an upgrade. Every upgrade is one setCode, live.</p></div>
            <div className="card"><h3>The V3 move is the big one</h3><p>Mainnet against the V3 testnet: 969 changes and 111 risks. 3 are critical: two would stop block production, and setCode would refuse the third outright.</p></div>
            <div className="card"><h3>The proof lives on Portaldot</h3><p>Every run is recorded on the Portaldot V3 testnet, and the results registry is a contract on the V3 EVM.</p></div>
          </div>
        </Slide>

        <Slide n={4} kicker="How it works">
          <h2>One run: fork mainnet, upgrade the fork, check everything, record it.</h2>
          <div className="grid" style={{ gridTemplateColumns: "repeat(5, 1fr)", marginTop: 44 }}>
            {[
              ["01", "Fork mainnet", "Its latest finalized block: all 4,716 accounts, deposits, locks, stakes. Takes about 15 seconds."],
              ["02", "Upgrade the fork", "setCode with the candidate runtime, on a local chain that only we control."],
              ["03", "Check", "Every balance and the total supply, before and after. Blocks still produced. Runtime risks. 5 workflows on both sides."],
              ["04", "Record", "One file hashes every result file. Its hash goes on the V3 testnet."],
              ["05", "Verify", "The run page re-checks the record in your browser. A script re-checks every run, no key needed."],
            ].map(([n, t, d]) => (
              <div key={n} className="card step"><span className="n">{n}</span><h3>{t}</h3><p>{d}</p></div>
            ))}
          </div>
          <p className="mute" style={{ marginTop: 32 }}>Mainnet itself is never written to. The upgrade step refuses any chain that reports itself as live.</p>
        </Slide>

        <Slide n={5} kicker="Proof · a run on real mainnet state">
          <div className="grid" style={{ gridTemplateColumns: "1.45fr 1fr", alignItems: "stretch", flex: 1, minHeight: 0 }}>
            <div className="shot"><img src="/deck/run-mainnet.webp" alt="Run 971a7223bf7b: Critical on mainnet state" /></div>
            <div style={{ display: "grid", gap: 22, alignContent: "start" }}>
              <h2 style={{ fontSize: 36 }}>Critical, on mainnet block #2,747,398.</h2>
              <div className="stat"><span className="num">286.305 POT</span><span>destroyed by the migration</span></div>
              <div className="stat"><span className="num">9 of 9</span><span>real accounts with deposits lost half, each listed with before and after</span></div>
              <div className="stat"><span className="num">0</span><span>accounts changed when the clean runtime ran the same way</span></div>
              <p className="mono mute" style={{ fontSize: 15 }}>runs 971a7223bf7b, bbbf22879a6a (caught) · 4be59393add6, a98bc8ba5969 (clean)</p>
            </div>
          </div>
        </Slide>

        <Slide n={6} kicker="Proof · on-chain, checkable by anyone">
          <div className="grid" style={{ gridTemplateColumns: "1fr 1.3fr", alignItems: "stretch", flex: 1, minHeight: 0 }}>
            <div style={{ display: "grid", gap: 20, alignContent: "start" }}>
              <h2 style={{ fontSize: 36 }}>You don&apos;t have to trust the page.</h2>
              <p>Each run writes one result file holding the sha256 of every other file. That hash is written to the V3 testnet. The run page checks all three links itself: the files, the result, the block.</p>
              <div className="stat"><span className="num">10 of 10</span><span>recorded runs verify against V3 (29 Oct 2026), re-checked by a script that needs no key or account</span></div>
              <p className="mono mute" style={{ fontSize: 15 }}>V3 blocks #234,189 · #237,962 · #238,224 · #239,489 · #240,062 …</p>
            </div>
            <div className="shot"><img src="/deck/run-proof.webp" alt="On-chain record card: verified" /></div>
          </div>
        </Slide>

        <Slide n={7} kicker="Proof · it runs every day">
          <div className="grid" style={{ gridTemplateColumns: "1.3fr 1fr", alignItems: "stretch", flex: 1, minHeight: 0 }}>
            <div className="shot"><img src="/deck/compare.webp" alt="Compare mainnet to V3: 969 changes, 111 risks" /></div>
            <div style={{ display: "grid", gap: 20, alignContent: "start" }}>
              <h2 style={{ fontSize: 34 }}>Compare any two nodes. Check mainnet every morning.</h2>
              <ul className="clean">
                <li>Compare judges every runtime difference with a severity, the reason, and the values before and after. Mainnet against itself: 0 and 0.</li>
                <li>A daily check runs the clean and the broken runtime on fresh mainnet state. On day one it caught a real bug in my own recording step and opened an issue; it closed it after the fix.</li>
                <li>117 tests. CI forks mainnet and requires the broken migration to be caught.</li>
              </ul>
            </div>
          </div>
        </Slide>

        <Slide n={8} kicker="Where it stands">
          <h2>Live today, on the testnet.</h2>
          <table style={{ marginTop: 32 }}>
            <tbody>
              <tr><td>Dashboard</td><td><a href={`https://${SITE}/dashboard`}>{SITE}/dashboard</a>: new runs, run pages, Compare, Doctor, Supply, Registry, On your node</td></tr>
              <tr><td>Runs</td><td>21 kept, 10 recorded on V3 and all 10 verified, 9 on real mainnet state (29 Oct 2026)</td></tr>
              <tr><td>Registry contract</td><td className="mono">0x62Eacc58CE0FA37F06F24074AFb7B3F22Df708FF · V3 EVM, chain 420420777 · 4 verdicts stored</td></tr>
              <tr><td>On your node</td><td>the workflow suite from your own browser against your own node; one wallet approval funds the whole run</td></tr>
              <tr><td>Engine</td><td>Rust: V13 + V14 decoder, diff, risk rules; the same code runs in the browser as WebAssembly</td></tr>
              <tr><td>Tests</td><td>42 Rust · 33 unit · 38 browser · 4 contract · CI green</td></tr>
            </tbody>
          </table>
        </Slide>

        <Slide n={9} kicker="What support makes possible">
          <h2>Make this part of how every Portaldot upgrade ships.</h2>
          <div className="grid" style={{ gridTemplateColumns: "1fr 1fr", marginTop: 34 }}>
            <div className="card"><h3>Gate runtime changes</h3><p>A check on every runtime pull request: fork mainnet, upgrade, post the verdict and the account table before anyone merges.</p></div>
            <div className="card"><h3>Mainnet&apos;s exact runtime</h3><p>Today the fork runs mainnet&apos;s state on the dev runtime. Next: mainnet&apos;s own runtime and its 60-second slots.</p></div>
            <div className="card"><h3>V3 upgrades</h3><p>The same run for V3&apos;s own future upgrades. The V14 decoder already reads it, and contract state comes next.</p></div>
            <div className="card"><h3>Operators</h3><p>Endpoint checks and alerts for the public nodes, so a broken endpoint is noticed before users notice it.</p></div>
          </div>
        </Slide>

        <Slide n={10}>
          <div style={{ margin: "auto 0", display: "grid", gap: 26 }}>
            <h1 style={{ fontSize: 72 }}>Before the upgrade, not after.</h1>
            <p className="lead">Try a run: open the dashboard, pick a runtime, keep Mainnet state, press Start run.</p>
            <p style={{ fontSize: 22 }}><a href={`https://${SITE}/dashboard`}>{SITE}/dashboard</a></p>
            <p style={{ fontSize: 22 }}><a href={`https://${REPO}`}>{REPO}</a></p>
            <p className="mute" style={{ fontSize: 20, marginTop: 12 }}>Thank you. Venkat</p>
          </div>
        </Slide>
      </div>
    </main>
  );
}
