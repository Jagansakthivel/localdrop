# LocalDrop

LocalDrop is a peer-to-peer (P2P) file transfer and real-time data sharing web application designed for direct local network data exchange between desktop and mobile devices without cloud storage intermediaries.

---

## Features

- **Device Pairing**: Pair devices across local Wi-Fi networks, subnets, or mobile hotspots via a 4-digit PIN or scanned QR code with automatic query parameter connection (`?pin=XXXX`).
- **AirDrop-Style Incoming Transfer Dialog**: Bespoke animated modal card on desktop and slide-up sheet on mobile showing sender/receiver device types, file preview, byte size, and keyboard-accessible Accept/Decline actions.
- **Save to Location**: Native destination folder and filename selection using the File System Access API (`showSaveFilePicker()`) with SHA-256 byte-for-byte stream verification and seamless fallback to standard browser downloads.
- **Direct P2P File Streaming**: Direct device-to-device transfers over WebRTC DataChannels (`RTCDataChannel`) with 64KB chunking for streaming files of any format or size.
- **Folder Transfers**: Recursive directory selection automatically compressed into a single ZIP archive client-side before transfer.
- **Two-Way Live Clipboard**: Instant text and link transmission between paired desktop and mobile browsers.
- **Voice Memos**: In-browser voice audio recording using the MediaRecorder API, staged and transferred as an audio file.
- **Session Vault & File Actions**:
  - Session transfer history tracking completed files.
  - One-click batch download of all session files bundled into a ZIP archive.
  - Client-side PDF merging for received PDF documents using `pdf-lib`.
- **Transfer Telemetry & Profiling**: Real-time progress tracking displaying throughput speed (MB/s), estimated time remaining (ETA), transfer progress bar, and WebRTC connection profiler.
- **Interaction Motion Language**:
  - *Magnetic Handshake*: Synchronized visual convergence when the WebRTC data channel is established.
  - *Elastic File Stack*: Physics-based layered card preview for staged files with interactive drag-and-drop.
  - *Packet Departure & Assembly*: Visual motion indicators showing outgoing packets on the sender and converging fragments on the receiver.
- **Borderless Chrome Interface**:
  - Responsive header toolbar with connection status indicator, device information popover, theme toggle, and settings trigger.
  - Full keyboard accessibility with `Escape` dismissal and focus restoration, plus click-outside event handling.
  - Centered creator signature footer with SVG stroke animation and social profile links.
- **Theming**: Midnight charcoal dark mode with blue-violet undertones and warm paper light mode.
- **PWA & Local HTTPS**:
  - Installable Progressive Web App with service worker caching.
  - Automated local SSL certificate generation via `@vitejs/plugin-basic-ssl` to ensure secure context requirements for WebRTC and Web Crypto APIs.

---

## Technology Stack

| Layer | Technologies |
| :--- | :--- |
| **Frontend Framework** | React 19, TypeScript |
| **Styling & Layout** | Tailwind CSS v4, Custom CSS tokens |
| **Motion & Animation** | Motion (`motion/react`) |
| **Typography** | Geist, Geist Mono, Manrope (`@fontsource-variable/*`) |
| **Iconography** | Lucide React, Custom SVG glyphs |
| **Utilities** | JSZip, pdf-lib, qrcode.react, Sonner |
| **Build & Tooling** | Vite 8, Vite PWA, `@vitejs/plugin-basic-ssl`, Oxlint |
| **Signaling Server** | Node.js, `ws` (WebSocket), TypeScript, `tsx` |
| **Networking** | WebRTC DataChannels (`RTCDataChannel`), STUN |

---

## Architecture Summary

