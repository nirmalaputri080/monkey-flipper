# Monkey Flipper API Server

API сервер для сохранения счетов и лидерборда с использованием PostgreSQL на Render.

## 🚀 Деплой на Render

### 1. Создай новый Web Service на Render

1. Зайди на [Render Dashboard](https://dashboard.render.com/)
2. Нажми **"New +"** → **"Web Service"**
3. Подключи репозиторий: `nirmalaputri080/monkey-flipper`
4. Настрой сервис:
   - **Name**: `monkey-flipper-api` (или любое имя)
   - **Root Directory**: `monkey-flipper-api`
   - **Environment**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Plan**: `Free`

### 2. Добавь Environment Variable

В разделе **Environment** добавь переменную:

```
DATABASE_URL = postgresql://crypto_monkey_user:fTWSgxkQr4OpA48yk7vqspWRTY69WNgh@dpg-d47h36hr0fns73fev8eg-a.oregon-postgres.render.com/crypto_monkey
```

### 3. Задеплой сервис

Нажми **"Create Web Service"** — Render автоматически задеплоит API.

### 4. Получи URL сервиса

После деплоя скопируй URL (например: `https://monkey-flipper-api.onrender.com`)

### 5. Обнови фронтенд

Замени URL в `src/index.js` (строка ~33):

```javascript
const API_SERVER_URL = window.location.hostname === 'localhost'
    ? 'http://localhost:3001'
    : 'https://ТВОЙ_URL.onrender.com'; // ← Вставь свой URL
```

### 6. Закоммить и задеплоить игру

```bash
git add .
git commit -m "Update API server URL"
git push
```

Vercel автоматически задеплоит обновленную игру.

## 📊 API Endpoints

### POST /api/save-score
Сохранить счет игрока

**Body:**
```json
{
  "userId": "12345",
  "username": "Player1",
  "score": 150
}
```

**Response:**
```json
{
  "success": true,
  "isNewRecord": true,
  "bestScore": 150
}
```

### GET /api/leaderboard
Получить топ игроков

**Query params:**
- `limit` (optional) - количество записей (default: 100)

**Response:**
```json
{
  "success": true,
  "rows": [
    {
      "user_id": "12345",
      "username": "Player1",
      "score": 150,
      "timestamp": "2025-11-08T12:00:00.000Z"
    }
  ]
}
```

## 🧪 Локальная разработка

```bash
# Установи зависимости
npm install

# Создай .env файл
cp .env.example .env

# Запусти сервер
npm start
```

Сервер запустится на `http://localhost:3001`

## ✅ Готово!

Теперь игра использует:
- ✅ **Render PostgreSQL** - хранение счетов
- ✅ **Render API Server** - обработка запросов
- ✅ **Render Socket.IO** - 1v1 режим
- ✅ **Vercel** - хостинг игры
