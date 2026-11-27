# LocalDrop network recovery

## Baseline

The workspace starts at `ffb2b0e`, also the reported deployment revision. The deployed revision still needs independent confirmation. Recent changes in `628a814`, `f81b134` and `ffb2b0e` modified relay flow control, heartbeat, offer/socket lifecycle, early signals and path agreement. The Node server is a legacy implementation. Use the Cloudflare Worker for meaningful relay tests.

The React client uses `usePeerDrop` for rooms, authenticated resume, negotiation, transport selection, file approval and transfer lifecycle. The Worker routes requests to one named SQLite-backed Durable Object. It owns two-participant rooms, socket attachments, resume credentials and relay ledgers. Binary relay routing uses room membership and ledger direction. TURN issuance is origin-restricted and uses a room-bound active resume credential plus server-side quotas.

Network v2 uses one reliable ordered control DataChannel and four reliable ordered bulk DataChannels on one SCTP association. All five must be open for path agreement. The signaling WebSocket carries ICE and path agreement, and provides fallback data transport. Relay can commit after 2.5 seconds while RTC continues racing, with a roughly 30-second RTC readiness budget. Transfers pin their path. The sender reads and hashes sequentially and strips data across the four bulk channels. The receiver reorders within a 4 MiB credit window, writes to a bounded memory or OPFS/file sink, hashes in order, then acknowledges verified completion. Legacy flows remain in the same hook.

## Confirmed from source

- Relay credit shares a 40-message/s control bucket with unrelated JSON control. At maximum relay frame size the receiver usually emits credit every two frames because two 262,136-byte payloads cross the 256 KiB threshold. At nominal 28 MiB/s this is about 56 credits/s before JSON traffic. The burst can mask the mismatch on short transfers. Once exhausted, the handler drops valid credit and attempts to abort the credit emitter's outgoing ledger. The ledger being credited belongs to the opposite participant. With a one-way transfer this leaves the sender waiting for missing credit or failure notification.
- Client TURN telemetry labels every successful response without parsed TURN credentials as `turn-not-configured`. The Worker serves the same STUN-only response for missing bindings, upstream errors and malformed responses. Neither the label nor the checked-in Wrangler vars proves which production condition applies.
- The existing sender wait sample combines credit, pacing and browser queue waits. It cannot localize a stall. The five-channel readiness gate, path agreement and busy-transfer promotion rules also mean an ICE success alone cannot prove the application selected RTC.

These findings do not establish the cause of the reported 700 KB timing or the physical-device ICE failures. At the reported rate, a 100 MB transfer would take roughly half an hour if throughput stayed constant. Treat the short and long failures as separate until correlated traces say otherwise.

## Reproduction and experiments

1. On Linux Firefox and Android Chrome, pair on the deployed app with both screens awake. Record browser versions, Wi-Fi versus mobile data, direction and measured bytes. Run the same 700 KB and 100 MB fixtures in both directions. Time approval separately. Enable `localStorage.setItem('ld:nettrace', '1')` in the browser consoles before pairing. Collect only sanitized timing, candidate type/protocol, ICE states, channel readiness, committed path and cancellation reason. Never share raw SDP, candidate addresses, room codes, authentication headers or session tokens.
2. Test the standalone diagnostic page on the same two devices with the same fixture and compare one channel with the production five-channel topology. It bypasses app signaling and path agreement using a privately exchanged, completed offer and answer. Repeat on the same Wi-Fi and on different networks. Success in both diagnostic modes with failure in the app narrows the search to app signaling, RTC configuration or path selection. Failure in both calls for candidate and network investigation. The diagnostic page uses public STUN.
3. For TURN, verify binding names through an authorized Cloudflare account or infer missing bindings from the unauthenticated production endpoint behavior only after confirming the deployed revision. Then test authenticated issuance and a selected relay candidate from both devices. A returned credential does not prove TURN reachability. Check UDP and TCP/TLS paths using the provider's supported endpoints.
4. Run the production transfer against the Worker with confirmed `ws-relay` and record receiver-confirmed bytes and completion time, storage initialization/write/commit, SHA-256, read, pacing, credit and queue waits, and time from end marker to verified result. Use the standalone page's network-plus-hash and OPFS modes to estimate storage cost under the same RTC topology. Apply controlled delay and congestion in the lab. Test repeated sends, cancellation, reconnect and retry. Record exact failure codes and reasons on both endpoints.

