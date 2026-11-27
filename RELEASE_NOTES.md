# LocalDrop v1.0.0

This release brings Network V2.1 to production. It retains the five-channel WebRTC transfer protocol, authenticated two-participant rooms, the existing Cloudflare WebSocket fallback, and streaming SHA-256 verification.

- Pairing starts with STUN-backed WebRTC. TURN is disabled. The release adds no infrastructure or billing dependency.
- The Worker gives transfer credits their own bounded quota and scopes failures to the affected transfer. Existing bandwidth and room limits remain in force.
- Progress uses receiver-confirmed bytes and shows waiting or verification explicitly. Successful completion requires finalized storage and matching SHA-256.
- Supported browsers can stream an incoming file directly to a chosen destination. Other browsers continue to use origin storage or the existing bounded memory fallback.
- Standalone network diagnostics are built for staging only.

## Known limitations

- USB tethering connectivity remains unresolved.
- Cross-network WebSocket throughput varies by route and direction.
- Browser storage limits and native save-picker support vary by device.
- Desktop lab tests verified files through 2 GB. Physical-device testing through 2 GB remains incomplete.

## Rollback

Roll the production Worker back to the recorded pre-release version using `wrangler rollback <version-id> --config wrangler.jsonc` from `cloudflare-server`. Restore the recorded pre-release deployment in the existing Vercel project, then check health, pairing, and a verified transfer. Rollback changes runtime deployment state. If a source rollback is required, revert the release commits on main without rewriting history.
