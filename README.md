# LocalDrop

LocalDrop is a peer-to-peer (P2P) file transfer and real-time data sharing web application designed for direct local network data exchange between desktop and mobile devices without cloud storage intermediaries.

---

## Features

- **Device Pairing**: Pair devices across local Wi-Fi networks, subnets, or mobile hotspots via a 4-digit PIN or scanned QR code with automatic query parameter connection (`?pin=XXXX`).
- **Direct P2P File Streaming**: Direct device-to-device transfers over WebRTC DataChannels (`RTCDataChannel`) with 64KB chunking for streaming files of any format or size.
- **Folder Transfers**: Recursive directory selection automatically compressed into a single ZIP archive client-side before transfer.
- **Two-Way Live Clipboard**: Instant text and link transmission between paired desktop and mobile browsers.
- **Voice Memos**: In-browser voice audio recording using the MediaRecorder API, staged and transferred as an audio file.
- **Session Vault & File Actions**:
  - Session transfer history tracking completed files.
  - One-click batch download of all session files bundled into a ZIP archive.
  - Client-side PDF merging for received PDF documents using `pdf-lib`.
- **Transfer Telemetry**: Real-time progress tracking displaying throughput speed (MB/s), estimated time remaining (ETA), transfer progress bar, and completion verification.
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
│   │   │   ├── LocalDrop.tsx       # Core presentation and workspace layout
│   │   │   ├── LocalDropChrome.tsx # Borderless utility toolbar & creator signature
│   │   │   ├── LocalDropMotion.tsx # Magnetic Handshake, Elastic File Stack, TransferMotion
│   │   │   ├── MotionErrorBoundary.tsx # Error boundary protecting motion trees
│   │   │   └── localdrop-chrome.css # Toolbar, popover, and theme tokens
│   │   ├── hooks/
│   │   │   └── usePeerDrop.ts  # WebRTC peer lifecycle, signaling & chunk streaming
│   │   ├── utils/
│   │   │   └── fileAdapter.ts  # Defensive file normalization, safe thumbnails, formatBytes
│   │   ├── App.tsx             # Root application orchestrator and session state
│   │   ├── index.css           # Global layout reset
│   │   ├── localdrop.css       # Core typography, color variables & component styles
│   │   ├── motion.css          # Signature animation stylesheet
│   │   ├── motion-presets.ts   # Centralized spring configurations
│   │   └── main.tsx            # Application entry point
│   ├── vite.config.ts          # Vite build, PWA, HTTPS & WebSocket proxy config
│   ├── .env.example            # Environment variable reference
│   └── package.json
├── server/                     # Node.js WebSocket signaling server
│   ├── index.ts                # PIN-based room matchmaking & WebRTC signal exchange
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

## Configuration & Environment Variables

| Variable | Scope | Description | Default |
| :--- | :--- | :--- | :--- |
| `VITE_WS_URL` | Client | WebSocket URL for the signaling server in production | `wss://<host>/ws` |

A reference file is provided at `client/.env.example`.

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
