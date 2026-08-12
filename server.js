const { createServer } = require('http');
const { parse } = require('url');
const next = require('next');
const { Server } = require('socket.io');

const dev = process.env.NODE_ENV !== 'production';
const app = next({ dev });
const handle = app.getRequestHandler();

app.prepare().then(() => {
  const server = createServer((req, res) => {
    const parsedUrl = parse(req.url, true);
    handle(req, res, parsedUrl);
  });

  const io = new Server(server, {
    cors: {
      origin: "*",
      methods: ["GET", "POST"]
    }
  });

  io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    socket.on('join-room', (roomId) => {
      socket.join(roomId);
      console.log(`User ${socket.id} joined room ${roomId}`);
    });

    socket.on('send-message', (data) => {
      socket.to(data.roomId).emit('receive-message', data);
    });

    socket.on('message-delivered', (data) => {
      socket.to(data.roomId).emit('message-delivered', { messageId: data.messageId, deliveredTo: socket.id });
    });

    socket.on('message-read', (data) => {
      socket.to(data.roomId).emit('message-read', { messageId: data.messageId, readBy: socket.id });
    });

    socket.on('typing', (data) => {
      socket.to(data.roomId).emit('user-typing', { userId: socket.id, isTyping: data.isTyping });
    });

    socket.on('disconnect', () => {
      console.log('User disconnected:', socket.id);
    });
  });

  const PORT = process.env.PORT || 3000;
  server.listen(PORT, () => {
    console.log(`> Ready on http://localhost:${PORT}`);
  });
});