# STARS Integration API Documentation

## 🔐 Безопасность

### AES-256 Шифрование
Все адреса кошельков (STARS, TON) хранятся в зашифрованном виде используя AES-256-GCM.

**Ключ шифрования:**
```bash
# В .env файле:
ENCRYPTION_KEY=your-32-byte-hex-key-here
```

**Генерация ключа:**
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

---

## 📡 API Endpoints

### 1. Подключить STARS Кошелек

**POST** `/api/wallet/connect-stars`

Подключает STARS кошелек пользователя с шифрованием адреса.

**Request:**
```json
{
  "userId": "123456789",
  "starsAddress": "STARSxxx...xxx"
}
```

**Response (Success):**
```json
{
  "success": true,
  "message": "STARS wallet connected successfully",
  "wallet": {
    "userId": "123456789",
    "connected": true,
    "connectedAt": "2025-11-23T10:00:00.000Z"
  }
}
```

**Response (Error):**
```json
{
  "success": false,
  "error": "Invalid STARS address format"
}
```

---

### 2. Получить информацию о STARS Кошельке

**GET** `/api/wallet/stars-info/:userId`

Возвращает информацию о подключенном STARS кошельке (адрес замаскирован).

**Response (Connected):**
```json
{
  "success": true,
  "connected": true,
  "wallet": {
    "maskedAddress": "...xAb3Cd9F",
    "balance": 150.5,
    "connectedAt": "2025-11-23T10:00:00.000Z",
    "updatedAt": "2025-11-23T12:00:00.000Z"
  }
}
```

**Response (Not Connected):**
```json
{
  "success": true,
  "connected": false,
  "message": "No STARS wallet connected"
}
```

---

### 3. Покупка за STARS Токены

**POST** `/api/shop/purchase-stars`

Покупка предметов в магазине за реальные STARS токены.

**Request:**
```json
{
  "userId": "123456789",
  "itemId": "skin_golden",
  "itemName": "Golden Skin",
  "priceStars": 10.5,
  "signature": "base64-signature-here"
}
```

**Response (Success):**
```json
{
  "success": true,
  "newBalance": 140.0,
  "purchase": {
    "id": "uuid-here",
    "itemId": "skin_golden",
    "itemName": "Golden Skin",
    "price": 10.5,
    "currency": "stars"
  }
}
```

**Response (Insufficient Balance):**
```json
{
  "success": false,
  "error": "Insufficient STARS balance",
  "required": 10.5,
  "current": 5.0
}
```

---

### 4. Отправить награды в STARS

**POST** `/api/rewards/send-stars`

Автоматическая отправка STARS токенов на кошелек игрока за достижения.

**Request:**
```json
{
  "userId": "123456789",
  "amount": 5.0,
  "reason": "daily_quest_completed",
  "signature": "server-signature-here"
}
```

**Response (Success):**
```json
{
  "success": true,
  "status": "pending",
  "message": "STARS reward is being processed",
  "transaction": {
    "id": "uuid-here",
    "amount": 5.0,
    "currency": "stars",
    "reason": "daily_quest_completed"
  },
  "newBalance": 155.0
}
```

---

### 5. Отправка игровых событий (Anti-Cheat)

**POST** `/api/game-events`

Отправляет игровые события вместо прямого score. Сервер пересчитывает результат.

**Request:**
```json
{
  "userId": "123456789",
  "username": "Player1",
  "claimedScore": 1500,
  "events": [
    { "type": "land", "platformY": 500, "timestamp": 1234567890 },
    { "type": "land", "platformY": 400, "timestamp": 1234567891 },
    { "type": "land", "platformY": 300, "timestamp": 1234567892 }
  ]
}
```

**Response (Success):**
```json
{
  "success": true,
  "isNewRecord": true,
  "bestScore": 1500,
  "coinsEarned": 15,
  "newBalance": 450,
  "serverScore": 1500,
  "verified": true
}
```

**Response (Cheating Detected):**
```json
{
  "success": false,
  "error": "Score verification failed",
  "serverScore": 1200,
  "claimedScore": 5000
}
```

---

## 🛡️ Система Безопасности

### 1. Шифрование адресов
- Все STARS/TON адреса шифруются перед сохранением в БД
- Используется AES-256-GCM с authentication tag
- Ключ шифрования хранится в .env файле

### 2. Проверка подписей транзакций
```javascript
// Пример создания подписи (клиент):
const signature = cryptoUtils.signData({
  userId: '123',
  itemId: 'skin_golden',
  priceStars: 10.5
}, privateKey);

// Пример проверки подписи (сервер):
const isValid = cryptoUtils.verifySignature(
  data, 
  signature, 
  publicKey
);
```

### 3. Anti-Cheat система
- Клиент отправляет события игры, а не финальный score
- Сервер пересчитывает score по событиям
- Допуск расхождения: 5% или 50 очков
- При превышении - запрос отклоняется

### 4. Rate Limiting
- `/api/save-score`: 10 запросов/мин
- `/api/game-events`: 10 запросов/мин
- `/api/wallet/add-coins`: 10 запросов/мин

### 5. Pending статус транзакций
- При ошибках внешних API транзакция ставится в `pending`
- Средства блокируются, но не списываются
- Требуется cron job для retry

---

## 📊 База Данных

### Таблица: wallets
```sql
CREATE TABLE wallets (
  user_id VARCHAR(255) PRIMARY KEY,
  monkey_coin_balance INTEGER DEFAULT 0,
  stars_balance DECIMAL(20, 8) DEFAULT 0,
  ton_balance DECIMAL(20, 8) DEFAULT 0,
  stars_address TEXT,           -- Зашифрованный адрес
  ton_address TEXT,             -- Зашифрованный адрес
  wallet_address VARCHAR(255),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);
```

