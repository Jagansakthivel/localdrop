# LocalDrop P2P 🚀

**LocalDrop** is an instant peer-to-peer (P2P) file sharing and two-way live clipboard synchronization web application designed for seamless local Wi-Fi data exchange between mobile and desktop devices.

---

## ✨ Features

- **4-Digit PIN Pairing**: Pair devices across local networks, subnets, or mobile hotspots with a random 4-digit PIN.
- **Two-Way Live Clipboard**:
  - Read and access your mobile clipboard directly on PC.
  - Push PC clipboard text or code snippets straight to your phone.
- **Direct P2P File & Media Streaming**:
  - Full local Wi-Fi speeds with **zero cloud upload**.
  - 64KB chunked WebRTC DataChannel streaming for large videos, images, PDFs, and files of any size.
- **PWA & Web Share Target**:
  - Installable as a standalone Progressive Web App on Android, iOS, Windows, Mac, and Linux.
  - Integrated with the mobile system Share Sheet for one-tap sharing.
- **Local HTTPS & WebSocket Proxying**:
  - Automated SSL certificate provisioning via `@vitejs/plugin-basic-ssl`.
  - Built-in Vite proxy forwarding `/ws` to prevent mixed-content blocks on modern browsers.

---

## 🛠️ Tech Stack

- **Frontend**: React 19, TypeScript, Tailwind CSS v4, Lucide Icons, Vite PWA, `@vitejs/plugin-basic-ssl`
- **Networking**: WebRTC DataChannels (`RTCDataChannel`, Google STUN servers)
- **Signaling**: Node.js, `ws` (WebSocket server), TypeScript, `tsx`

---

## 📂 Project Structure

```
localdrop/
├── client/              # React + Vite + Tailwind CSS v4 frontend
│   ├── src/
│   │   ├── hooks/
│   │   │   └── usePeerDrop.ts  # WebRTC & signaling hook
│   │   ├── App.tsx             # Main user interface
│   │   └── index.css           # Tailwind CSS v4 entry
│   ├── vite.config.ts          # Vite, basicSsl, PWA & /ws proxy configuration
│   └── package.json
├── server/              # Node.js WebSocket signaling server
│   ├── index.ts         # IP discovery, PIN room matching & WebRTC signaling
│   ├── tsconfig.json
│   └── package.json
└── README.md
```

---

## 🚀 Local Development

### 1. Start the Signaling Server
```bash
cd server
npm install
npm run dev # or npm start
```
The server will run on `ws://localhost:8080`.

### 2. Start the Frontend Dev Server
```bash
cd client
npm install
npm run dev
```
Open the printed HTTPS Network URL (e.g. `https://192.168.x.x:5173`) on your desktop and mobile browser.

---

## 🌐 Production Deployment

### 1. Signaling Server (Render / Railway / Fly.io / VPS)
Deploy the `server` directory as a Node service:
- **Build Command**: `npm run build`
- **Start Command**: `npm run start`
- **Environment Variable**: `PORT` (e.g. `8080` or provided by the platform)

### 2. Frontend (Vercel / Netlify / Cloudflare Pages)
Deploy the `client` directory as a static Vite build:
- **Root Directory**: `client`
- **Build Command**: `npm run build`
- **Output Directory**: `dist`
- **Environment Variable**:
  ```env
  VITE_WS_URL=wss://your-signaling-server.onrender.com
  ```
  *(In production with a separate signaling domain, `VITE_WS_URL` points directly to your deployed secure WebSocket endpoint).*
