import { WebSocketServer, WebSocket } from 'ws';
import crypto from 'crypto';
const wss = new WebSocketServer({ port: 8080 });
const clients = new Map();
function broadcastRoomPeers(roomCode) {
    if (!roomCode)
        return;
    const members = Array.from(clients.values()).filter((c) => c.roomCode === roomCode);
    for (const member of members) {
        const others = members
            .filter((m) => m.id !== member.id)
            .map(({ id, name, deviceType }) => ({ id, name, deviceType }));
        if (member.ws.readyState === WebSocket.OPEN) {
            member.ws.send(JSON.stringify({ type: 'room-peers', peers: others }));
        }
    }
}
wss.on('connection', (ws) => {
    const id = crypto.randomUUID();
    const client = {
        id,
        name: 'Device',
        deviceType: 'desktop',
        roomCode: '',
        ws,
    };
    clients.set(id, client);
    ws.send(JSON.stringify({ type: 'welcome', id }));
    ws.on('message', (raw, isBinary) => {
        // Forward binary file chunks directly to the paired room peer
        if (isBinary) {
            if (!client.roomCode)
                return;
            for (const peer of clients.values()) {
                if (peer.id !== client.id && peer.roomCode === client.roomCode && peer.ws.readyState === WebSocket.OPEN) {
                    peer.ws.send(raw, { binary: true });
                }
            }
            return;
        }
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'register') {
            client.name = msg.name || 'Device';
            client.deviceType = msg.deviceType || 'desktop';
            broadcastRoomPeers(client.roomCode);
        }
        else if (msg.type === 'join-room') {
            const prevRoom = client.roomCode;
            client.roomCode = String(msg.roomCode || '').trim();
            if (prevRoom && prevRoom !== client.roomCode) {
                broadcastRoomPeers(prevRoom);
            }
            broadcastRoomPeers(client.roomCode);
            // Notify existing host in the target room
            for (const peer of clients.values()) {
                if (peer.id !== client.id && peer.roomCode === client.roomCode && peer.ws.readyState === WebSocket.OPEN) {
                    peer.ws.send(JSON.stringify({
                        type: 'peer-joined-room',
                        peer: { id: client.id, name: client.name, deviceType: client.deviceType },
                    }));
                }
            }
        }
        else if (msg.type === 'signal' && msg.to) {
            const target = clients.get(msg.to);
            if (target && target.ws.readyState === WebSocket.OPEN) {
                target.ws.send(JSON.stringify({
                    type: 'signal',
                    from: client.id,
                    fromName: client.name,
                    fromDeviceType: client.deviceType,
                    signal: msg.signal,
                }));
            }
        }
        else if (msg.type === 'relay' && client.roomCode) {
            for (const peer of clients.values()) {
                if (peer.id !== client.id && peer.roomCode === client.roomCode && peer.ws.readyState === WebSocket.OPEN) {
                    peer.ws.send(JSON.stringify({ type: 'relay', payload: msg.payload }));
                }
            }
        }
    });
    ws.on('close', () => {
        const oldRoom = client.roomCode;
        clients.delete(id);
        if (oldRoom)
            broadcastRoomPeers(oldRoom);
    });
});
console.log('LocalDrop signaling & relay server running on port 8080');