```
localdrop/
├── client/                     # Frontend client application
│   ├── public/
│   │   └── favicon.svg         # Application favicon
│   ├── src/
│   │   ├── components/
│   │   │   ├── IncomingTransferPopup.tsx # AirDrop-style transfer request dialog
│   │   │   ├── LocalDrop.tsx       # Core presentation and workspace layout
│   │   │   ├── LocalDropChrome.tsx # Borderless utility toolbar & creator signature
│   │   │   ├── LocalDropMotion.tsx # Magnetic Handshake, Elastic File Stack, TransferMotion
│   │   │   ├── MotionErrorBoundary.tsx # Error boundary protecting motion trees
│   │   │   ├── ReceivedFileSave.tsx # File System Access API "Save as..." component
│   │   │   └── localdrop-chrome.css # Toolbar, popover, and theme tokens
│   │   ├── hooks/
│   │   │   └── usePeerDrop.ts  # WebRTC peer lifecycle, signaling & chunk streaming
│   │   ├── utils/
│   │   │   ├── connectionProfiler.ts # WebRTC connection latency & stage profiler
│   │   │   ├── fileAdapter.ts  # Defensive file normalization, safe thumbnails, formatBytes
│   │   │   ├── formatFilename.ts # Extension-preserving filename formatter
│   │   │   ├── network.ts      # WebSocket URL resolver & Render cold-start ping
│   │   │   └── saveReceivedFile.ts # File System Access API saving & stream verification
│   │   ├── App.tsx             # Root application orchestrator and session state
│   │   ├── index.css           # Global layout reset
│   │   ├── localdrop.css       # Core typography, color variables & component styles
│   │   ├── motion.css          # Signature animation stylesheet
│   │   ├── motion-presets.ts   # Centralized spring configurations
│   │   └── main.tsx            # Application entry point
│   ├── vite.config.ts          # Vite build, PWA, HTTPS & WebSocket proxy config
│   ├── .env.example            # Environment variable reference
│   └── package.json
├── server/                     # Node.js WebSocket signaling server (local dev & fallback)
│   ├── index.ts                # HTTP health check & WebSocket signaling engine
│   ├── test-connection.ts      # Integration test suite (PIN pairing, relay, health)
│   ├── tsconfig.json
│   └── package.json
├── cloudflare-server/          # Production Cloudflare Workers & SQLite Durable Objects
│   ├── src/
│   │   ├── index.ts            # Worker router, origin validation & DO routing
│   │   ├── SignalingHub.ts     # Durable Object with SQLite storage & Hibernation API
│   │   └── types.ts            # Protocol definitions & security constants
│   ├── test/
│   │   └── test-connection.ts  # Comprehensive integration tests with SHA-256 verification
│   ├── wrangler.jsonc          # Wrangler configuration (SQLite DO migrations & bindings)
│   ├── tsconfig.json
│   └── package.json
├── .gitignore                  # Repository ignore rules
└── README.md
```

---

## Getting Started

### Prerequisites

- Node.js 18 or later
- npm 9 or later

### 1. Installation

Install dependencies for both client and server:

```bash
# Install server dependencies
cd server
npm install

# Install client dependencies
cd ../client
npm install
```

### 2. Local Development

Start the signaling server:

```bash
cd server
npm run dev
```
The signaling server listens on `ws://localhost:8080`.

In a separate terminal, start the client development server:

```bash
cd client
npm run dev
```

Vite will serve the client over local HTTPS (e.g., `https://localhost:5173/` and LAN `https://<your-local-ip>:5173/`).

The development server proxies `/ws` directly to `ws://localhost:8080`, avoiding mixed-content security restrictions.

### 3. Production Build

Build the client for production:

```bash
cd client
npm run build
```

Compiled static output is generated in `client/dist/`.

Build the signaling server:

```bash
cd server
npm run build
```

---

## Production Deployment (₹0 / Free Tier)

LocalDrop is architected for zero-cost deployment with instant edge wake-ups. The primary and recommended backend is **Cloudflare Workers** with **SQLite-backed Durable Objects** (zero cold starts, global edge network, and WebSocket Hibernation). Alternatively, a Node.js deployment on **Render** is also fully supported.

### Architecture Overview

```
[ User Browser (Vercel) ] <--- Direct WebRTC P2P Transfer ---> [ Peer Browser (Vercel) ]
             \                                                       /
              \                                                     /
               \-- [ Cloudflare Workers + SQLite Durable Objects ] --/
```

- **Frontend**: Hosted on Vercel's global edge network (free tier).
- **Backend**: Hosted on Cloudflare Workers using SQLite-backed Durable Objects with WebSocket Hibernation API (free tier).
- **Zero Cold Start**: Unlike container-based free tiers that sleep after 15 minutes, Cloudflare Workers and hibernated Durable Objects wake up instantly in sub-milliseconds with 0 waiting time.
- **Data Transfer**: 99% of file and text data travels directly peer-to-peer via WebRTC DataChannels, consuming zero server relay bandwidth under healthy network conditions.

---

### Option 1 (Recommended): Deploy to Cloudflare Workers

#### 1. Authenticate with Cloudflare

Inside the repository:

```bash
cd cloudflare-server
npx wrangler login
```

Follow the browser prompt to log in with your free Cloudflare account.

#### 2. Verify Locally

Run the complete 8-point integration test suite against the local Workers simulator:

