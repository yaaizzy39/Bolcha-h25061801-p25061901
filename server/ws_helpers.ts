import { WebSocketServer, WebSocket } from "ws";

interface WebSocketClient extends WebSocket {
  userId?: string;
  userName?: string;
  roomId?: number;
}

export function broadcastToAll(wss: WebSocketServer, data: any) {
  const message = JSON.stringify(data);
  let sentCount = 0;
  wss.clients.forEach((client: WebSocketClient) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
      sentCount++;
    }
  });
  console.log(`Broadcast message sent to ${sentCount} clients out of ${wss.clients.size} total`);
}

export function broadcastToRoom(wss: WebSocketServer, roomId: number, data: any) {
  const message = JSON.stringify(data);
  let sentCount = 0;
  let totalInRoom = 0;
  wss.clients.forEach((client: WebSocketClient) => {
    if (client.readyState === WebSocket.OPEN && client.roomId === roomId) {
      totalInRoom++;
      client.send(message);
      sentCount++;
    }
  });
  console.log(`Broadcast message sent to ${sentCount} clients in room ${roomId}`);
}

export function getOnlineUserCount(wss: WebSocketServer, roomId: number): number {
  let count = 0;
  wss.clients.forEach((client: WebSocketClient) => {
    if (client.readyState === WebSocket.OPEN && client.roomId === roomId) {
      count++;
    }
  });
  return count;
}

export function broadcastOnlineCount(wss: WebSocketServer, roomId: number) {
  const onlineCount = getOnlineUserCount(wss, roomId);
  console.log(`Broadcasting online count for room ${roomId}: ${onlineCount} users`);
  broadcastToRoom(wss, roomId, {
    type: 'online_count_updated',
    roomId,
    onlineCount,
    timestamp: new Date().toISOString(),
  });
}
