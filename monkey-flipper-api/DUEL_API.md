# 🥊 Duel API Documentation

API endpoints для системы дуэлей (1v1 вызовы).

## 📊 База данных

### Таблица `duels`

```sql
CREATE TABLE duels (
  match_id VARCHAR(255) PRIMARY KEY,
  player1_id VARCHAR(255) NOT NULL,
  player2_id VARCHAR(255),
  player1_username VARCHAR(255) NOT NULL,
  player2_username VARCHAR(255),
  score1 INTEGER,
  score2 INTEGER,
  winner VARCHAR(255),
  status VARCHAR(50) DEFAULT 'pending',
  seed INTEGER NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  started_at TIMESTAMP,
  completed_at TIMESTAMP,
  expires_at TIMESTAMP
);
```

### Статусы дуэли:
- `pending` - вызов отправлен, ожидает принятия
- `active` - дуэль принята, игра идет
- `completed` - дуэль завершена
- `expired` - вызов истек (24ч без ответа)

---

## 🔧 API Endpoints

### 1. Создать вызов на дуэль

```http
POST /api/duel/create
```

**Request:**
```json
{
  "player1Id": "123456",
  "player1Username": "Player1",
  "botUsername": "your_bot_name"
}
```

**Response:**
```json
{
  "success": true,
  "matchId": "duel_1731247862_abc123",
  "seed": 123456,
  "duelLink": "https://t.me/your_bot_name?startapp=duel_1731247862_abc123",
  "expiresAt": "2025-11-09T12:00:00.000Z"
}
```

---

### 2. Получить информацию о дуэли

```http
GET /api/duel/:matchId
```

**Response:**
```json
{
  "success": true,
  "duel": {
    "match_id": "duel_1731247862_abc123",
    "player1_id": "123456",
    "player2_id": "789012",
    "player1_username": "Player1",
    "player2_username": "Player2",
    "score1": 100,
    "score2": 150,
    "winner": "789012",
    "status": "completed",
    "seed": 123456,
    "created_at": "2025-11-08T12:00:00.000Z",
    "started_at": "2025-11-08T12:05:00.000Z",
    "completed_at": "2025-11-08T12:10:00.000Z",
    "expires_at": "2025-11-09T12:00:00.000Z"
  }
}
```

---

### 3. Принять вызов на дуэль

```http
POST /api/duel/:matchId/accept
```

**Request:**
```json
{
  "player2Id": "789012",
  "player2Username": "Player2"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Duel accepted",
  "seed": 123456
}
```

**Errors:**
- `404` - Duel not found
- `400` - Duel already started/completed
- `400` - Duel expired
- `400` - Cannot accept your own duel

---

### 4. Завершить дуэль (сохранить результат)

```http
POST /api/duel/:matchId/complete
```

**Request:**
```json
{
  "playerId": "123456",
  "score": 150
}
```

**Response (первый игрок завершил):**
```json
{
  "success": true,
  "completed": false,
  "message": "Waiting for opponent"
}
```

**Response (оба завершили):**
```json
{
  "success": true,
  "completed": true,
  "winner": "789012",
  "score1": 100,
  "score2": 150
}
```

---

### 5. История дуэлей игрока

```http
GET /api/duel/history/:userId?limit=50
```

**Response:**
```json
{
  "success": true,
  "count": 10,
  "duels": [
    {
      "match_id": "duel_1731247862_abc123",
      "player1_id": "123456",
      "player2_id": "789012",
      "player1_username": "Player1",
      "player2_username": "Player2",
      "score1": 100,
      "score2": 150,
      "winner": "789012",
      "status": "completed",
      "created_at": "2025-11-08T12:00:00.000Z"
    }
  ]
}
```

---

## 🎯 Типичный Flow

### Создание и принятие дуэли:

1. **Player1 создает вызов:**
```bash
POST /api/duel/create
# Получает duelLink
```

2. **Player1 отправляет ссылку в Telegram**
```
https://t.me/bot?startapp=duel_abc123
```

3. **Player2 переходит по ссылке и принимает:**
```bash
POST /api/duel/duel_abc123/accept
# Получает seed для генерации платформ
```

4. **Оба играют с одинаковым seed**

5. **Player1 завершает игру:**
```bash
POST /api/duel/duel_abc123/complete
{"playerId": "player1", "score": 100}
# Ответ: waiting for opponent
```

6. **Player2 завершает игру:**
```bash
POST /api/duel/duel_abc123/complete
{"playerId": "player2", "score": 150}
# Ответ: winner = player2
```

---

## ⏰ Автоматическое истечение

Если через 24 часа `player2` не принял вызов:
- При запросе `GET /api/duel/:matchId` статус автоматически меняется на `expired`
- `winner` устанавливается = `player1_id`

---

## 🧪 Тестирование API

```bash
# Создать дуэль
curl -X POST https://monkey-flipper-djm1.onrender.com/api/duel/create \
  -H "Content-Type: application/json" \
  -d '{"player1Id":"test1","player1Username":"TestPlayer1","botUsername":"your_bot"}'

# Принять дуэль
curl -X POST https://monkey-flipper-djm1.onrender.com/api/duel/MATCH_ID/accept \
  -H "Content-Type: application/json" \
  -d '{"player2Id":"test2","player2Username":"TestPlayer2"}'

# Завершить дуэль
curl -X POST https://monkey-flipper-djm1.onrender.com/api/duel/MATCH_ID/complete \
  -H "Content-Type: application/json" \
  -d '{"playerId":"test1","score":100}'

# История
curl https://monkey-flipper-djm1.onrender.com/api/duel/history/test1
```

---

## ✅ Статус реализации

- ✅ Таблица `duels` в PostgreSQL
- ✅ POST /api/duel/create
- ✅ GET /api/duel/:matchId
- ✅ POST /api/duel/:matchId/accept
- ✅ POST /api/duel/:matchId/complete
- ✅ GET /api/duel/history/:userId
- ✅ Автоматическое истечение через 24ч

**Готово к использованию!** 🎉
