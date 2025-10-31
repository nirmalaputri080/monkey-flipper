# 🚀 Деплой игры Monkey Flipper на Vercel

## 📋 Что было добавлено:

### 1. **Серверная часть (API)**
- `api/save-score.js` - endpoint для сохранения счетов
- `api/leaderboard.js` - endpoint для получения глобального рейтинга
- `vercel.json` - конфигурация для Vercel

### 2. **Интеграция с Telegram**
- Telegram Web App SDK для получения ID игрока
- Автоматическая отправка счета после каждой игры
- Fallback на анонимный ID если Telegram недоступен

### 3. **Офлайн режим**
- Локальное сохранение счетов если сервер недоступен
- Автоматическая повторная отправка при восстановлении связи

---

## 🛠️ Инструкция по деплою на Vercel:

### **Шаг 1: Установка Vercel CLI**

```bash
# Установите Vercel CLI глобально
npm install -g vercel

# Или используйте npx (не требует установки)
npx vercel
```

### **Шаг 2: Подготовка проекта**

```bash
# Перейдите в папку проекта
cd /Users/artursitikov/Downloads/monkey_flipper_test_key_1

# Проверьте структуру файлов:
# ✅ api/save-score.js
# ✅ api/leaderboard.js
# ✅ vercel.json
# ✅ index.html
# ✅ src/index.js
```

### **Шаг 3: Деплой на Vercel**

```bash
# Войдите в Vercel (откроется браузер)
vercel login

# Задеплойте проект
vercel

# Или задеплойте в production сразу
vercel --prod
```

**Ответьте на вопросы:**
```
? Set up and deploy "monkey_flipper_test_key_1"? [Y/n] Y
? Which scope do you want to deploy to? Your Account
? Link to existing project? [y/N] n
? What's your project's name? monkey-flipper
? In which directory is your code located? ./
```

### **Шаг 4: Получите URL проекта**

После деплоя Vercel выдаст URL вида:
```
https://monkey-flipper-abc123.vercel.app
```

### **Шаг 5: Обновите SERVER_URL в коде**

Откройте `src/index.js` и замените:
```javascript
const SERVER_URL = window.location.hostname === 'localhost' 
    ? 'http://localhost:3000'
    : 'https://your-app.vercel.app';  // ← ЗАМЕНИТЕ на ваш URL!
```

На:
```javascript
const SERVER_URL = window.location.hostname === 'localhost' 
    ? 'http://localhost:3000'
    : 'https://monkey-flipper-abc123.vercel.app';  // Ваш реальный URL
```

### **Шаг 6: Передеплойте с обновленным URL**

```bash
vercel --prod
```

---

## 🧪 Тестирование API:

### **Тест 1: Сохранение счета**
```bash
curl -X POST https://your-app.vercel.app/api/save-score \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "test123",
    "username": "TestPlayer",
    "score": 5000,
    "timestamp": "2025-10-22T10:00:00Z"
  }'
```

**Ожидаемый ответ:**
```json
{
  "success": true,
  "isNewRecord": true,
  "bestScore": 5000,
  "gamesPlayed": 1,
  "message": "New record!"
}
```

### **Тест 2: Получение рейтинга**
```bash
curl https://your-app.vercel.app/api/leaderboard
```

**Ожидаемый ответ:**
```json
{
  "success": true,
  "count": 1,
  "leaderboard": [
    {
      "userId": "test123",
      "username": "TestPlayer",
      "bestScore": 5000,
      "gamesPlayed": 1,
      "lastPlayed": "2025-10-22T10:00:00Z"
    }
  ]
}
```

---

## 📱 Интеграция с Telegram Mini App:

### **Шаг 1: Создайте бота**
1. Найдите @BotFather в Telegram
2. Отправьте `/newbot`
3. Следуйте инструкциям

### **Шаг 2: Настройте Web App**
```
/newapp
/setappshortname monkey_flipper
/setappurl https://your-app.vercel.app
/setappdescription Fun monkey jumping game!
/setappphoto (загрузите картинку)
```

### **Шаг 3: Тестируйте**
Откройте свой бот в Telegram и нажмите кнопку "Play Game"

---

## 🗄️ Миграция на настоящую базу данных:

**Текущая реализация использует память сервера (данные теряются при рестарте).**

### **Вариант 1: Vercel KV (Redis)**
```bash
# Установите Vercel KV
vercel link
vercel kv create
```

### **Вариант 2: MongoDB Atlas (Бесплатно)**
```bash
npm install mongodb
```

В `api/save-score.js`:
```javascript
const { MongoClient } = require('mongodb');
const client = new MongoClient(process.env.MONGODB_URI);

export default async function handler(req, res) {
  await client.connect();
  const db = client.db('monkey_flipper');
  const scores = db.collection('scores');
  
  await scores.insertOne({ userId, score, timestamp });
  // ...
}
```

### **Вариант 3: Supabase (PostgreSQL)**
```bash
npm install @supabase/supabase-js
```

---

## 📊 Полезные команды:

```bash
# Просмотр логов
vercel logs

# Список деплоев
vercel list

# Удалить проект
vercel remove

# Просмотр переменных окружения
vercel env ls

# Добавить переменную окружения
vercel env add MONGODB_URI
```

---

## ⚙️ Переменные окружения (опционально):

Если хотите добавить секретные ключи:
```bash
vercel env add SERVER_API_KEY
```

В `api/save-score.js`:
```javascript
const API_KEY = process.env.SERVER_API_KEY;

if (req.headers['x-api-key'] !== API_KEY) {
  return res.status(401).json({ error: 'Unauthorized' });
}
```

---

## 🐛 Отладка:

### Проблема: CORS ошибка
**Решение:** Убедитесь что в API есть CORS заголовки:
```javascript
res.setHeader('Access-Control-Allow-Origin', '*');
```

### Проблема: 404 на API endpoints
**Решение:** Проверьте `vercel.json` и структуру папок `api/`

### Проблема: Данные не сохраняются
**Решение:** Используйте настоящую БД вместо памяти сервера

---

## 📚 Дополнительные ресурсы:

- [Vercel Documentation](https://vercel.com/docs)
- [Telegram Bot API](https://core.telegram.org/bots/webapps)
- [Vercel Serverless Functions](https://vercel.com/docs/functions)

---

## ✅ Чеклист перед деплоем:

- [ ] Установлен Vercel CLI
- [ ] Создан проект на Vercel
- [ ] Обновлен SERVER_URL в index.js
- [ ] Протестированы API endpoints
- [ ] Настроен Telegram bot (опционально)
- [ ] Выбрана база данных для продакшена

---

**Готово! Ваша игра теперь на Vercel с сохранением счетов на сервере! 🎉**
