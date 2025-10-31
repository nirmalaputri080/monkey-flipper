// ==================== MONKEY FLIPPER 1V1 SERVER ====================
// Socket.IO сервер для управления матчмейкингом и игровыми комнатами

const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const cors = require('cors');

const app = express();
const server = http.createServer(app);

// Настройка CORS и Socket.IO
app.use(cors());
app.use(express.json());

const io = socketIO(server, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST']
    }
});

// ==================== DATA STRUCTURES ====================

// Очередь ожидания игроков для матчмейкинга
const matchmakingQueue = [];

// Активные игровые комнаты { roomId: GameRoom }
const gameRooms = new Map();

// Класс для управления игровой комнатой
class GameRoom {
    constructor(player1, player2) {
        this.id = `room_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        this.seed = Math.floor(Math.random() * 1000000); // Seed для платформ
        this.players = {
            [player1.id]: {
                socketId: player1.socketId,
                userId: player1.userId,
                username: player1.username,
                x: 0,
                y: 0,
                isAlive: true,
                score: 0,
                lastUpdate: Date.now()
            },
            [player2.id]: {
                socketId: player2.socketId,
                userId: player2.userId,
                username: player2.username,
                x: 0,
                y: 0,
                isAlive: true,
                score: 0,
                lastUpdate: Date.now()
            }
        };
        this.startTime = null;
        this.duration = 120000; // 2 минуты в миллисекундах
        this.status = 'countdown'; // countdown -> playing -> finished
        this.winner = null;
    }
    
    getPlayerIds() {
        return Object.keys(this.players);
    }
    
    getOpponent(playerId) {
        const playerIds = this.getPlayerIds();
        return playerIds.find(id => id !== playerId);
    }
    
    updatePlayer(playerId, data) {
        if (this.players[playerId]) {
            Object.assign(this.players[playerId], data);
            this.players[playerId].lastUpdate = Date.now();
        }
    }
    
    checkGameEnd() {
        const playerIds = this.getPlayerIds();
        const alivePlayers = playerIds.filter(id => this.players[id].isAlive);
        
        console.log('🔍 Проверка окончания игры:', {
            totalPlayers: playerIds.length,
            alivePlayers: alivePlayers.length,
            players: playerIds.map(id => ({
                id,
                isAlive: this.players[id].isAlive,
                score: this.players[id].score
            }))
        });
        
        // Если кто-то упал
        if (alivePlayers.length === 1) {
            this.winner = alivePlayers[0];
            console.log('🏆 Победитель найден (один выжил):', this.winner);
            return { reason: 'fall', winner: this.winner };
        }
        
        // Если оба упали одновременно
        if (alivePlayers.length === 0) {
            // Определяем победителя по счёту
            const p1Id = playerIds[0];
            const p2Id = playerIds[1];
            this.winner = this.players[p1Id].score > this.players[p2Id].score ? p1Id : p2Id;
            console.log('🏆 Победитель найден (оба упали, выше прыгнул):', this.winner);
            return { reason: 'double_fall', winner: this.winner };
        }
        
        // Если время вышло
        if (this.startTime && Date.now() - this.startTime >= this.duration) {
            const p1Id = playerIds[0];
            const p2Id = playerIds[1];
            this.winner = this.players[p1Id].score > this.players[p2Id].score ? p1Id : p2Id;
            this.status = 'finished';
            return { reason: 'timeout', winner: this.winner };
        }
        
        return null;
    }
}

// ==================== HELPER FUNCTIONS ====================

function findPlayerInQueue(socketId) {
    return matchmakingQueue.findIndex(p => p.socketId === socketId);
}

function removePlayerFromQueue(socketId) {
    const index = findPlayerInQueue(socketId);
    if (index !== -1) {
        matchmakingQueue.splice(index, 1);
        console.log(`🚪 Игрок ${socketId} удален из очереди. Осталось в очереди: ${matchmakingQueue.length}`);
    }
}

function findPlayerRoom(socketId) {
    for (const [roomId, room] of gameRooms.entries()) {
        const playerIds = room.getPlayerIds();
        for (const playerId of playerIds) {
            if (room.players[playerId].socketId === socketId) {
                return { room, playerId };
            }
        }
    }
    return null;
}

// ==================== SOCKET.IO EVENTS ====================

io.on('connection', (socket) => {
    console.log(`✅ Новое подключение: ${socket.id}`);
    
    // ===== МАТЧМЕЙКИНГ =====
    socket.on('findMatch', (data) => {
        const { userId, username } = data;
        console.log(`🔍 Поиск матча: ${username} (${userId})`);
        
        // Проверяем, не в очереди ли уже игрок
        if (findPlayerInQueue(socket.id) !== -1) {
            console.log(`⚠️ Игрок ${socket.id} уже в очереди`);
            return;
        }
        
        // Добавляем в очередь
        const player = {
            id: userId,
            socketId: socket.id,
            userId: userId,
            username: username,
            joinedAt: Date.now()
        };
        
        matchmakingQueue.push(player);
        console.log(`➕ Игрок добавлен в очередь. Всего в очереди: ${matchmakingQueue.length}`);
        
        // Пытаемся найти пару
        if (matchmakingQueue.length >= 2) {
            const player1 = matchmakingQueue.shift();
            const player2 = matchmakingQueue.shift();
            
            // Создаем комнату
            const room = new GameRoom(player1, player2);
            gameRooms.set(room.id, room);
            
            console.log(`🎮 Создана комната: ${room.id}`);
            console.log(`   Игрок 1: ${player1.username}`);
            console.log(`   Игрок 2: ${player2.username}`);
            console.log(`   Seed: ${room.seed}`);
            
            // Отправляем обоим игрокам информацию о начале игры
            const gameStartData = {
                roomId: room.id,
                seed: room.seed,
                opponent: null // Заполним для каждого индивидуально
            };
            
            // Игрок 1
            io.to(player1.socketId).emit('gameStart', {
                ...gameStartData,
                opponent: {
                    id: player2.userId,
                    username: player2.username
                }
            });
            
            // Игрок 2
            io.to(player2.socketId).emit('gameStart', {
                ...gameStartData,
                opponent: {
                    id: player1.userId,
                    username: player1.username
                }
            });
            
            // Запускаем обратный отсчет (3 секунды)
            setTimeout(() => {
                room.startTime = Date.now();
                room.status = 'playing';
                io.to(player1.socketId).emit('countdown', 3);
                io.to(player2.socketId).emit('countdown', 3);
            }, 1000);
        } else {
            socket.emit('searching', { queueSize: matchmakingQueue.length });
        }
    });
    
    // ===== ОТМЕНА ПОИСКА =====
    socket.on('cancelMatch', () => {
        removePlayerFromQueue(socket.id);
        console.log(`❌ Отмена поиска: ${socket.id}`);
    });
    
    // ===== ОБНОВЛЕНИЕ ИГРОКА =====
    socket.on('playerUpdate', (data) => {
        const roomInfo = findPlayerRoom(socket.id);
        if (!roomInfo) return;
        
        const { room, playerId } = roomInfo;
        const { x, y, isAlive, score } = data;
        
        console.log(`📊 Обновление игрока ${playerId.substring(0, 10)}... isAlive=${isAlive}, score=${score}`);
        
        // Обновляем данные игрока
        room.updatePlayer(playerId, { x, y, isAlive, score });
        
        // Отправляем данные оппоненту
        const opponentId = room.getOpponent(playerId);
        if (!opponentId || !room.players[opponentId]) {
            console.log('⚠️ Оппонент не найден для игрока:', playerId);
            return;
        }
        
        const opponentSocketId = room.players[opponentId].socketId;
        
        io.to(opponentSocketId).emit('opponentUpdate', {
            x,
            y,
            isAlive,
            score
        });
        
        // Проверяем условия окончания игры (только если игра еще идет)
        if (room.status === 'playing') {
            const gameEndResult = room.checkGameEnd();
            if (gameEndResult) {
                console.log('🎯 Игра окончена! Отправляем результаты...');
                room.status = 'finished'; // ВАЖНО: Устанавливаем статус ДО отправки
                
                // Отправляем результаты обоим игрокам
                const playerIds = room.getPlayerIds();
                for (const pId of playerIds) {
                    const isWinner = pId === gameEndResult.winner;
                    const pOpponentId = room.getOpponent(pId);
                    
                    io.to(room.players[pId].socketId).emit('gameEnd', {
                        reason: gameEndResult.reason,
                        winner: isWinner,
                        yourScore: room.players[pId].score,
                        opponentScore: room.players[pOpponentId].score,
                        yourUsername: room.players[pId].username,
                        opponentUsername: room.players[pOpponentId].username
                    });
                }
                
                // Удаляем комнату через 10 секунд
                setTimeout(() => {
                    gameRooms.delete(room.id);
                    console.log(`🗑️ Комната ${room.id} удалена`);
                }, 10000);
            }
        }
    });
    
    // ===== ОТКЛЮЧЕНИЕ =====
    socket.on('disconnect', () => {
        console.log(`🔌 Отключение: ${socket.id}`);
        
        // Удаляем из очереди
        removePlayerFromQueue(socket.id);
        
        // Проверяем активные комнаты
        const roomInfo = findPlayerRoom(socket.id);
        if (roomInfo) {
            const { room, playerId } = roomInfo;
            const opponentId = room.getOpponent(playerId);
            
            // Уведомляем оппонента о дисконнекте
            if (room.players[opponentId]) {
                io.to(room.players[opponentId].socketId).emit('opponentDisconnected', {
                    message: 'Оппонент отключился. Вы победили!'
                });
            }
            
            // Удаляем комнату
            gameRooms.delete(room.id);
            console.log(`🗑️ Комната ${room.id} удалена из-за дисконнекта`);
        }
    });
});

// ==================== REST API (опционально) ====================

// Статистика сервера
app.get('/api/stats', (req, res) => {
    res.json({
        queueSize: matchmakingQueue.length,
        activeGames: gameRooms.size,
        connectedPlayers: io.sockets.sockets.size
    });
});

// Здоровье сервера
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: Date.now() });
});

// ==================== SERVER START ====================

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
    console.log(`🚀 Monkey Flipper 1v1 Server запущен на порту ${PORT}`);
    console.log(`📊 Статистика: http://localhost:${PORT}/api/stats`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('🛑 SIGTERM получен, закрываем сервер...');
    server.close(() => {
        console.log('✅ Сервер закрыт');
        process.exit(0);
    });
});