```bash
# Terminal 1: Start local development simulator
npm run dev

# Terminal 2: Run integration tests (PIN pairing, WebRTC signaling, relay, SHA-256)
npm test
```

#### 3. Deploy to Production

Deploy the Worker and SQLite Durable Object with a single command:

```bash
npm run deploy
```

Wrangler will output your live production URL:
```text
Published localdrop-signaling (x.xx sec)
  https://localdrop-signaling.<your-subdomain>.workers.dev
Current Deployment ID: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```

Verify your deployment health check:
```bash
curl https://localdrop-signaling.<your-subdomain>.workers.dev/health
```

Expected response:
```json
{
  "status": "ok",
  "service": "localdrop-signaling",
  "platform": "cloudflare-workers-durable-objects",
  "storage": "sqlite",
  "connections": 0,
  "activeRooms": 0,
  "timestamp": 1795585587270
}
```

#### 4. Connect Vercel to Cloudflare

1. Open your [Vercel Dashboard](https://vercel.com/) and go to your `localdrop` project.
2. Navigate to **Settings** → **Environment Variables**.
3. Set or update `VITE_WS_URL`:
   - **Key**: `VITE_WS_URL`
   - **Value**: `wss://localdrop-signaling.<your-subdomain>.workers.dev` *(or `https://...` — LocalDrop auto-normalizes)*
4. Go to **Deployments** and click **Redeploy** on your latest deployment.

---

### Option 2 (Alternative): Deploy to Render

For environments where Node.js container hosting is preferred:

1. Open the [Render Dashboard](https://dashboard.render.com/) and create a new **Web Service** connected to your `localdrop` repository.
2. Deployment settings:
   - **Root Directory**: `server`
   - **Build Command**: `npm ci --include=dev && npm run build`
   - **Start Command**: `npm start`
   - **Instance Type**: `Free` ($0/mo)
   - **Environment Variables**: `NODE_ENV=production`, `ALLOWED_ORIGINS=https://<your-app>.vercel.app`
3. In Vercel, set `VITE_WS_URL` to `wss://<your-render-service>.onrender.com`.
4. *Note on Render Cold Starts*: Render free tier containers spin down after 15 minutes of inactivity (~30–50s wake-up time). LocalDrop automatically pings `/health` to wake up dormant containers and safely disables the connect button until signaling is ready. Cloudflare Workers (Option 1) eliminates this delay entirely.

---

## Configuration & Environment Variables

### Client (`client/.env`)

| Variable | Scope | Description | Default |
| :--- | :--- | :--- | :--- |
| `VITE_WS_URL` | Client | WebSocket URL for the signaling server in production | `wss://<host>/ws` |

### Server (`server/.env`)

| Variable | Scope | Description | Default |
| :--- | :--- | :--- | :--- |
| `PORT` | Server | HTTP & WebSocket server port | `8080` (or `process.env.PORT` on Render) |
| `ALLOWED_ORIGINS` | Server | Comma-separated list of allowed origins | `localhost`, LAN IPs, `*.vercel.app` |
| `NODE_ENV` | Server | Runtime environment | `development` |

Reference files are provided at `client/.env.example` and `server/tsconfig.json`.

---

## Browser Compatibility & Prerequisites

- **WebRTC DataChannels**: Requires a browser supporting standard `RTCPeerConnection` and `RTCDataChannel` APIs (Chrome 56+, Firefox 44+, Safari 11+, Edge 79+).
- **Secure Context (HTTPS)**: Browsers require a secure context (`https://` or `localhost`) to access `crypto.subtle`, `crypto.randomUUID`, and `navigator.mediaDevices`.
- **MediaRecorder**: Voice memo recording requires `navigator.mediaDevices.getUserMedia` and `MediaRecorder` support.
- **Directory Upload**: Folder staging relies on the standard `webkitdirectory` input attribute.

---

## Known Limitations

- Direct peer connections require devices to establish a network route via local LAN, Wi-Fi subnet, or public STUN servers. Devices behind restrictive symmetric NATs may require a TURN relay if direct peer-to-peer traversal is blocked by the network firewall.
- Background tab throttling: Transfers in inactive background tabs may be throttled by browser power-saving mechanisms. Keep the tab visible during large batch transfers.

---

## Author & Attribution

Designed and built by **Jagan**:
- **LinkedIn**: [Jagan Sakthivel](https://www.linkedin.com/in/jagan-sakthivel-dev/?utm_source=chatgpt.com)
- **GitHub**: [Jagansakthivel](https://github.com/Jagansakthivel?utm_source=chatgpt.com)

---

## License

ISC License. See package configuration for details.