## Recovery order and acceptance

1. Reproduce the relay credit mismatch deterministically and preserve a regression for it. Separate flow-control progress from unrelated control traffic while retaining rate limits and ledger validation.
2. Collect production and standalone diagnostics on the same laptop and phone. Test delayed signaling and congestion. Use matching conditions, alternate test order and collect at least five runs per direction and mode.
3. Change app ICE/signaling, storage or transport selection only where traces identify the bottleneck. Maintain the existing UI, room authentication, integrity verification and storage limits.

Acceptance requires five consecutive verified 700 KB and 100 MB transfers in each direction on the affected pair, and a verified retry after cancellation or disconnection. Compare receiver-confirmed throughput and time to verified result against the baseline under matching conditions. For the reported relay baseline, target a median of at most 7 seconds for 700 KB under matching conditions and record 100 MB completion time. Require both peers to agree on their committed path, with a selected non-relay pair on a network where the standalone direct probe succeeds. Distinguish TURN from WebSocket relay. Require SHA-256 equality, bounded in-flight payload, no cross-room traffic and a specific reason for each failed trial. Separate single-host browser results from physical-device results.

## Observations from this investigation

| Test | Result |
| --- | --- |
| Deployed frontend, desktop Firefox to desktop Chromium on the same host, normal ICE | 700,000 bytes verified on RTC in 84 ms from sender metadata. The selected pair was classified as WebRTC WAN by the app. This isolates neither the affected LAN nor Android behavior. |
| Same deployed frontend and browsers, RTC candidates intentionally suppressed in the test contexts | 700,000 bytes verified over WebSocket relay in 16.06 s from sender metadata, about 0.35 Mbit/s. A prior forced-relay trial took 19.77 s. Both peers agreed on relay. |
| Checked-in baseline Worker, loopback, production v2 sender/receiver engine | 700,000 bytes verified. The 100,000,000-byte transfer eventually failed with `Receiver credit timeout`. The same sender exceeded the old budget in a deterministic replay of the credit cadence. |
| Patched Worker, loopback, same client and fixture sizes | 700,000 and 100,000,000 bytes forward, followed by 700,000 bytes in reverse verified against an independent native SHA-256. The 100 MB trial took 3.39 s. This is a local result. |
| Built diagnostic page, desktop Firefox to desktop Chromium, one channel and five channels | Both passed 700 KB in each direction and 100 MB Firefox to Chromium with OPFS, 400 ms applied signaling delay and 2 ms added delay per receiver write. Both cancelled after receiver progress and verified a retry after reconnection. The final host-only run took 3.33 s in each topology for the 100 MB trials. Earlier runs varied. The observed samples do not establish a topology advantage. |
| Incremental hashing alone, Node, 100,000,000 bytes in 262,136-byte updates | Three alternating trials per implementation measured 1.74–1.75 s before and 0.47–0.49 s after removing temporary arrays in the SHA-256 compression loop. All six digests matched native crypto. Browser end-to-end gains have not been established by a controlled A/B run. |

For the instrumented deployed relay trial, the offer response took 640 ms and metadata readiness took 1.57 s. Firefox queued 700,024 binary bytes in 25 ms. The three frame arrivals were roughly 7.23 s, 11.28 s and 13.07 s after enqueue. Firefox still reported about 176 KB in its own WebSocket send queue when the first credit returned 8.56 s after the first enqueue. Frame arrival and socket drain dominated this short trial. At 700 KB, neither the 1 MiB pacing burst nor the 4 MiB credit window forced a sender wait. The wire observations do not locate the bottleneck among the browser networking stack, access link and Cloudflare route. The first two individual receiver credits had roughly 250 ms batching delays. This delay did not block the sender at this fixture size.

The live TURN endpoint was reachable. An unauthenticated POST using the deployed frontend origin returned HTTP 200, two STUN entries, zero TURN entries and no expiry. At `ffb2b0e`, that unauthenticated response is the missing-binding branch. If both bindings are present, an unauthenticated production request must return 401 before any upstream request. The observation is consistent with missing TURN configuration. The remote binding names, deployed Worker revision and authenticated issuance remain unverified. No TURN credential or session token was requested or written to a report.

The deployed trace also showed `connectionState: direct` with an open channel but a stale null `transport` field on one peer. The working copy makes asynchronous diagnostic updates preserve current transport and error state.

## Changes and remaining work

