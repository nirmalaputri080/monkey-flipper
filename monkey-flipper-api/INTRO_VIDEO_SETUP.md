# 🎬 Настройка вступительного видео для Telegram Mini App

## 📋 Подготовка видео

### Требования к видео:
- **Формат**: MP4 (H.264)
- **Размер**: до 20 МБ
- **Длительность**: 5-15 секунд (оптимально)
- **Разрешение**: 
  - Вертикальное: 1080x1920 (для мобильных)
  - Горизонтальное: 1920x1080
  - Квадрат: 1080x1080
- **Битрейт**: до 2000 kbps
- **Звук**: опционально (рекомендуется без звука или тихий)

### Как сжать видео (FFmpeg):

```bash
# Сжать до нужного размера
ffmpeg -i input.mp4 -c:v libx264 -crf 28 -preset fast -c:a aac -b:a 128k assets/intro.mp4

# Конвертировать в вертикальный формат
ffmpeg -i input.mp4 -vf "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2" assets/intro.mp4

# Создать GIF анимацию (легче видео)
ffmpeg -i input.mp4 -vf "fps=10,scale=480:-1:flags=lanczos" -loop 0 assets/intro.gif
```

## 🚀 Использование

### 1. Разместите видео в проекте

```bash
mkdir -p assets
# Положите ваше видео в assets/intro.mp4
```

### 2. В `server-api.js` добавьте обработчик `/start`

```javascript
const { showIntroVideo } = require('./telegram-stars-real');

// При команде /start показывать видео
bot.onText(/\/start/, async (msg) => {
    const userId = msg.from.id;
    const gameUrl = process.env.GAME_URL || 'https://your-game.com';
    
    await showIntroVideo(userId, './assets/intro.mp4', gameUrl);
});

// Запустить polling
bot.startPolling();
```

### 3. Используйте URL вместо локального файла

Если видео на CDN или в облаке:

```javascript
const VIDEO_URL = 'https://cdn.yoursite.com/intro.mp4';
await showIntroVideo(userId, VIDEO_URL, gameUrl);
```

### 4. Используйте file_id (рекомендуется)

После первой отправки Telegram даст `file_id` - используйте его для быстрой отправки:

```javascript
// Первый раз отправляете файл
const message = await bot.sendVideo(userId, './assets/intro.mp4');
const fileId = message.video.file_id;

// Сохраните file_id в .env
// FILE_ID=AgACAgIAAxkBAAI...

// Потом используйте file_id
await showIntroVideo(userId, process.env.FILE_ID, gameUrl);
```

## 📱 Варианты интеграции

### A. Показать при первом запуске

```javascript
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

bot.onText(/\/start/, async (msg) => {
    const userId = msg.from.id;
    
    // Проверяем, видел ли пользователь intro
    const result = await pool.query(
        'SELECT intro_seen FROM users WHERE telegram_id = $1',
        [userId]
    );
    
    if (result.rows.length === 0 || !result.rows[0].intro_seen) {
        // Первый раз - показываем видео
        await showIntroVideo(userId, './assets/intro.mp4', process.env.GAME_URL);
        
        // Отмечаем в БД
        await pool.query(
            `INSERT INTO users (telegram_id, intro_seen) 
             VALUES ($1, true)
             ON CONFLICT (telegram_id) DO UPDATE SET intro_seen = true`,
            [userId]
        );
    } else {
        // Уже видел - сразу кнопка игры
        await bot.sendMessage(userId, '🎮 С возвращением!', {
            reply_markup: {
                inline_keyboard: [[
                    { text: '🎮 Начать игру', web_app: { url: process.env.GAME_URL } }
                ]]
            }
        });
    }
});
```

### B. Показать всегда

```javascript
bot.onText(/\/start/, async (msg) => {
    await showIntroVideo(msg.from.id, './assets/intro.mp4', process.env.GAME_URL);
});
```

### C. Показать только по команде /video

```javascript
bot.onText(/\/video/, async (msg) => {
    await showIntroVideo(msg.from.id, './assets/intro.mp4', process.env.GAME_URL);
});
```

## 🎨 Альтернатива: GIF анимация

Если видео слишком тяжелое, используйте GIF:

```javascript
const { showIntroAnimation } = require('./telegram-stars-real');

await showIntroAnimation(userId, './assets/intro.gif', gameUrl);
```

**Преимущества GIF:**
- Легче по размеру
- Быстрее загружается
- Автоматически зацикливается

## 🔧 Настройка в `.env`

```env
BOT_TOKEN=your_bot_token
GAME_URL=https://your-game.com
INTRO_VIDEO_FILE_ID=AgACAgIAAxkBAAI...  # опционально
```

## 📊 Миграция БД (если используете проверку первого запуска)

```sql
-- Добавить колонку intro_seen
ALTER TABLE users ADD COLUMN IF NOT EXISTS intro_seen BOOLEAN DEFAULT FALSE;

-- Создать индекс
CREATE INDEX IF NOT EXISTS idx_users_intro_seen ON users(intro_seen);
```

## ✅ Тестирование

1. Запустите бота:
```bash
cd monkey-flipper-api
node example-intro-video.js
```

2. Отправьте `/start` вашему боту в Telegram

3. Должно появиться видео с кнопкой "Начать игру"

## 🎯 Рекомендации

1. **Короткое видео**: 5-10 секунд максимум
2. **Без звука**: или очень тихий фоновый звук
3. **Яркое и динамичное**: привлекайте внимание
4. **Четкий CTA**: в конце видео должен быть призыв к действию
5. **Fallback**: если видео не отправилось, показывайте текст с кнопкой
6. **Кэширование**: используйте file_id после первой отправки
7. **CDN**: храните видео на CDN для быстрой загрузки

## 🌐 Хостинг видео

### Cloudflare R2 (бесплатно до 10GB)
```bash
npm install @aws-sdk/client-s3
# Загрузите видео в R2
# Получите публичный URL
```

### Telegram CDN (лучший вариант)
После первой отправки видео хранится у Telegram бесплатно - используйте `file_id`

## 🐛 Troubleshooting

**Ошибка: "File too large"**
- Сожмите видео с помощью FFmpeg
- Используйте GIF вместо видео
- Загрузите на CDN и используйте URL

**Видео не воспроизводится**
- Проверьте формат (должен быть MP4 H.264)
- Проверьте размер (до 20 МБ)
- Используйте `supports_streaming: true`

**Кнопка не работает**
- Убедитесь, что `gameUrl` корректный
- Проверьте, что у бота есть права на Web App
- URL должен быть HTTPS

---

**Готово!** Теперь ваша игра будет начинаться с крутого видео 🎬🚀
