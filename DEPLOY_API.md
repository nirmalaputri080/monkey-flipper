# 🎯 БЫСТРАЯ ИНСТРУКЦИЯ ПО ДЕПЛОЮ API

## ✅ Что уже сделано:
- ✅ Создан API сервер с PostgreSQL (`monkey-flipper-api/`)
- ✅ Удалены старые Vercel API файлы
- ✅ Обновлен `src/index.js` для использования Render API
- ✅ Закоммичено и запушено на GitHub

## 🚀 ЧТО ТЕБЕ НУЖНО СДЕЛАТЬ:

### 1. Задеплой API на Render (5 минут)

1. Зайди на https://dashboard.render.com/
2. Нажми **"New +"** → **"Web Service"**
3. Выбери репозиторий: `nirmalaputri080/monkey-flipper`
4. Настрой:
   ```
   Name: monkey-flipper-api
   Root Directory: monkey-flipper-api
   Environment: Node
   Build Command: npm install
   Start Command: npm start
   Plan: Free
   ```
5. В **Environment Variables** добавь:
   ```
   DATABASE_URL = postgresql://crypto_monkey_user:fTWSgxkQr4OpA48yk7vqspWRTY69WNgh@dpg-d47h36hr0fns73fev8eg-a.oregon-postgres.render.com/crypto_monkey
   ```
6. Нажми **"Create Web Service"**

### 2. Получи URL и обнови игру

После деплоя скопируй URL (например: `https://monkey-flipper-api-xyz.onrender.com`)

Замени в файле `src/index.js` строку 33:
```javascript
const API_SERVER_URL = window.location.hostname === 'localhost'
    ? 'http://localhost:3001'
    : 'https://ТВОЙ_РЕАЛЬНЫЙ_URL.onrender.com'; // ← ВСТАВЬ СВОЙ URL ЗДЕСЬ
```

### 3. Закоммить и запушить

```bash
git add src/index.js
git commit -m "Update API URL"
git push
```

Vercel автоматически задеплоит обновленную игру!

## 🎉 ГОТОВО!

Теперь у тебя:
- ✅ Render PostgreSQL - постоянное хранение счетов
- ✅ Render API Server - обработка `/api/save-score` и `/api/leaderboard`
- ✅ Render Socket.IO - 1v1 режим
- ✅ Vercel - хостинг игры

## 📝 Подробная инструкция

Смотри `monkey-flipper-api/README.md` для деталей!