- The Worker gives binary credits a separate bounded bucket and aborts the ledger that would have received a rejected credit. Binary frame and credit validation, the per-direction 4 MiB ledger bound and two-participant room checks still apply. The deterministic regression covers the old starvation rate, valid sustained credits, overrate rejection and outstanding-byte validation.
- The application adds opt-in timing totals for file reads, SHA-256, relay pacing, credit and queue waits, sink initialization/write/commit, receiver readiness and final acknowledgment. First and final credit events include confirmed bytes and relay socket queue depth without logging payloads. Use the existing browser diagnostics and transfer UI for the exact failure reason. Timing stages can overlap across devices and must not be summed into an end-to-end estimate.
- The candidate-pair problem on Linux Firefox and Android Chrome remains open. The local tests delay signaling application and exercise receiver-induced backpressure. Controlled packet loss or bandwidth shaping and physical-device Wi-Fi/mobile data tests remain open. A production 100 MB trial did not produce a conclusive result. Repeat the direction-specific relay captures on the affected network before changing frame sizes, timeouts or the route. The measured relay quota fix addresses a distinct failure from the observed 700 KB slowdown.
- Keep the five-channel production path until the physical-device comparison shows an advantage for changing it. Before any rollout, verify TURN bindings and allocation, then rerun the acceptance matrix on the laptop and phone using a trusted test origin.

## Running the diagnostics and regressions

Build from the repository root and serve the app locally.

```sh
npm --prefix client run build
python3 -m http.server 4174 --bind 127.0.0.1 --directory client/dist
```

Open `http://127.0.0.1:4174/diagnostics.html` on the host. For the phone, use an approved HTTPS test origin with a trusted certificate. An already authorized Android USB debugging session can instead forward the phone's loopback with `adb reverse tcp:4174 tcp:4174` and use the same URL. Never pass raw offer/answer text into a shared report. Match topology and ICE settings, create the offer on one device, paste it into the other device and generate the answer, then paste the answer into the first device. On the receiver select **Hash and discard** or **Hash and write to OPFS**, then allow one probe. On the sender choose a test file and send it. Share the report panel from both devices. The probe deletes its temporary OPFS file after completion. Repeat with **Host candidates only** to isolate the local path from STUN.

The browser regression uses genuine Firefox and Chromium, with Playwright installed outside the application dependency tree. Set `LOCALDROP_PLAYWRIGHT_MODULE` to the absolute path to Playwright's `index.mjs` when installed outside normal Node resolution. `LOCALDROP_FIREFOX` and `LOCALDROP_CHROMIUM` can point to existing Playwright browser executables. Run `node client/tests/diagnostics-browser.mjs` against the loopback page above. The regression uses host candidates to avoid dependence on public STUN in the lab.

From the repository root, use the installed TypeScript runner for the unit suites and the v2 Worker integration.

```sh
for test_file in client/tests/*.test.ts cloudflare-server/tests/*.test.ts; do
  node --import ./cloudflare-server/node_modules/tsx/dist/loader.mjs "$test_file" || exit
done

# Start the local Worker in a separate terminal with npm --prefix cloudflare-server run dev.
node --import ./cloudflare-server/node_modules/tsx/dist/loader.mjs client/tests/relay-worker-integration.ts
```

The integration defaults to `ws://127.0.0.1:8787/ws`. Use `TEST_WS_URL` to compare another authorized test Worker. It measures the genuine WebSocket and Durable Object path using the application transfer engine on Node. The original Worker integration suite also covers room capacity, SDP relay, legacy SHA-256 transfer, health and origin rejection.

## Network V2 release candidate

### Credit handling review

Each v2 socket has independent 80-credit/s and 40-JSON-control/s token buckets. The credit burst is 80 frames. Credit attempts cannot spend JSON tokens. A denied credit spends no tokens, so its refill can be computed from the previous persisted accepted state. This avoids persisting every denial. The existing event queue bounds pending work per socket to 256 events and 8 MiB. Active v2 ledgers still bound outstanding payload to 4 MiB per direction, enforce the negotiated frame size and sequence, and accept positive credit only up to the outstanding count. An endpoint's credit attests to receipt. The Worker can validate the byte ledger, while the endpoints verify SHA-256 and the receiver's completion result.