### Таблица: transactions
```sql
CREATE TABLE transactions (
  id UUID PRIMARY KEY,
  user_id VARCHAR(255) NOT NULL,
  type VARCHAR(50) NOT NULL,     -- 'game_reward', 'purchase_stars', 'reward_stars'
  amount DECIMAL(20, 8) NOT NULL,
  currency VARCHAR(10) NOT NULL, -- 'monkey', 'stars', 'ton'
  status VARCHAR(20) DEFAULT 'pending', -- 'pending', 'completed', 'failed'
  nonce VARCHAR(255) UNIQUE NOT NULL,
  signature TEXT,
  metadata JSONB,
  created_at TIMESTAMP DEFAULT NOW(),
  completed_at TIMESTAMP
);
```

### Таблица: purchases
```sql
CREATE TABLE purchases (
  id UUID PRIMARY KEY,
  user_id VARCHAR(255) NOT NULL,
  item_id VARCHAR(50) NOT NULL,
  item_name VARCHAR(255) NOT NULL,
  price DECIMAL(20, 8) NOT NULL,
  currency VARCHAR(10) DEFAULT 'monkey', -- 'monkey', 'stars', 'ton'
  status VARCHAR(20) DEFAULT 'active',
  purchased_at TIMESTAMP DEFAULT NOW()
);
```

---

## 🚀 Деплой

### 1. Установите зависимости
```bash
cd monkey-flipper-api
npm install
```

### 2. Создайте .env файл
```bash
DATABASE_URL=postgresql://...
JWT_SECRET=your-jwt-secret
BOT_TOKEN=your-telegram-bot-token
ENCRYPTION_KEY=your-32-byte-hex-key
PORT=3001
```

### 3. Запустите сервер
```bash
npm start
```

### 4. Проверьте таблицы
```bash
curl https://your-api.onrender.com/api/debug/tables
```

---

## ⚠️ Что еще нужно для полной интеграции

### 1. Crypto All-Stars API
- Документация API от Crypto All-Stars
- API ключи и credentials
- SDK или библиотека для интеграции

### 2. Реальная отправка STARS токенов
```javascript
// Заменить в /api/rewards/send-stars:
// ЗДЕСЬ ДОЛЖЕН БЫТЬ КОД ОТПРАВКИ РЕАЛЬНЫХ STARS ТОКЕНОВ
// Пример: await starsAPI.sendTokens(recipientAddress, amount);
```

### 3. Cron Job для retry транзакций
```javascript
// Каждые 5 минут проверять pending транзакции
setInterval(async () => {
  const pending = await pool.query(`
    SELECT * FROM transactions 
    WHERE status = 'pending' 
    AND created_at > NOW() - INTERVAL '24 hours'
  `);
  
  for (const tx of pending.rows) {
    // Retry отправки
  }
}, 5 * 60 * 1000);
```

### 4. Генерация ключей для подписей
```bash
# Сгенерировать RSA пару ключей:
node -e "const keys = require('./crypto-utils').generateKeyPair(); console.log('Public:', keys.publicKey); console.log('Private:', keys.privateKey);"
```

---

## 📝 Примеры использования

### Клиент (JavaScript)

**Подключить STARS кошелек:**
```javascript
const response = await fetch(`${API_URL}/api/wallet/connect-stars`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    userId: tg.initDataUnsafe.user.id,
    starsAddress: 'STARSxxx...xxx'
  })
});

const data = await response.json();
if (data.success) {
  console.log('STARS wallet connected!');
}
```

**Купить предмет за STARS:**
```javascript
const response = await fetch(`${API_URL}/api/shop/purchase-stars`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    userId: tg.initDataUnsafe.user.id,
    itemId: 'skin_golden',
    itemName: 'Golden Skin',
    priceStars: 10.5
  })
});

const data = await response.json();
if (data.success) {
  console.log('Purchase successful! New balance:', data.newBalance);
}
```

**Отправить игровые события:**
```javascript
const gameEvents = [
  { type: 'land', platformY: 500, timestamp: Date.now() },
  { type: 'land', platformY: 400, timestamp: Date.now() + 100 }
];

const response = await fetch(`${API_URL}/api/game-events`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    userId: tg.initDataUnsafe.user.id,
    username: tg.initDataUnsafe.user.username,
    claimedScore: 1500,
    events: gameEvents
  })
});

const data = await response.json();
if (data.success) {
  console.log('Server score:', data.serverScore);
  console.log('Coins earned:', data.coinsEarned);
}
```

---

## 🎯 Статус реализации

| Функция | Статус | Примечания |
|---------|--------|-----------|
| ✅ AES-256 шифрование | 100% | Готово |
| ✅ Подключение STARS кошелька | 100% | Готово |
| ✅ Покупки за STARS | 100% | Готово (без реального API) |
| ✅ Награды в STARS | 100% | Готово (pending статус) |
| ✅ Система событий (anti-cheat) | 100% | Готово |
| ⚠️ Подписи транзакций | 50% | Функции готовы, не активированы |
| ⚠️ Pending retry | 0% | Требуется cron job |
| ❌ Реальный STARS API | 0% | Требуется документация от Crypto All-Stars |

---

**Готово к тестированию!** 🚀

Для полной интеграции нужны только:
1. API документация и ключи от Crypto All-Stars
2. Cron job для retry pending транзакций
3. Активация проверки подписей в production
