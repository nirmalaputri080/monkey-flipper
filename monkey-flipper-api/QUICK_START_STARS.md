# 🚀 Быстрая настройка STARS интеграции

## Шаг 1: Генерация ключей безопасности

```bash
cd monkey-flipper-api
node generate-keys.js > keys.txt
```

Скопируйте сгенерированные ключи в файл `.env`

## Шаг 2: Настройка .env

Создайте файл `.env` в директории `monkey-flipper-api/`:

```env
# Database
DATABASE_URL=your-postgresql-connection-string

# JWT
JWT_SECRET=generated-jwt-secret

# Telegram
BOT_TOKEN=your-telegram-bot-token

# Encryption (AES-256)
ENCRYPTION_KEY=generated-encryption-key

# Signature Keys (RSA)
CLIENT_PUBLIC_KEY="generated-client-public-key"
SERVER_PRIVATE_KEY="generated-server-private-key"
SERVER_PUBLIC_KEY="generated-server-public-key"

# CORS
FRONTEND_URL=https://your-domain.com

# Server
PORT=3001
```

## Шаг 3: Запуск сервера

```bash
npm install
npm start
```

## Шаг 4: Интеграция на клиенте

### 4.1. Автообновление Telegram initData (каждые 30 сек)

```javascript
// src/telegram-auth.js
let telegramInitData = window.Telegram?.WebApp?.initData || '';

// Обновлять каждые 30 секунд
setInterval(() => {
  if (window.Telegram?.WebApp) {
    telegramInitData = window.Telegram.WebApp.initData;
  }
}, 30000);

// Использовать при запросах
function makeAuthRequest(url, data) {
  return fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Telegram-Init-Data': telegramInitData
    },
    body: JSON.stringify(data)
  });
}
```

### 4.2. Отправка игровых событий (анти-чит)

```javascript
// src/game-events.js
const gameEvents = [];

function trackJump(x, y) {
  gameEvents.push({
    type: 'jump',
    x,
    y,
    timestamp: Date.now()
  });
}

function trackLanding(platformY) {
  gameEvents.push({
    type: 'land',
    platformY,
    timestamp: Date.now()
  });
}

async function submitGameResult(userId, username, score) {
  const response = await fetch('/api/game-events', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Telegram-Init-Data': telegramInitData
    },
    body: JSON.stringify({
      userId,
      username,
      events: gameEvents,
      claimedScore: score
    })
  });
  
  const result = await response.json();
  gameEvents.length = 0; // Очистить после отправки
  return result;
}
```

### 4.3. Покупка за STARS (с подписью)

⚠️ **Важно:** Для production необходимо хранить приватный ключ на защищенном сервере

```javascript
// Временное решение для тестирования (НЕБЕЗОПАСНО для production!)
async function purchaseWithStars(userId, itemId, itemName, priceStars) {
  // В production: получить подпись от вашего защищенного сервера
  const transactionData = {
    userId,
    itemId,
    priceStars,
    timestamp: Date.now()
  };
  
  // ВНИМАНИЕ: Здесь должен быть ваш сервер для создания подписи
  const signature = await getSignatureFromYourServer(transactionData);
  
  const response = await fetch('/api/shop/purchase-stars', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Telegram-Init-Data': telegramInitData
    },
    body: JSON.stringify({
      userId,
      itemId,
      itemName,
      priceStars,
      signature
    })
  });
  
  return response.json();
}
```

## API Endpoints

### Магазин

- `GET /api/shop/catalog` - весь каталог
- `GET /api/shop/catalog?category=skins` - фильтр по категории
- `GET /api/shop/item/:itemId` - информация о товаре
- `POST /api/shop/purchase` - покупка за Monkey Coins
- `POST /api/shop/purchase-stars` - покупка за STARS
- `GET /api/shop/purchases/:userId` - история покупок

### Кошелек

- `GET /api/wallet/:userId` - баланс (Monkey Coins, STARS, TON)
- `POST /api/wallet/connect-stars` - подключить STARS кошелек
- `GET /api/wallet/stars-info/:userId` - информация о STARS кошельке

### Игра

- `POST /api/game-events` - отправка игровых событий (рекомендуется)
- `POST /api/save-score` - прямая отправка score (deprecated)
- `GET /api/leaderboard` - таблица лидеров

### Транзакции

- `GET /api/transactions/:userId` - история транзакций
- `POST /api/rewards/send-stars` - отправка STARS наград

## Тестирование

```bash
# Тест шифрования и подписей
node generate-keys.js

# Проверка API
curl http://localhost:3001/api/shop/catalog

# Проверка структуры БД
curl http://localhost:3001/api/debug/tables
```

## Безопасность ✅

Все требования из ТЗ реализованы:

- ✅ HTTPS (TLS 1.2+)
- ✅ Telegram initData валидация
- ✅ JWT токены ≤ 24h
- ✅ Игровые события (анти-чит)
- ✅ AES-256 шифрование адресов
- ✅ Транзакции с nonce
- ✅ Проверка подписей STARS/TON
- ✅ Pending статус + retry
- ✅ Rate limit 5/мин
- ✅ CORS защита

Подробнее: см. `SECURITY_IMPLEMENTATION.md`