The Worker resolves credits against the paired peer's outgoing ledger. Rate-limit and validation failures abort that ledger and send its transfer ID and reason to the affected participants. Credits with no matching active ledger consume available credit quota and are dropped without an unscoped error. Active and pending transfer IDs are unique across directions in a room. Cancellation notifications no longer clear the other peer's outgoing ledger as a side effect. The real-Worker regression exercises valid bursts, JSON control after those bursts, reverse-direction transfer survival, wrong opcode, over-credit, ID collision rejection and a subsequent verified transfer.

### Regression commands

With the local diagnostic page and Worker running as above, select each RTC topology independently or omit the selector to run both.

```sh
LOCALDROP_RTC_TOPOLOGY=single node client/tests/diagnostics-browser.mjs
LOCALDROP_RTC_TOPOLOGY=striped node client/tests/diagnostics-browser.mjs
LOCALDROP_TEST_CREDIT_LIMITS=1 node --import ./cloudflare-server/node_modules/tsx/dist/loader.mjs client/tests/relay-worker-integration.ts

ld_baseline=$(mktemp -d)
git show ffb2b0e:client/src/network-v2/sha256.ts > "$ld_baseline/sha256.ts"
node --import ./cloudflare-server/node_modules/tsx/dist/loader.mjs client/tests/benchmark-sha256.mjs "$ld_baseline/sha256.ts"
rm "$ld_baseline/sha256.ts"
rmdir "$ld_baseline"
```

The candidate passed all 24 unit tests and the two desktop browser topologies, including delayed receiver writes, verified cancellation recovery and sanitized downloads. The separate loopback Worker test verified 100 MB in 3.42 seconds and passed the credit checks. The reproducible SHA-256 benchmark processed 100 MB with native digest comparison on every trial. Median time on Node 24.19.0 was 1,635 ms for the baseline and 479 ms for the optimized implementation, a 3.41× hashing-only speedup.

### Additional network and TURN measurements

A second deployed 700 KB test reversed the sender and receiver using the same desktop host and forced WebSocket relay. Chromium to Firefox verified in 2.64 seconds from metadata, compared with 16.06 seconds for Firefox to Chromium in the instrumented forward trial. Chromium queued all frames in 17 ms and reported an empty browser send queue at the first returned credit, 1.58 seconds after the first payload enqueue. Firefox still had about 176 KB queued at first credit in the forward trial. These samples were collected at different times. Repeat both directions on the same physical pair, alternate send order and compare queue drain, ready latency and receiver frame arrival before attributing the difference to a browser or access link.

A separate public production TURN probe again returned two STUN URLs, zero TURN URLs and no expiry. Account-side listing was unavailable in this session, so authenticated binding inventory, credential issuance, allocation and a selected TURN pair are still open. On an authorized Cloudflare account, check the presence of `TURN_KEY_ID` and `TURN_API_TOKEN` by name in the intended Worker environment. In a paired test room, confirm that the app reports `turn-issued` and verify a selected relay candidate under controlled network conditions. Record status and candidate type only. Keep TURN configuration changes separate from this candidate.

### Physical-device run

1. On Linux Firefox and Android Chrome, open the same trusted HTTPS staging build or use the loopback setup above when available. Leave both tabs visible. Record browser versions, network type and direction.
2. Open `/diagnostics.html` on both devices. For each topology, try host-only ICE on the same Wi-Fi, then public STUN on the same Wi-Fi and across separate networks. Exchange descriptions privately. Use the same 700 KB and 100 MB fixtures, reverse direction, and compare hash-and-discard with OPFS. Use the **Download diagnostic report** button on each device after each run. The JSON contains bounded events, safe error labels, relative timing, candidate types and aggregate counters. Associate the two reports with the test case in a separate note.
3. In the full app, enable `ld:nettrace` before pairing and record whether both peers show the same path. Repeat the fixture and direction matrix on the affected relay path. For each relay run collect metadata-to-ready, payload queued bytes, first credit and its socket queue depth, final credit, verified result, and the exact failure reason if applicable. Share only those fields. Preserve the control case with direct RTC if it connects.
4. Repeat the runs and acceptance criteria above. Verify one deliberate cancellation followed by another successful transfer. Save and independently compare the received fixture digest where supported.

### Deployment after approval

The Vite production build and Wrangler dry run were packaged locally with SHA-256 checksums. The frontend artifact targets the current production signaling endpoint. For a preview, build from the reviewed source with the staging project's `VITE_WS_URL` and public URL. The Wrangler artifact is for inspection and build verification. Use the reviewed source and Wrangler config for deployment so the Durable Object binding is applied correctly.

1. Record the currently active Worker version and Vercel production deployment ID. Keep the existing Durable Object class and SQLite migration. Use a separate staging Worker and Durable Object namespace with exact preview origins for both WebSocket and TURN. Keep production credentials and rooms out of staging.
2. After explicit approval, deploy the staging Worker with its approved Wrangler config. Link the intended Vercel project and use its Preview settings to run `vercel pull --environment=preview`, `vercel build`, and `vercel deploy --prebuilt`. In the Vercel project settings keep the existing `client` root. Verify the preview's `/diagnostics.html`, pairing, native SHA-256 verification on relay fixtures, cancellation, and the physical-device matrix. [Vercel prebuilt deployment](https://vercel.com/docs/cli/deploying-from-cli)
3. After separate production approval, deploy the Worker from `cloudflare-server` with `npm run deploy`. Verify health, fresh and resumed pairing, and a verified relay transfer with approved test fixtures. Publish the frontend for the production environment using the existing Vercel project. Verify the published route and both directions again. Keep the earlier versions available. If rollback is approved, use `npx wrangler rollback <previous-version-id>` from `cloudflare-server` and `vercel rollback <previous-deployment>` from the linked project. [Wrangler deploy and rollback](https://developers.cloudflare.com/workers/wrangler/commands/workers/) [Vercel rollback](https://vercel.com/docs/cli/rollback)

## Controlled staging deployment

The staging build is served with its own Worker and SQLite Durable Object namespace. Build the frontend with empty `VITE_WS_URL` and `VITE_PUBLIC_APP_URL` so the browser uses the staging origin for signaling, relay and pairing links. `cloudflare-server/wrangler.staging.jsonc` allows the exact staging origin for browser Worker and TURN requests. Native clients still go through the existing Worker room protocol. Production configuration remains separate.

The standalone page now has **Forced WebSocket relay**. On one device select the mode and create a room. On the other device select the same mode and join using the displayed code. Both pages wait for Worker admission and the diagnostic handshake. The page creates no PeerConnection in this mode. Select the sink, allow one incoming probe, choose the file on the other device and send. Reverse the roles for the next probe. Each device can send at most four probes per pairing, with a 128 MiB per-file limit and one active transfer per page. Reset to create another test pairing. The standard relay pacing, authenticated ledger, frame and credit checks, 4 MiB in-flight cap and storage checks still apply. The report includes confirmed bytes and WebSocket queue depth at the relevant phases. It excludes room codes, peer IDs and session credentials.

The production rollback baseline before staging was Worker version `301a94e7-ac52-4eea-b461-54b1351ede91` at 100% in deployment `6c673eba-4278-4e7d-9779-fec329e6496d`, GitHub main `ffb2b0e51fac30d4641d99f426347d499ebc1210` and Vercel deployment `DSMHtqD7vn5u7xoYQePKQEJprjxi` per the successful GitHub Vercel status.

For an independent relay browser regression against the local staging Worker, set `LOCALDROP_DIAGNOSTICS_URL=http://127.0.0.1:8792/diagnostics.html` and run `LOCALDROP_RTC_TOPOLOGY=relay node client/tests/diagnostics-browser.mjs`. Start the Worker on port 8792 with `wrangler.staging.jsonc` and loopback overrides for both origin vars. The separate Worker integration continues to cover direction-specific cancellation and independent abuse limits.

## Physical-device follow-up

The reported mobile-to-mobile, hotspot and shared Wi-Fi trials establish that Network V2 can deliver files on real devices. The successful tests lack consistent selected-path data, so their throughput cannot be attributed to LAN RTC, internet RTC, TURN or WebSocket relay. The earlier USB-tethering throughput and 100 MB failures still need matched sender and receiver traces. Network V3 is cancelled.

### TURN provisioning and verification

Cloudflare's control plane confirmed that both `TURN_KEY_ID` and `TURN_API_TOKEN` are absent from both the staging Worker and the production signaling Worker. In the Cloudflare account dashboard, open **Realtime → TURN** and create a dedicated staging TURN key. The key ID is the Worker secret `TURN_KEY_ID`. The TURN key's accompanying API token for the credential-generation endpoint is `TURN_API_TOKEN`. Keep the key on the server. Use a separate key for production to avoid coupling their rotation and quota operations. [Cloudflare Realtime TURN credential guide](https://developers.cloudflare.com/realtime/turn/generate-credentials/)

After staging publication is authorized, upload both secrets in the same candidate revision using an approved local secret file or the Cloudflare **Workers & Pages → staging Worker → Settings → Variables and Secrets** panel. For a local secret file outside the repository with mode 0600, use `wrangler versions upload --config wrangler.staging.jsonc --secrets-file /absolute/private/path` from `cloudflare-server`. This creates a version. Activate that version only under the authorized staging deployment. Avoid `wrangler secret put` during review because it immediately deploys. Confirm from the Wrangler secret inventory by name. Production remains a separate approval. [Cloudflare Worker secrets](https://developers.cloudflare.com/workers/configuration/secrets/)

Use **Forced TURN relay** on both devices with **UDP only**, **TCP only**, and **TLS only** in separate runs. Cloudflare lists UDP 3478/443, TCP 3478/80 and TLS 5349/443. The candidate pair's ICE `protocol` can still be UDP when the browser connects to TURN via TCP/TLS. Record the selected local candidate's `relayProtocol` where the browser exposes it. Confirm a selected relay candidate and a receiver-verified transfer. A credential response or a gathered relay candidate alone does not verify allocation and transfer. Then use **STUN and authenticated TURN** for browser-selected routes and test refresh near expiration. Production passes `iceTransportPolicy: all` and does not trigger an ICE restart merely because credentials were refreshed. [TURN ports and transports](https://developers.cloudflare.com/realtime/turn/)

### Test matrix and release gate

- On a shared Wi-Fi network, compare host-only, STUN and the normal application. Repeat for hotspot, USB tethering and separate internet connections. Use comparable IPv4/IPv6 and restrictive NAT cases when available. Record connection stages, candidate types, protocol, RTT, ICE/DTLS/SCTP state and verified result. The host/host category is a candidate-type observation. Public IPv6 host candidates and mDNS make physical topology ambiguous.
- For USB tethering, first verify that each device can reach the staging HTTPS endpoint over the intended link and compare host-only and STUN outcomes with the same pair on Wi-Fi. Keep raw addresses, routes and browser internals local. Compare nomination and channel establishment with application path agreement. This distinguishes link, browser and signaling symptoms without disabling security controls. Treat all proposed USB causes as open.
- For WebSocket relay, alternate browser direction on the same path. Compare 256, 64 and 16 KiB with the same fixture and sink and zero added receiver delay. Repeat with a known storage delay to expose per-write overhead. Gather room-local heartbeat RTT, enqueue and credit timestamps, queue depth, storage, hashing and final acknowledgement. The browser report does not separate access-link upload/download and Cloudflare forwarding delay. Measure those separately under matched conditions before considering changes to the production frame or credit window.
- Keep the 128 MiB diagnostic limit. Exercise 500 MB, 1 GB and 2 GB in the full app with adequate OPFS capacity. Test failure and retry separately. Report only receiver-verified completion. A controlled browser session on one host is a regression test, not evidence about a hotspot, tether or ISP path.
- Existing live diagnostics are at [staging diagnostics](https://localdrop-network-v2-rc.jagansakthi979.workers.dev/diagnostics) on commit `30cc00a`. The new modes and telemetry are local until a staging revision is approved. Keep the recorded staging Worker version `0d0c1521-9ad8-4891-9c18-dbf3e459ce4b` for rollback. Use the deployment procedure above with the existing staging config. Keep production on its current version until the physical acceptance run passes.

### Local candidate changes and measurements

- `turn.ts`, `turnCredentials.ts`, `transportRace.ts`, and `usePeerDrop.ts` distinguish an unconfigured Worker, provider failure, authentication/quota failure and successful issuance. The app refreshes only previously issued credentials near expiration, uses a retry cooldown after a failed refresh, and discards late results after room changes. Live issuance and refresh still require provisioned secrets. Local tests exercised mocked upstream issuance and fallback, expiry, port filtering, room quota logic, and actual Worker origin rejection.
- `diagnostics.html`, `diagnostics.ts`, `diagnosticRelay.ts`, and `diagnosticTurn.ts` add authentication before TURN negotiation, protocol selection, sanitized setup latency and candidate metrics, and frame-size comparisons. Host-only and STUN continue to use private manual descriptions. Forced WebSocket continues to use the two-participant authenticated room. The diagnostic cap is unchanged.
- `rtcDiagnostics.ts`, `transportCopy.ts`, `App.tsx` and `LocalDrop.tsx` use selected candidate-pair data for the label. An unknown pair remains unclassified. Different hosts can report different local/remote candidate types for the very same connection. The loopback browser run showed this on several successful files. Keep both reports when diagnosing.
- `telemetry.ts`, `engine.ts` and `usePeerDrop.ts` track a rolling receiver-confirmed rate and distinguish a stalled transfer from verification. The old sampler could display a stale throughput estimate during inactivity and round a low nonzero rate to zero. The application preserves the receiver's storage-quota cause when a late cleanup cancellation arrives for the completed failed attempt.
- On the local Worker, 100 MB with Chromium OPFS and no synthetic write delay took **4.04 s at 256 KiB**, **5.35 s at 64 KiB**, and **9.78 s at 16 KiB**. In separate trials with two milliseconds added per receiver write, those runs took **3.95 s**, **6.51 s** and **18.13 s**. These are individual loopback samples. Per-frame storage delay and scheduling affect them. They do not explain remote socket drainage or justify changing production framing.
- The full app verified 5, 20, 44 and 100 MB over real Firefox↔Chromium WebRTC on one host, alternating direction by size. The 500 MB and 1 GB attempts hit browser storage quotas. This is an observed lab limit rather than a protocol-size limit. No file or diagnostic size limit was raised.

Final local regression passed 29 unit tests, both Worker integration suites, the real Firefox↔Chromium single/five-channel and forced WebSocket suites, and the browser's configured-to-fail forced TURN path. A real browser test injected a storage quota rejection, observed `Receiver storage quota exceeded` on both peers, then verified a 5 MB transfer in a fresh pairing. The instrumented 2 GB rerun also stopped on the browser quota and reported the same reason on both peers. Frontend build, Worker typecheck and deployment dry run passed.

The GitHub release branch still points to `30cc00a3113e75672d80b78cf7bd252312eab56a`. The live staging diagnostic HTML matched that build byte-for-byte. This workspace includes the earlier candidate changes on top of its local `ffb2b0e` checkout plus the follow-up changes above. The follow-up has not been published.

## Network V2.1 STUN-only staging

The staging build sets `VITE_ENABLE_TURN=false`. The default application skips TURN API calls and starts STUN-backed browser ICE immediately. TURN can be enabled in a future build with `VITE_ENABLE_TURN=true`; this release creates no TURN credentials or billing dependency. Staging retains its existing WebSocket relay and exact origin policy. The five-channel framing, SHA-256 implementation, bounded credit window and server credit quota are preserved.

ICE traces now distinguish candidates queued before the remote description, candidates the browser applied, and candidates rejected by the browser or the bounded queue. A flush records accepted and rejected counts without addresses or SDP. Use those traces to compare host-only and STUN on Wi-Fi and on USB tethering. Use forced WebSocket relay separately to compare sender queue drain and confirmed throughput in both directions. Prior frame-size measurements do not justify changing production WebSocket framing.

On a browser that exposes the native save picker, Network V2 offers **Save directly…** in the receive dialog. Files above 128 MiB show that choice even with auto-accept enabled. Choose the destination before accepting the transfer to stream to it rather than to the origin's temporary storage. The receive credit is still released only after writing each chunk, and successful acknowledgement still requires matching SHA-256 and a completed write. The normal Accept path, OPFS fallback and diagnostic size cap remain. Destination selection is browser-dependent and does not increase the origin quota on browsers that lack a native save picker. Large-file storage failures remain explicit.

After staging smoke tests, use the existing staging URL and the same pair of physical devices for network comparisons. Report both sides, selected path and the storage mode. Keep physical USB connectivity and remote Firefox sender drain open until those measurements are available. For rollback use the prior staging version `0d0c1521-9ad8-4891-9c18-dbf3e459ce4b` with `wrangler rollback <version-id> --config wrangler.staging.jsonc` from `cloudflare-server`. Keep the production Worker and Vercel production deployment unchanged.

### Production build boundary

Build the separate staging Worker assets with `LOCALDROP_BUILD_DIAGNOSTICS=1 VITE_ENABLE_TURN=false VITE_WS_URL= VITE_PUBLIC_APP_URL= npm --prefix client run build`. Normal builds leave out the standalone diagnostics entry. Vercel production also excludes it if a preview-only build flag is present, and disables TURN at build time. The main app retains its existing diagnostics tab and normal features.
