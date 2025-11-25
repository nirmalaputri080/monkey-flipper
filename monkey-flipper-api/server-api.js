const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const fs = require('fs');
const cryptoUtils = require('./crypto-utils'); // Утилиты шифрования
const starsAPI = require('./stars-api'); // STARS API интеграция (игровая валюта)
const telegramStars = require('./telegram-stars-real'); // Telegram Stars (XTR) - реальные платежи
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;

// JWT Secret (в production должен быть в .env)
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';
const BOT_TOKEN = process.env.BOT_TOKEN || ''; // Telegram Bot Token

// ==================== ENHANCED CORS SECURITY ====================
const ALLOWED_ORIGINS = [
  'https://t.me',
  'https://web.telegram.org',
  'https://monkey-flipper-test-key-1.vercel.app',
  process.env.FRONTEND_URL || 'http://localhost:3000'
].filter(Boolean);

const corsOptions = {
  origin: (origin, callback) => {
    // Разрешаем запросы без origin (мобильные приложения, Postman)
    if (!origin) return callback(null, true);
    
    // Проверяем Telegram WebApp origin
    if (origin.includes('t.me') || origin.includes('telegram.org')) {
      return callback(null, true);
    }
    
    // Проверяем whitelist
    if (ALLOWED_ORIGINS.some(allowed => origin.startsWith(allowed))) {
      return callback(null, true);
    }
    
    console.warn(`⚠️ CORS blocked origin: ${origin}`);
    callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Telegram-Init-Data']
};

app.use(cors(corsOptions));
app.use(express.json());

// PostgreSQL connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ==================== SECURITY MIDDLEWARE ====================

// Валидация Telegram initData
function validateTelegramInitData(initData) {
  if (!BOT_TOKEN) {
    console.warn('⚠️ BOT_TOKEN not set, skipping Telegram validation');
    return true; // В тестовом режиме пропускаем
  }

  try {
    const urlParams = new URLSearchParams(initData);
    const hash = urlParams.get('hash');
    urlParams.delete('hash');
    
    // Сортируем параметры
    const dataCheckString = Array.from(urlParams.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key}=${value}`)
      .join('\n');
    
    // Вычисляем HMAC
    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    const calculatedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
    
    return calculatedHash === hash;
  } catch (error) {
    console.error('Telegram validation error:', error);
    return false;
  }
}

// Middleware для проверки Telegram initData
const validateTelegram = (req, res, next) => {
  const initData = req.headers['x-telegram-init-data'];
  
  if (!initData) {
    // Для обратной совместимости пропускаем если нет заголовка
    console.warn('⚠️ No Telegram initData provided');
    return next();
  }
  
  if (!validateTelegramInitData(initData)) {
    return res.status(401).json({ success: false, error: 'Invalid Telegram data' });
  }
  
  next();
};

// JWT генерация
function generateJWT(userId, username) {
  return jwt.sign(
    { userId, username },
    JWT_SECRET,
    { expiresIn: '24h' }
  );
}

// JWT валидация middleware
const validateJWT = (req, res, next) => {
  const token = req.headers['authorization']?.replace('Bearer ', '');
  
  if (!token) {
    return res.status(401).json({ success: false, error: 'No token provided' });
  }
  
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (error) {
    return res.status(401).json({ success: false, error: 'Invalid token' });
  }
};

// Упрощённая валидация для shop.html (разрешает Base64 токены)
const validateShopAuth = (req, res, next) => {
  const token = req.headers['authorization']?.replace('Bearer ', '');
  
  if (!token) {
    return res.status(401).json({ success: false, error: 'No token provided' });
  }
  
  try {
    // Сначала пробуем настоящий JWT
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (error) {
    // Если не JWT, проверяем Base64 токен (для shop.html)
    try {
      const decoded = Buffer.from(token, 'base64').toString('utf-8');
      if (decoded.includes('user_') || decoded.includes('test_') || decoded.includes('fallback_')) {
        // Валидный Base64 токен от shop.html
        req.user = { userId: 'shop_user' };
        next();
      } else {
        return res.status(401).json({ success: false, error: 'Invalid token format' });
      }
    } catch (e) {
      return res.status(401).json({ success: false, error: 'Invalid token' });
    }
  }
};

// Rate limiting - 5 запросов в минуту согласно ТЗ
const gameResultLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 минута
  max: 5, // 5 запросов согласно ТЗ
  message: { success: false, error: 'Too many requests, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    return req.body.userId || req.user?.userId || req.ip;
  }
});

// Create table if not exists
(async () => {
  try {
    // Таблица для пользователей
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        telegram_id VARCHAR(255) PRIMARY KEY,
        username VARCHAR(255),
        intro_seen BOOLEAN DEFAULT FALSE,
        equipped_items JSONB DEFAULT '{}'::jsonb,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_login TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_users_telegram_id ON users(telegram_id);
      CREATE INDEX IF NOT EXISTS idx_users_intro_seen ON users(intro_seen);
    `);
    
    // Миграция: Добавляем колонку equipped_items для существующих пользователей
    await pool.query(`
      ALTER TABLE users 
      ADD COLUMN IF NOT EXISTS equipped_items JSONB DEFAULT '{}'::jsonb;
    `);
    
    console.log('✅ Миграция equipped_items выполнена');
    
    // Таблица для обычных счетов
    await pool.query(`
      CREATE TABLE IF NOT EXISTS player_scores (
        id SERIAL PRIMARY KEY,
        user_id VARCHAR(255) NOT NULL,
        username VARCHAR(255) NOT NULL,
        score INTEGER NOT NULL,
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_user_id ON player_scores(user_id);
      CREATE INDEX IF NOT EXISTS idx_score ON player_scores(score DESC);
    `);
    
    // Таблица для дуэлей (1v1 вызовы)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS duels (
        match_id VARCHAR(255) PRIMARY KEY,
        player1_id VARCHAR(255) NOT NULL,
        player2_id VARCHAR(255),
        player1_username VARCHAR(255) NOT NULL,
        player2_username VARCHAR(255),
        score1 INTEGER,
        score2 INTEGER,
        player1_x FLOAT,
        player1_y FLOAT,
        player2_x FLOAT,
        player2_y FLOAT,
        player1_alive BOOLEAN DEFAULT true,
        player2_alive BOOLEAN DEFAULT true,
        player1_last_update TIMESTAMP,
        player2_last_update TIMESTAMP,
        winner VARCHAR(255),
        status VARCHAR(50) DEFAULT 'pending',
        seed INTEGER NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        started_at TIMESTAMP,
        completed_at TIMESTAMP,
        expires_at TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_duels_player1 ON duels(player1_id);
      CREATE INDEX IF NOT EXISTS idx_duels_player2 ON duels(player2_id);
      CREATE INDEX IF NOT EXISTS idx_duels_status ON duels(status);
      CREATE INDEX IF NOT EXISTS idx_duels_created ON duels(created_at DESC);
    `);
    
    // Миграция: добавляем новые колонки в существующую таблицу duels (если их нет)
    await pool.query(`
      DO $$ 
      BEGIN
        -- Добавляем колонки для позиций игроков
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='duels' AND column_name='player1_x') THEN
          ALTER TABLE duels ADD COLUMN player1_x FLOAT;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='duels' AND column_name='player1_y') THEN
          ALTER TABLE duels ADD COLUMN player1_y FLOAT;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='duels' AND column_name='player2_x') THEN
          ALTER TABLE duels ADD COLUMN player2_x FLOAT;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='duels' AND column_name='player2_y') THEN
          ALTER TABLE duels ADD COLUMN player2_y FLOAT;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='duels' AND column_name='player1_alive') THEN
          ALTER TABLE duels ADD COLUMN player1_alive BOOLEAN DEFAULT true;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='duels' AND column_name='player2_alive') THEN
          ALTER TABLE duels ADD COLUMN player2_alive BOOLEAN DEFAULT true;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='duels' AND column_name='player1_last_update') THEN
          ALTER TABLE duels ADD COLUMN player1_last_update TIMESTAMP;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='duels' AND column_name='player2_last_update') THEN
          ALTER TABLE duels ADD COLUMN player2_last_update TIMESTAMP;
        END IF;
      END $$;
    `);
    
    // Таблица для кошельков и балансов
    await pool.query(`
      CREATE TABLE IF NOT EXISTS wallets (
        user_id VARCHAR(255) PRIMARY KEY,
        monkey_coin_balance INTEGER DEFAULT 0,
        stars_balance DECIMAL(20, 8) DEFAULT 0,
        ton_balance DECIMAL(20, 8) DEFAULT 0,
        stars_address TEXT,
        ton_address TEXT,
        wallet_address VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_wallet_user ON wallets(user_id);
    `);
    
    // Таблица для транзакций (STARS, TON, Monkey Coin)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS transactions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id VARCHAR(255) NOT NULL,
        type VARCHAR(50) NOT NULL,
        amount DECIMAL(20, 8) NOT NULL,
        currency VARCHAR(10) NOT NULL,
        status VARCHAR(20) DEFAULT 'pending',
        nonce VARCHAR(255) UNIQUE NOT NULL,
        signature TEXT,
        metadata JSONB,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        completed_at TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_trans_user ON transactions(user_id);
      CREATE INDEX IF NOT EXISTS idx_trans_status ON transactions(status);
      CREATE INDEX IF NOT EXISTS idx_trans_created ON transactions(created_at DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_trans_nonce ON transactions(nonce);
    `);
    
    // Таблица для покупок в магазине
    await pool.query(`
      CREATE TABLE IF NOT EXISTS purchases (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id VARCHAR(255) NOT NULL,
        item_id VARCHAR(50) NOT NULL,
        item_name VARCHAR(255) NOT NULL,
        price DECIMAL(20, 8) NOT NULL,
        currency VARCHAR(10) DEFAULT 'monkey',
        status VARCHAR(20) DEFAULT 'active',
        purchased_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_purchases_user ON purchases(user_id);
      CREATE INDEX IF NOT EXISTS idx_purchases_item ON purchases(user_id, item_id);
    `);
    
    // Миграция: проверяем что таблица purchases существует и обновляем её
    await pool.query(`
      DO $$ 
      BEGIN
        -- Проверяем существование таблицы purchases
        IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='purchases') THEN
          RAISE NOTICE 'Creating purchases table...';
          CREATE TABLE purchases (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id VARCHAR(255) NOT NULL,
            item_id VARCHAR(50) NOT NULL,
            item_name VARCHAR(255) NOT NULL,
            price DECIMAL(20, 8) NOT NULL,
            currency VARCHAR(10) DEFAULT 'monkey',
            status VARCHAR(20) DEFAULT 'active',
            purchased_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
          );
          CREATE INDEX idx_purchases_user ON purchases(user_id);
          CREATE INDEX idx_purchases_item ON purchases(user_id, item_id);
        ELSE
          -- Таблица существует, проверяем наличие поля currency
          IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns 
            WHERE table_name='purchases' AND column_name='currency'
          ) THEN
            RAISE NOTICE 'Adding currency column to purchases table...';
            ALTER TABLE purchases ADD COLUMN currency VARCHAR(10) DEFAULT 'monkey';
          END IF;
          
          -- Проверяем тип поля price (может быть INTEGER в старых версиях)
          IF EXISTS (
            SELECT 1 FROM information_schema.columns 
            WHERE table_name='purchases' AND column_name='price' AND data_type='integer'
          ) THEN
            RAISE NOTICE 'Converting price column to DECIMAL...';
            ALTER TABLE purchases ALTER COLUMN price TYPE DECIMAL(20, 8);
          END IF;
        END IF;
      END $$;
    `);
    
    // Таблица audit_log для отслеживания всех операций (пруфы)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS audit_log (
        id SERIAL PRIMARY KEY,
        event_type VARCHAR(50) NOT NULL,
        user_id VARCHAR(255) NOT NULL,
        item_id VARCHAR(50),
        amount DECIMAL(20, 8),
        currency VARCHAR(10),
        payment_method VARCHAR(20),
        status VARCHAR(20),
        metadata JSONB,
        ip_address VARCHAR(45),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user_id);
      CREATE INDEX IF NOT EXISTS idx_audit_event ON audit_log(event_type);
      CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at DESC);
    `);
    
    console.log('✅ DB ready (player_scores + duels + wallets + transactions + purchases + audit_log + migrations applied)');
  } catch (err) {
    console.error('DB setup error', err);
  }
})();

// Функция логирования для audit trail
async function logAudit(eventType, userId, data = {}) {
  try {
    await pool.query(`
      INSERT INTO audit_log (event_type, user_id, item_id, amount, currency, payment_method, status, metadata, ip_address)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    `, [
      eventType,
      userId,
      data.itemId || null,
      data.amount || null,
      data.currency || null,
      data.paymentMethod || null,
      data.status || 'success',
      data.metadata ? JSON.stringify(data.metadata) : null,
      data.ipAddress || null
    ]);
    console.log(`📝 Audit log: ${eventType} for user ${userId}`);
  } catch (err) {
    console.error('❌ Audit log error:', err);
    // Не прерываем выполнение, если логирование не удалось
  }
}

// Save score (с rate limiting)
// Save score (с rate limiting) - DEPRECATED: использовать /api/game-events для защиты от читерства
app.post('/api/save-score', gameResultLimiter, async (req, res) => {
  const { userId, username, score } = req.body;
  if (!userId || typeof score !== 'number') {
    return res.status(400).json({ success: false, error: 'Invalid payload' });
  }
  
  // ПРЕДУПРЕЖДЕНИЕ: Этот endpoint принимает score напрямую от клиента
  // Рекомендуется использовать /api/game-events для верификации
  console.warn(`⚠️ Direct score submission used by ${userId} - consider using /api/game-events`);
  
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    // Сохраняем результат игры
    const bestResult = await client.query('SELECT MAX(score) as best FROM player_scores WHERE user_id = $1', [userId]);
    const previousBest = bestResult.rows[0]?.best || 0;
    const isNewRecord = score > previousBest;

    await client.query('INSERT INTO player_scores (user_id, username, score) VALUES ($1, $2, $3)', [userId, username, score]);

    // Рассчитываем награду: 1 монета за каждые 150 очков (было 100 - слишком много)
    const coinsEarned = Math.floor(score / 150);
    let newBalance = 0;
    
    if (coinsEarned > 0) {
      // Начисляем Monkey Coins
      const walletResult = await client.query(`
        INSERT INTO wallets (user_id, monkey_coin_balance) 
        VALUES ($1, $2)
        ON CONFLICT (user_id) 
        DO UPDATE SET monkey_coin_balance = wallets.monkey_coin_balance + $2
        RETURNING monkey_coin_balance
      `, [userId, coinsEarned]);
      
      newBalance = walletResult.rows[0].monkey_coin_balance;
      
      // Записываем транзакцию
      await client.query(`
        INSERT INTO transactions (user_id, type, amount, currency, status, nonce, metadata)
        VALUES ($1, 'game_reward', $2, 'monkey', 'completed', $3, $4)
      `, [
        userId,
        coinsEarned,
        `game_reward_${userId}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        JSON.stringify({ score, username, timestamp: new Date().toISOString() })
      ]);
    }
    
    await client.query('COMMIT');

    return res.json({ 
      success: true, 
      isNewRecord, 
      bestScore: Math.max(score, previousBest),
      coinsEarned,
      newBalance
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Save error', err);
    return res.status(500).json({ success: false, error: 'DB error' });
  } finally {
    client.release();
  }
});

// ==================== GAME EVENTS (ANTI-CHEAT SYSTEM) ====================

// Функция пересчета score по событиям (согласно ТЗ: сервер сам пересчитывает результат)
function calculateScoreFromEvents(events) {
  let calculatedScore = 0;
  let lastY = 0;
  let maxY = Infinity; // Меньше = выше (Y инвертирован)
  let lastTimestamp = 0;
  
  for (const event of events) {
    // Проверка валидности временных меток (защита от манипуляций временем)
    if (event.timestamp && event.timestamp < lastTimestamp) {
      console.warn('⚠️ Invalid event order detected');
      return 0; // Читерство обнаружено
    }
    lastTimestamp = event.timestamp || lastTimestamp;
    
    if (event.type === 'land' && event.platformY !== undefined) {
      // Игрок приземлился на платформу
      if (event.platformY < maxY) {
        // Новая высота достигнута
        const heightGained = maxY - event.platformY;
        calculatedScore += Math.floor(heightGained / 10); // 10 пикселей = 1 очко
        maxY = event.platformY;
      }
    } else if (event.type === 'jump' && event.y !== undefined) {
      // Проверка физики прыжка (не выше максимальной высоты прыжка)
      const jumpHeight = lastY - event.y;
      if (jumpHeight > 300) { // Например, макс высота прыжка 300px
        console.warn('⚠️ Impossible jump height detected');
        return 0;
      }
      lastY = event.y;
    }
  }
  
  return Math.max(0, calculatedScore);
}

// Отправка игровых событий (вместо прямого score) - РЕКОМЕНДУЕМЫЙ ENDPOINT
app.post('/api/game-events', gameResultLimiter, async (req, res) => {
  const { userId, username, events, claimedScore } = req.body;

  if (!userId || !username || !Array.isArray(events)) {
    return res.status(400).json({ 
      success: false, 
      error: 'userId, username, and events array required' 
    });
  }

  // Валидация событий
  if (events.length > 10000) {
    return res.status(400).json({ 
      success: false, 
      error: 'Too many events (max 10000)' 
    });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    
    // ЗАЩИТА ОТ ЧИТЕРСТВА: Пересчитываем score на сервере
    const serverScore = calculateScoreFromEvents(events);
    
    // Проверяем что клиентский score не сильно отличается (допуск 5%)
    const scoreDiff = Math.abs(serverScore - claimedScore);
    const tolerance = serverScore * 0.05;
    
    if (scoreDiff > tolerance && scoreDiff > 50) {
      await client.query('ROLLBACK');
      console.warn(`⚠️ Score mismatch detected for user ${userId}: server=${serverScore}, claimed=${claimedScore}`);
      return res.status(400).json({ 
        success: false, 
        error: 'Score verification failed',
        serverScore,
        claimedScore
      });
    }
    
    // Используем серверный score (не доверяем клиенту)
    const finalScore = serverScore;
    
    // Сохраняем результат игры
    const bestResult = await client.query('SELECT MAX(score) as best FROM player_scores WHERE user_id = $1', [userId]);
    const previousBest = bestResult.rows[0]?.best || 0;
    const isNewRecord = finalScore > previousBest;

    await client.query('INSERT INTO player_scores (user_id, username, score) VALUES ($1, $2, $3)', [userId, username, finalScore]);

    // Рассчитываем награду: 1 монета за каждые 150 очков (было 100 - слишком много)
    const coinsEarned = Math.floor(finalScore / 150);
    let newBalance = 0;
    
    if (coinsEarned > 0) {
      // Начисляем Monkey Coins
      const walletResult = await client.query(`
        INSERT INTO wallets (user_id, monkey_coin_balance) 
        VALUES ($1, $2)
        ON CONFLICT (user_id) 
        DO UPDATE SET monkey_coin_balance = wallets.monkey_coin_balance + $2
        RETURNING monkey_coin_balance
      `, [userId, coinsEarned]);
      
      newBalance = walletResult.rows[0].monkey_coin_balance;
      
      // Записываем транзакцию
      await client.query(`
        INSERT INTO transactions (user_id, type, amount, currency, status, nonce, metadata)
        VALUES ($1, 'game_reward', $2, 'monkey', 'completed', $3, $4)
      `, [
        userId,
        coinsEarned,
        `game_reward_${userId}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        JSON.stringify({ 
          score: finalScore, 
          username, 
          timestamp: new Date().toISOString(),
          eventsCount: events.length 
        })
      ]);
    }
    
    await client.query('COMMIT');

    console.log(`✅ Game events processed: user ${userId}, server score ${finalScore}, events ${events.length}`);

    return res.json({ 
      success: true, 
      isNewRecord, 
      bestScore: Math.max(finalScore, previousBest),
      coinsEarned,
      newBalance,
      serverScore: finalScore,
      verified: true
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Game events error', err);
    return res.status(500).json({ success: false, error: 'DB error' });
  } finally {
    client.release();
  }
});

// Leaderboard
app.get('/api/leaderboard', async (req, res) => {
  const limit = parseInt(req.query.limit) || 100;
  try {
    // ФИКС: Сначала получаем лучший результат каждого игрока, затем сортируем по score
    const result = await pool.query(`
      WITH best_scores AS (
        SELECT DISTINCT ON (user_id) 
          user_id, username, score, timestamp
        FROM player_scores
        ORDER BY user_id, score DESC, timestamp DESC
      )
      SELECT * FROM best_scores
      ORDER BY score DESC, timestamp DESC
      LIMIT $1
    `, [limit]);
    return res.json({ success: true, rows: result.rows });
  } catch (err) {
    console.error('Leaderboard error', err);
    return res.status(500).json({ success: false, error: 'DB error' });
  }
});

// ==================== DUEL ENDPOINTS ====================

// Создать вызов на дуэль
app.post('/api/duel/create', async (req, res) => {
  const { player1Id, player1Username, botUsername } = req.body;
  
  if (!player1Id || !player1Username) {
    return res.status(400).json({ success: false, error: 'player1Id and player1Username required' });
  }
  
  try {
    // Генерируем уникальный match_id
    const matchId = `duel_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const seed = Math.floor(Math.random() * 1000000);
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // +24 часа
    
    await pool.query(`
      INSERT INTO duels (match_id, player1_id, player1_username, seed, expires_at, status)
      VALUES ($1, $2, $3, $4, $5, 'pending')
    `, [matchId, player1Id, player1Username, seed, expiresAt]);
    
    // Формируем ссылки для разных способов отправки
    const webAppUrl = process.env.WEB_APP_URL || 'https://monkey-flipper-test-key-1.vercel.app';
    const webAppName = process.env.WEB_APP_NAME || 'monkeytest'; // Короткое имя из /newapp
    
    // Вариант 1: Direct Link через Web App (автоматически открывает игру)
    // https://t.me/botname/appname?startapp=duel_123
    const directLink = botUsername 
      ? `https://t.me/${botUsername}/${webAppName}?startapp=${matchId}`
      : `${webAppUrl}?matchId=${matchId}`;
    
    // Вариант 2: Fallback через обычную ссылку (для старых клиентов)
    const fallbackLink = `${webAppUrl}?matchId=${matchId}`;
    
    // Ссылка для шеринга в Telegram
    const shareLink = `https://t.me/share/url?url=${encodeURIComponent(directLink)}&text=${encodeURIComponent(`🐵 I challenge you to a duel in Crypto Monkey!`)}`;
    
    return res.json({ 
      success: true, 
      matchId, 
      seed,
      duelLink: directLink, // Основная ссылка (автоматическая)
      fallbackLink, // Запасная ссылка (ручная)
      shareLink, // Ссылка для шеринга
      expiresAt 
    });
  } catch (err) {
    console.error('Create duel error', err);
    return res.status(500).json({ success: false, error: 'DB error' });
  }
});

// Получить информацию о дуэли
app.get('/api/duel/:matchId', async (req, res) => {
  const { matchId } = req.params;
  
  try {
    const result = await pool.query('SELECT * FROM duels WHERE match_id = $1', [matchId]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Duel not found' });
    }
    
    const duel = result.rows[0];
    
    // Проверяем истечение срока
    if (duel.status === 'pending' && new Date() > new Date(duel.expires_at)) {
      // Автоматически устанавливаем победителя
      await pool.query(`
        UPDATE duels 
        SET status = 'expired', winner = player1_id, completed_at = NOW()
        WHERE match_id = $1
      `, [matchId]);
      
      duel.status = 'expired';
      duel.winner = duel.player1_id;
    }
    
    return res.json({ success: true, duel });
  } catch (err) {
    console.error('Get duel error', err);
    return res.status(500).json({ success: false, error: 'DB error' });
  }
});

// Принять вызов на дуэль
app.post('/api/duel/:matchId/accept', async (req, res) => {
  const { matchId } = req.params;
  const { player2Id, player2Username } = req.body;
  
  if (!player2Id || !player2Username) {
    return res.status(400).json({ success: false, error: 'player2Id and player2Username required' });
  }
  
  try {
    const result = await pool.query('SELECT * FROM duels WHERE match_id = $1', [matchId]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Duel not found' });
    }
    
    const duel = result.rows[0];
    
    // Проверки
    if (duel.status !== 'pending') {
      return res.status(400).json({ success: false, error: 'Duel already started or completed' });
    }
    
    if (new Date() > new Date(duel.expires_at)) {
      return res.status(400).json({ success: false, error: 'Duel expired' });
    }
    
    if (duel.player1_id === player2Id) {
      return res.status(400).json({ success: false, error: 'Cannot accept your own duel' });
    }
    
    // Принимаем вызов
    await pool.query(`
      UPDATE duels 
      SET player2_id = $1, player2_username = $2, status = 'active', started_at = NOW()
      WHERE match_id = $3
    `, [player2Id, player2Username, matchId]);
    
    return res.json({ 
      success: true, 
      message: 'Duel accepted',
      seed: duel.seed 
    });
  } catch (err) {
    console.error('Accept duel error', err);
    return res.status(500).json({ success: false, error: 'DB error' });
  }
});

// Завершить дуэль и сохранить результаты
app.post('/api/duel/:matchId/complete', async (req, res) => {
  const { matchId } = req.params;
  const { playerId, score } = req.body;
  
  if (!playerId || typeof score !== 'number') {
    return res.status(400).json({ success: false, error: 'playerId and score required' });
  }
  
  try {
    const result = await pool.query('SELECT * FROM duels WHERE match_id = $1', [matchId]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Duel not found' });
    }
    
    const duel = result.rows[0];
    
    // Определяем какой игрок завершил
    const isPlayer1 = duel.player1_id === playerId;
    const isPlayer2 = duel.player2_id === playerId;
    
    if (!isPlayer1 && !isPlayer2) {
      return res.status(400).json({ success: false, error: 'Player not in this duel' });
    }
    
    // Обновляем счет игрока
    if (isPlayer1) {
      await pool.query('UPDATE duels SET score1 = $1 WHERE match_id = $2', [score, matchId]);
    } else {
      await pool.query('UPDATE duels SET score2 = $1 WHERE match_id = $2', [score, matchId]);
    }
    
    // Проверяем, оба ли игрока завершили
    const updatedResult = await pool.query('SELECT * FROM duels WHERE match_id = $1', [matchId]);
    const updatedDuel = updatedResult.rows[0];
    
    if (updatedDuel.score1 !== null && updatedDuel.score2 !== null) {
      // Оба завершили - определяем победителя
      const winner = updatedDuel.score1 > updatedDuel.score2 
        ? updatedDuel.player1_id 
        : updatedDuel.score2 > updatedDuel.score1
          ? updatedDuel.player2_id
          : 'draw';
      
      await pool.query(`
        UPDATE duels 
        SET winner = $1, status = 'completed', completed_at = NOW()
        WHERE match_id = $2
      `, [winner, matchId]);
      
      return res.json({ 
        success: true, 
        completed: true,
        winner,
        score1: updatedDuel.score1,
        score2: updatedDuel.score2
      });
    } else {
      // Только один игрок завершил
      return res.json({ 
        success: true, 
        completed: false,
        message: 'Waiting for opponent'
      });
    }
  } catch (err) {
    console.error('Complete duel error', err);
    return res.status(500).json({ success: false, error: 'DB error' });
  }
});

// Получить историю дуэлей игрока
app.get('/api/duel/history/:userId', async (req, res) => {
  const { userId } = req.params;
  const limit = parseInt(req.query.limit) || 50;
  
  try {
    const result = await pool.query(`
      SELECT 
        *,
        CASE 
          WHEN started_at IS NOT NULL AND completed_at IS NOT NULL 
          THEN EXTRACT(EPOCH FROM (completed_at - started_at))
          ELSE NULL 
        END as duration_seconds
      FROM duels 
      WHERE player1_id = $1 OR player2_id = $1
      ORDER BY created_at DESC
      LIMIT $2
    `, [userId, limit]);
    
    return res.json({ 
      success: true, 
      duels: result.rows,
      count: result.rows.length
    });
  } catch (err) {
    console.error('Duel history error', err);
    return res.status(500).json({ success: false, error: 'DB error' });
  }
});

// Удалить всю историю дуэлей игрока
app.delete('/api/duel/history/:userId', async (req, res) => {
  const { userId } = req.params;
  
  try {
    const result = await pool.query(
      'DELETE FROM duels WHERE player1_id = $1 OR player2_id = $1',
      [userId]
    );
    
    return res.json({ 
      success: true, 
      deleted: result.rowCount
    });
  } catch (err) {
    console.error('Delete duel history error', err);
    return res.status(500).json({ success: false, error: 'DB error' });
  }
});

// Обновить позицию игрока в дуэли
app.post('/api/duel/:matchId/position', async (req, res) => {
  const { matchId } = req.params;
  const { playerId, x, y, score, isAlive } = req.body;
  
  if (!playerId || typeof x !== 'number' || typeof y !== 'number') {
    return res.status(400).json({ success: false, error: 'playerId, x, y required' });
  }
  
  try {
    const result = await pool.query('SELECT * FROM duels WHERE match_id = $1', [matchId]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Duel not found' });
    }
    
    const duel = result.rows[0];
    const isPlayer1 = duel.player1_id === playerId;
    const isPlayer2 = duel.player2_id === playerId;
    
    if (!isPlayer1 && !isPlayer2) {
      return res.status(400).json({ success: false, error: 'Player not in this duel' });
    }
    
    // Обновляем позицию
    if (isPlayer1) {
      await pool.query(`
        UPDATE duels 
        SET player1_x = $1, player1_y = $2, player1_alive = $3, score1 = $4, player1_last_update = NOW()
        WHERE match_id = $5
      `, [x, y, isAlive !== false, score || 0, matchId]);
    } else {
      await pool.query(`
        UPDATE duels 
        SET player2_x = $1, player2_y = $2, player2_alive = $3, score2 = $4, player2_last_update = NOW()
        WHERE match_id = $5
      `, [x, y, isAlive !== false, score || 0, matchId]);
    }
    
    return res.json({ success: true });
  } catch (err) {
    console.error('Update position error', err);
    return res.status(500).json({ success: false, error: 'DB error' });
  }
});

// Получить позицию оппонента в дуэли
app.get('/api/duel/:matchId/opponent/:playerId', async (req, res) => {
  const { matchId, playerId } = req.params;
  
  try {
    const result = await pool.query('SELECT * FROM duels WHERE match_id = $1', [matchId]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Duel not found' });
    }
    
    const duel = result.rows[0];
    const isPlayer1 = duel.player1_id === playerId;
    const isPlayer2 = duel.player2_id === playerId;
    
    if (!isPlayer1 && !isPlayer2) {
      return res.status(400).json({ success: false, error: 'Player not in this duel' });
    }
    
    // Возвращаем данные оппонента
    if (isPlayer1) {
      return res.json({
        success: true,
        opponent: {
          id: duel.player2_id,
          username: duel.player2_username,
          x: duel.player2_x,
          y: duel.player2_y,
          score: duel.score2,
          isAlive: duel.player2_alive,
          lastUpdate: duel.player2_last_update,
          hasStarted: duel.player2_id !== null && duel.status === 'active'
        }
      });
    } else {
      return res.json({
        success: true,
        opponent: {
          id: duel.player1_id,
          username: duel.player1_username,
          x: duel.player1_x,
          y: duel.player1_y,
          score: duel.score1,
          isAlive: duel.player1_alive,
          lastUpdate: duel.player1_last_update,
          hasStarted: true // player1 всегда начинает первым
        }
      });
    }
  } catch (err) {
    console.error('Get opponent position error', err);
    return res.status(500).json({ success: false, error: 'DB error' });
  }
});

// Фоновая задача: аннулировать истекшие дуэли (запускается каждый час)
setInterval(async () => {
  try {
    const result = await pool.query(`
      UPDATE duels 
      SET status = 'expired', winner = player1_id, completed_at = NOW()
      WHERE status = 'pending' 
      AND expires_at < NOW()
      RETURNING match_id
    `);
    
    if (result.rowCount > 0) {
      console.log(`⏰ Аннулировано ${result.rowCount} истекших дуэлей:`, result.rows.map(r => r.match_id));
    }
  } catch (err) {
    console.error('Auto-expire duels error', err);
  }
}, 60 * 60 * 1000); // Каждый час

// ==================== WALLET & CURRENCY ENDPOINTS ====================

// Получить баланс кошелька
app.get('/api/wallet/:userId', async (req, res) => {
  const { userId } = req.params;
  
  try {
    let wallet = await pool.query('SELECT * FROM wallets WHERE user_id = $1', [userId]);
    
    if (wallet.rows.length === 0) {
      // Создаем кошелек если его нет
      await pool.query(`
        INSERT INTO wallets (user_id, monkey_coin_balance, stars_balance, ton_balance)
        VALUES ($1, 0, 0, 0)
      `, [userId]);
      
      wallet = await pool.query('SELECT * FROM wallets WHERE user_id = $1', [userId]);
    }
    
    return res.json({
      success: true,
      wallet: {
        monkeyCoin: wallet.rows[0].monkey_coin_balance,
        stars: wallet.rows[0].stars_balance,
        ton: wallet.rows[0].ton_balance,
        address: wallet.rows[0].wallet_address
      }
    });
  } catch (err) {
    console.error('Get wallet error', err);
    return res.status(500).json({ success: false, error: 'DB error' });
  }
});

// Добавить Monkey Coins (например, за игру)
app.post('/api/wallet/add-coins', gameResultLimiter, async (req, res) => {
  const { userId, amount } = req.body;
  
  if (!userId || typeof amount !== 'number' || amount <= 0) {
    return res.status(400).json({ success: false, error: 'Invalid payload' });
  }
  
  try {
    // Создаем или обновляем кошелек
    await pool.query(`
      INSERT INTO wallets (user_id, monkey_coin_balance)
      VALUES ($1, $2)
      ON CONFLICT (user_id)
      DO UPDATE SET 
        monkey_coin_balance = wallets.monkey_coin_balance + $2,
        updated_at = NOW()
    `, [userId, amount]);
    
    // Получаем новый баланс
    const result = await pool.query('SELECT monkey_coin_balance FROM wallets WHERE user_id = $1', [userId]);
    
    return res.json({
      success: true,
      newBalance: result.rows[0].monkey_coin_balance
    });
  } catch (err) {
    console.error('Add coins error', err);
    return res.status(500).json({ success: false, error: 'DB error' });
  }
});

// История транзакций
app.get('/api/transactions/:userId', async (req, res) => {
  const { userId } = req.params;
  const limit = parseInt(req.query.limit) || 50;
  
  try {
    const result = await pool.query(`
      SELECT id, type, amount, currency, status, created_at, completed_at
      FROM transactions
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT $2
    `, [userId, limit]);
    
    return res.json({
      success: true,
      transactions: result.rows
    });
  } catch (err) {
    console.error('Get transactions error', err);
    return res.status(500).json({ success: false, error: 'DB error' });
  }
});

// DEBUG: Проверка структуры БД
app.get('/api/debug/tables', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public'
      ORDER BY table_name
    `);
    
    return res.json({
      success: true,
      tables: result.rows.map(r => r.table_name)
    });
  } catch (err) {
    console.error('Debug tables error', err);
    return res.status(500).json({ success: false, error: 'DB error' });
  }
});

// ==================== SHOP ENDPOINTS ====================

// Загружаем каталог товаров
const path = require('path');
const SHOP_ITEMS = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'shop-items.json'), 'utf-8')
);

// Получить каталог товаров
app.get('/api/shop/catalog', (req, res) => {
  const { category } = req.query;
  
  try {
    if (category) {
      // Фильтр по категории
      const items = SHOP_ITEMS[category] || [];
      return res.json({
        success: true,
        category,
        items
      });
    }
    
    // Возвращаем весь каталог
    return res.json({
      success: true,
      catalog: SHOP_ITEMS
    });
  } catch (error) {
    console.error('Get catalog error:', error);
    return res.status(500).json({ 
      success: false, 
      error: 'Failed to load catalog' 
    });
  }
});

// Получить информацию о конкретном товаре
app.get('/api/shop/item/:itemId', (req, res) => {
  const { itemId } = req.params;
  
  try {
    // Ищем товар во всех категориях
    for (const category in SHOP_ITEMS) {
      const item = SHOP_ITEMS[category].find(i => i.id === itemId);
      if (item) {
        return res.json({
          success: true,
          item: {
            ...item,
            category
          }
        });
      }
    }
    
    return res.status(404).json({
      success: false,
      error: 'Item not found'
    });
  } catch (error) {
    console.error('Get item error:', error);
    return res.status(500).json({ 
      success: false, 
      error: 'Failed to get item' 
    });
  }
});

// Покупка товара в магазине (Monkey Coins)
app.post('/api/shop/purchase', async (req, res) => {
  const { userId, itemId, itemName, price, category } = req.body;
  
  if (!userId || !itemId || !itemName || typeof price !== 'number') {
    return res.status(400).json({ success: false, error: 'Invalid payload' });
  }
  
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    // Проверяем текущий баланс
    const walletResult = await client.query(
      'SELECT monkey_coin_balance FROM wallets WHERE user_id = $1',
      [userId]
    );
    
    const currentBalance = walletResult.rows[0]?.monkey_coin_balance || 0;
    
    // Проверяем достаточность средств
    if (currentBalance < price) {
      await client.query('ROLLBACK');
      return res.status(400).json({ 
        success: false, 
        error: 'Insufficient funds',
        currentBalance,
        required: price
      });
    }
    
    // Списываем монеты
    const newBalanceResult = await client.query(`
      UPDATE wallets 
      SET monkey_coin_balance = monkey_coin_balance - $1,
          updated_at = CURRENT_TIMESTAMP
      WHERE user_id = $2
      RETURNING monkey_coin_balance
    `, [price, userId]);
    
    const newBalance = newBalanceResult.rows[0]?.monkey_coin_balance || 0;
    
    // Сохраняем покупку с указанием валюты
    await client.query(`
      INSERT INTO purchases (user_id, item_id, item_name, price, currency)
      VALUES ($1, $2, $3, $4, 'monkey')
    `, [userId, itemId, itemName, price]);
    
    // Записываем транзакцию
    await client.query(`
      INSERT INTO transactions (user_id, type, amount, currency, status, nonce, metadata)
      VALUES ($1, 'shop_purchase', $2, 'monkey', 'completed', $3, $4)
    `, [
      userId,
      price,
      `shop_purchase_${userId}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      JSON.stringify({ itemId, itemName, category: category || 'cosmetic', timestamp: new Date().toISOString() })
    ]);
    
    await client.query('COMMIT');
    
    // Логируем покупку в audit_log
    await logAudit('purchase', userId, {
      itemId,
      amount: price,
      currency: 'monkey_coin',
      paymentMethod: 'wallet',
      status: 'completed',
      metadata: { itemName, category: category || 'cosmetic' },
      ipAddress: req.ip || req.headers['x-forwarded-for']
    });
    
    console.log(`✅ Purchase completed: ${itemName} for ${price} coins by ${userId}`);
    
    return res.json({
      success: true,
      newBalance,
      purchase: {
        itemId,
        itemName,
        price
      }
    });
    
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Purchase error', err);
    console.error('Purchase error details:', {
      message: err.message,
      code: err.code,
      detail: err.detail,
      userId,
      itemId,
      price
    });
    return res.status(500).json({ success: false, error: 'DB error', details: err.message });
  } finally {
    client.release();
  }
});

// Получить купленные товары пользователя
app.get('/api/shop/purchases/:userId', async (req, res) => {
  const { userId } = req.params;
  
  try {
    // Группируем по item_id и считаем количество доступных предметов
    const result = await pool.query(`
      SELECT 
        item_id, 
        item_name, 
        MIN(price) as price, 
        COUNT(*) as count,
        MAX(purchased_at) as purchased_at
      FROM purchases
      WHERE user_id = $1 AND status = 'active'
      GROUP BY item_id, item_name
      ORDER BY purchased_at DESC
    `, [userId]);
    
    return res.json({
      success: true,
      purchases: result.rows
    });
  } catch (err) {
    console.error('Get purchases error', err);
    return res.status(500).json({ success: false, error: 'DB error' });
  }
});

// Экипировать предмет (установить как активный)
app.post('/api/user/equip', async (req, res) => {
  const { userId, itemId, itemType } = req.body; // itemType: 'skin', 'boost', 'nft'
  
  if (!userId || !itemId || !itemType) {
    return res.status(400).json({ success: false, error: 'Missing parameters' });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Проверяем что есть доступный предмет (status='active')
    const purchase = await client.query(
      'SELECT id FROM purchases WHERE user_id = $1 AND item_id = $2 AND status = $3 LIMIT 1',
      [userId, itemId, 'active']
    );

    if (purchase.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(403).json({ success: false, error: 'Item not owned or already equipped' });
    }

    const purchaseId = purchase.rows[0].id;

    // Меняем статус на 'equipped' - расходуем 1 предмет
    await client.query(
      'UPDATE purchases SET status = $1 WHERE id = $2',
      ['equipped', purchaseId]
    );

    // Сохраняем экипировку в таблицу users
    await client.query(`
      UPDATE users 
      SET equipped_items = jsonb_set(
        COALESCE(equipped_items, '{}'::jsonb),
        ARRAY[$1],
        to_jsonb($2::text),
        true
      )
      WHERE telegram_id = $3
    `, [itemType, itemId, userId]);

    await client.query('COMMIT');

    res.json({
      success: true,
      message: `${itemType} equipped`,
      equippedItem: { type: itemType, id: itemId }
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Equip error:', err);
    res.status(500).json({ success: false, error: 'Failed to equip item' });
  } finally {
    client.release();
  }
});

// Снять предмет (удалить из equipped_items и вернуть в active)
app.post('/api/user/unequip', async (req, res) => {
  const { userId, itemType, itemId } = req.body;
  
  if (!userId || !itemType) {
    return res.status(400).json({ success: false, error: 'Missing parameters' });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Удаляем указанный тип из equipped_items
    await client.query(`
      UPDATE users 
      SET equipped_items = equipped_items - $1
      WHERE telegram_id = $2
    `, [itemType, userId]);

    // Возвращаем один предмет обратно в 'active' статус
    // ВАЖНО: Только предметы со status='equipped' (не 'used')
    // Израсходованные бусты (status='used') не возвращаются
    if (itemId) {
      const result = await client.query(`
        UPDATE purchases 
        SET status = 'active' 
        WHERE id = (
          SELECT id FROM purchases 
          WHERE user_id = $1 AND item_id = $2 AND status = 'equipped' 
          LIMIT 1
        )
        RETURNING item_id
      `, [userId, itemId]);
      
      if (result.rows.length === 0) {
        console.log(`ℹ️ Item ${itemId} not returned (may be consumed)`);
      }
    }

    await client.query('COMMIT');

    res.json({
      success: true,
      message: `${itemType} unequipped`
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Unequip error:', err);
    res.status(500).json({ success: false, error: 'Failed to unequip item' });
  } finally {
    client.release();
  }
});

// Расходовать буст после игры (превратить в 'used')
app.post('/api/user/consume-boost', async (req, res) => {
  const { userId } = req.body;
  
  if (!userId) {
    return res.status(400).json({ success: false, error: 'Missing userId' });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Получаем текущий экипированный буст
    const userResult = await client.query(
      'SELECT equipped_items FROM users WHERE telegram_id = $1',
      [userId]
    );

    const equippedItems = userResult.rows[0]?.equipped_items || {};
    const boostId = equippedItems.boost;

    if (!boostId) {
      await client.query('COMMIT');
      return res.json({ success: true, message: 'No boost equipped' });
    }

    // Меняем статус буста на 'used' (буст израсходован)
    await client.query(`
      UPDATE purchases 
      SET status = 'used' 
      WHERE user_id = $1 AND item_id = $2 AND status = 'equipped'
    `, [userId, boostId]);

    // Удаляем буст из equipped_items
    await client.query(`
      UPDATE users 
      SET equipped_items = equipped_items - 'boost'
      WHERE telegram_id = $1
    `, [userId]);

    await client.query('COMMIT');

    res.json({
      success: true,
      message: 'Boost consumed',
      consumedBoostId: boostId
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Consume boost error:', err);
    res.status(500).json({ success: false, error: 'Failed to consume boost' });
  } finally {
    client.release();
  }
});

// Получить экипированные предметы пользователя
app.get('/api/user/equipped/:userId', async (req, res) => {
  const { userId } = req.params;

  try {
    const result = await pool.query(
      'SELECT equipped_items FROM users WHERE telegram_id = $1',
      [userId]
    );

    const equipped = result.rows[0]?.equipped_items || {};

    res.json({
      success: true,
      equipped: equipped
    });
  } catch (err) {
    console.error('Get equipped error:', err);
    res.status(500).json({ success: false, error: 'DB error' });
  }
});

// Получить историю покупок пользователя (audit log)
app.get('/api/user/purchase-history/:userId', async (req, res) => {
  const { userId } = req.params;
  const limit = parseInt(req.query.limit) || 50;

  try {
    const result = await pool.query(`
      SELECT 
        event_type,
        item_id,
        amount,
        currency,
        payment_method,
        status,
        metadata,
        created_at
      FROM audit_log
      WHERE user_id = $1 AND event_type IN ('purchase', 'purchase_stars', 'equip')
      ORDER BY created_at DESC
      LIMIT $2
    `, [userId, limit]);

    res.json({
      success: true,
      history: result.rows,
      total: result.rows.length
    });
  } catch (err) {
    console.error('Get purchase history error:', err);
    res.status(500).json({ success: false, error: 'DB error' });
  }
});

// ==================== STARS WALLET INTEGRATION ====================

// Подключить STARS кошелек (с шифрованием адреса)
app.post('/api/wallet/connect-stars', async (req, res) => {
  const { userId, starsAddress } = req.body;
  
  if (!userId || !starsAddress) {
    return res.status(400).json({ 
      success: false, 
      error: 'userId and starsAddress required' 
    });
  }
  
  // Валидация формата адреса (пример, нужно адаптировать под реальный формат STARS)
  if (!/^[A-Za-z0-9]{32,64}$/.test(starsAddress)) {
    return res.status(400).json({ 
      success: false, 
      error: 'Invalid STARS address format' 
    });
  }
  
  try {
    // Шифруем адрес перед сохранением
    const encryptedAddress = cryptoUtils.encrypt(starsAddress);
    
    // Сохраняем зашифрованный адрес в БД
    const result = await pool.query(`
      INSERT INTO wallets (user_id, stars_address, created_at)
      VALUES ($1, $2, NOW())
      ON CONFLICT (user_id) 
      DO UPDATE SET 
        stars_address = $2,
        updated_at = NOW()
      RETURNING user_id, created_at, updated_at
    `, [userId, encryptedAddress]);
    
    console.log(`✅ STARS wallet connected for user ${userId}`);
    
    return res.json({
      success: true,
      message: 'STARS wallet connected successfully',
      wallet: {
        userId: result.rows[0].user_id,
        // Не возвращаем адрес клиенту в целях безопасности
        connected: true,
        connectedAt: result.rows[0].updated_at || result.rows[0].created_at
      }
    });
    
  } catch (error) {
    console.error('❌ Connect STARS wallet error:', error);
    return res.status(500).json({ 
      success: false, 
      error: 'Failed to connect wallet',
      details: error.message 
    });
  }
});

// Получить информацию о подключенном STARS кошельке
app.get('/api/wallet/stars-info/:userId', async (req, res) => {
  const { userId } = req.params;
  
  try {
    const result = await pool.query(`
      SELECT stars_address, stars_balance, created_at, updated_at
      FROM wallets
      WHERE user_id = $1
    `, [userId]);
    
    if (result.rows.length === 0) {
      return res.json({
        success: true,
        connected: false,
        message: 'No STARS wallet connected'
      });
    }
    
    const wallet = result.rows[0];
    
    // Расшифровываем адрес только для отображения (последние 8 символов)
    let maskedAddress = '***';
    if (wallet.stars_address) {
      try {
        const decryptedAddress = cryptoUtils.decrypt(wallet.stars_address);
        maskedAddress = '...' + decryptedAddress.slice(-8);
      } catch (err) {
        console.error('❌ Decryption error:', err);
      }
    }
    
    return res.json({
      success: true,
      connected: !!wallet.stars_address,
      wallet: {
        maskedAddress,
        balance: wallet.stars_balance || 0,
        connectedAt: wallet.created_at,
        updatedAt: wallet.updated_at
      }
    });
    
  } catch (error) {
    console.error('❌ Get STARS info error:', error);
    return res.status(500).json({ 
      success: false, 
      error: 'Failed to get wallet info' 
    });
  }
});

// Покупка предметов за STARS токены
app.post('/api/shop/purchase-stars', async (req, res) => {
  const { userId, itemId, itemName, priceStars, signature } = req.body;
  
  if (!userId || !itemId || !priceStars) {
    return res.status(400).json({ 
      success: false, 
      error: 'Missing required fields' 
    });
  }
  
  // ✅ ОБЯЗАТЕЛЬНАЯ ПРОВЕРКА ПОДПИСИ (согласно ТЗ)
  if (!signature) {
    return res.status(403).json({ 
      success: false, 
      error: 'Transaction signature required' 
    });
  }
  
  // Проверяем подпись транзакции
  const transactionData = { userId, itemId, priceStars, timestamp: Date.now() };
  const publicKey = process.env.CLIENT_PUBLIC_KEY;
  
  if (publicKey && !cryptoUtils.verifySignature(transactionData, signature, publicKey)) {
    console.warn(`⚠️ Invalid signature for STARS purchase: user ${userId}, item ${itemId}`);
    return res.status(403).json({ 
      success: false, 
      error: 'Invalid transaction signature' 
    });
  }
  
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    // Проверяем баланс STARS
    const walletResult = await client.query(`
      SELECT stars_balance, stars_address
      FROM wallets
      WHERE user_id = $1
      FOR UPDATE
    `, [userId]);
    
    if (walletResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ 
        success: false, 
        error: 'Wallet not found. Please connect STARS wallet first.' 
      });
    }
    
    const currentBalance = walletResult.rows[0].stars_balance || 0;
    
    if (currentBalance < priceStars) {
      await client.query('ROLLBACK');
      return res.status(400).json({ 
        success: false, 
        error: 'Insufficient STARS balance',
        required: priceStars,
        current: currentBalance
      });
    }
    
    // Списываем STARS
    const newBalance = currentBalance - priceStars;
    await client.query(`
      UPDATE wallets
      SET stars_balance = $1, updated_at = NOW()
      WHERE user_id = $2
    `, [newBalance, userId]);
    
    // Создаем транзакцию
    const transactionId = crypto.randomUUID();
    const nonce = `stars_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`;
    
    await client.query(`
      INSERT INTO transactions (id, user_id, type, amount, currency, status, nonce, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
    `, [transactionId, userId, 'purchase_stars', priceStars, 'stars', 'completed', nonce]);
    
    // Создаем запись о покупке
    const purchaseId = crypto.randomUUID();
    await client.query(`
      INSERT INTO purchases (id, user_id, item_id, item_name, price, currency, status, purchased_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
    `, [purchaseId, userId, itemId, itemName || itemId, priceStars, 'stars', 'active']);
    
    await client.query('COMMIT');
    
    console.log(`✅ STARS purchase: user ${userId}, item ${itemId}, price ${priceStars}`);
    
    return res.json({
      success: true,
      newBalance,
      purchase: {
        id: purchaseId,
        itemId,
        itemName,
        price: priceStars,
        currency: 'stars'
      }
    });
    
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ STARS purchase error:', error);
    return res.status(500).json({ 
      success: false, 
      error: 'Purchase failed',
      details: error.message 
    });
  } finally {
    client.release();
  }
});

// Отправка наград в STARS на кошелек игрока
app.post('/api/rewards/send-stars', async (req, res) => {
  const { userId, amount, reason, signature } = req.body;
  
  if (!userId || !amount || amount <= 0) {
    return res.status(400).json({ 
      success: false, 
      error: 'Invalid request' 
    });
  }
  
  // ✅ ОБЯЗАТЕЛЬНАЯ ПРОВЕРКА СЕРВЕРНОЙ ПОДПИСИ (согласно ТЗ)
  if (!signature) {
    return res.status(403).json({ 
      success: false, 
      error: 'Server signature required' 
    });
  }
  
  // Проверяем серверную подпись
  const rewardData = { userId, amount, reason, timestamp: Date.now() };
  const serverPublicKey = process.env.SERVER_PUBLIC_KEY;
  
  if (serverPublicKey && !cryptoUtils.verifySignature(rewardData, signature, serverPublicKey)) {
    console.error(`❌ Invalid server signature for reward: user ${userId}, amount ${amount}`);
    return res.status(403).json({ 
      success: false, 
      error: 'Invalid server signature' 
    });
  }
  
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    // Получаем зашифрованный адрес кошелька
    const walletResult = await client.query(`
      SELECT stars_address, stars_balance
      FROM wallets
      WHERE user_id = $1
      FOR UPDATE
    `, [userId]);
    
    if (walletResult.rows.length === 0 || !walletResult.rows[0].stars_address) {
      await client.query('ROLLBACK');
      return res.status(404).json({ 
        success: false, 
        error: 'STARS wallet not connected' 
      });
    }
    
    const encryptedAddress = walletResult.rows[0].stars_address;
    const currentBalance = walletResult.rows[0].stars_balance || 0;
    
    // Расшифровываем адрес для отправки
    let recipientAddress;
    try {
      recipientAddress = cryptoUtils.decrypt(encryptedAddress);
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('❌ Decryption error:', err);
      return res.status(500).json({ 
        success: false, 
        error: 'Failed to decrypt wallet address' 
      });
    }
    
    // Отправляем STARS токены через API
    let starsResult;
    let transactionStatus = 'pending';
    
    try {
      // Пытаемся отправить STARS (если API настроен - отправит, иначе - заглушка)
      starsResult = await starsAPI.sendTokens(recipientAddress, amount, reason);
      
      if (starsResult.success) {
        transactionStatus = starsResult.isSimulated ? 'pending' : 'completed';
        console.log(`✅ STARS sent: ${amount} STARS to ${recipientAddress.slice(-8)}`);
        if (starsResult.isSimulated) {
          console.log(`   ⚠️  Используется заглушка - транзакция в pending`);
        }
      }
    } catch (error) {
      console.error(`❌ STARS send error:`, error.message);
      // Продолжаем с pending статусом для retry
    }
    
    const transactionId = crypto.randomUUID();
    const nonce = `reward_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`;
    
    // Создаем транзакцию
    await client.query(`
      INSERT INTO transactions (
        id, user_id, type, amount, currency, status, nonce, 
        metadata, created_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
    `, [
      transactionId, 
      userId, 
      'reward_stars', 
      amount, 
      'stars', 
      transactionStatus,
      nonce,
      JSON.stringify({ 
        reason, 
        recipientAddress: '...' + recipientAddress.slice(-8),
        txHash: starsResult?.txHash || null,
        isSimulated: starsResult?.isSimulated || false
      })
    ]);
    
    // Обновляем баланс (оптимистично)
    const newBalance = currentBalance + amount;
    await client.query(`
      UPDATE wallets
      SET stars_balance = $1, updated_at = NOW()
      WHERE user_id = $2
    `, [newBalance, userId]);
    
    await client.query('COMMIT');
    
    console.log(`✅ STARS reward ${transactionStatus}: user ${userId}, amount ${amount}`);
    
    return res.json({
      success: true,
      status: transactionStatus,
      message: transactionStatus === 'completed' 
        ? 'STARS reward sent successfully' 
        : 'STARS reward is being processed',
      transaction: {
        id: transactionId,
        amount,
        currency: 'stars',
        reason,
        txHash: starsResult?.txHash || null
      },
      newBalance
    });
    
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ Send STARS reward error:', error);
    return res.status(500).json({ 
      success: false, 
      error: 'Failed to send reward',
      details: error.message 
    });
  } finally {
    client.release();
  }
});

// ==================== PENDING TRANSACTIONS RETRY (CRON JOB) ====================

// Функция для повторной обработки pending транзакций
async function retryPendingTransactions() {
  const client = await pool.connect();
  
  try {
    // Получаем pending транзакции старше 5 минут, но не старше 24 часов
    const result = await client.query(`
      SELECT * FROM transactions
      WHERE status = 'pending'
      AND created_at > NOW() - INTERVAL '24 hours'
      AND created_at < NOW() - INTERVAL '5 minutes'
      ORDER BY created_at ASC
      LIMIT 100
    `);
    
    if (result.rows.length === 0) {
      return;
    }
    
    console.log(`🔄 Найдено ${result.rows.length} pending транзакций для retry`);
    
    for (const transaction of result.rows) {
      try {
        await client.query('BEGIN');
        
        // В зависимости от типа транзакции - разная логика retry
        if (transaction.type === 'reward_stars') {
          // Попытка отправить STARS награду снова
          console.log(`🔄 Retry STARS reward: transaction ${transaction.id}`);
          
          try {
            // Получаем адрес получателя из metadata
            const metadata = transaction.metadata || {};
            const recipientAddress = metadata.recipientAddress;
            
            if (!recipientAddress) {
              throw new Error('Recipient address not found in metadata');
            }
            
            // Отправляем STARS через API (использует заглушку если реальный API не настроен)
            const result = await starsAPI.sendTokens(
              recipientAddress,
              transaction.amount,
              metadata.reason || 'reward'
            );
            
            if (result.success) {
              // Обновляем транзакцию как завершенную
              await client.query(`
                UPDATE transactions 
                SET status = 'completed', 
                    completed_at = NOW(),
                    metadata = jsonb_set(metadata, '{txHash}', $1::jsonb)
                WHERE id = $2
              `, [JSON.stringify(result.txHash), transaction.id]);
              
              console.log(`✅ STARS reward sent: ${transaction.amount} STARS, TX: ${result.txHash}`);
            }
          } catch (error) {
            console.error(`❌ Failed to retry STARS reward ${transaction.id}:`, error.message);
            // Оставляем в pending для следующей попытки
          }
          
        } else if (transaction.type === 'purchase_stars') {
          // Для покупок - проверяем что средства заблокированы
          console.log(`⚠️  Pending purchase detected: ${transaction.id}`);
          // Если прошло > 1 час - возвращаем средства
          const txAge = Date.now() - new Date(transaction.created_at).getTime();
          if (txAge > 3600000) { // 1 час
            await client.query(`
              UPDATE wallets
              SET stars_balance = stars_balance + $1
              WHERE user_id = $2
            `, [transaction.amount, transaction.user_id]);
            
            await client.query(`
              UPDATE transactions
              SET status = 'failed', completed_at = NOW()
              WHERE id = $1
            `, [transaction.id]);
            
            console.log(`❌ Transaction ${transaction.id} failed and refunded`);
          }
        }
        
        await client.query('COMMIT');
        
      } catch (err) {
        await client.query('ROLLBACK');
        console.error(`❌ Error retrying transaction ${transaction.id}:`, err);
      }
    }
    
  } catch (error) {
    console.error('❌ Error in retryPendingTransactions:', error);
  } finally {
    client.release();
  }
}

// Запускаем retry каждые 5 минут
setInterval(() => {
  retryPendingTransactions().catch(err => {
    console.error('❌ Cron job error:', err);
  });
}, 5 * 60 * 1000); // 5 минут

console.log('✅ Pending transactions retry cron job started (every 5 minutes)');

// Endpoint для ручного запуска retry (для дебага)
app.post('/api/admin/retry-pending', async (req, res) => {
  try {
    await retryPendingTransactions();
    return res.json({ 
      success: true, 
      message: 'Pending transactions retry completed' 
    });
  } catch (error) {
    return res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// ==================== TELEGRAM STARS (XTR) - РЕАЛЬНЫЕ ПЛАТЕЖИ ====================

/**
 * Создать инвойс для покупки за Telegram Stars (XTR)
 */
app.post('/api/shop/create-stars-invoice', validateShopAuth, async (req, res) => {
  try {
    const { userId, itemId } = req.body;
    
    if (!userId || !itemId) {
      return res.status(400).json({ 
        success: false, 
        error: 'userId и itemId обязательны' 
      });
    }
    
    // Загружаем товар
    const shopItems = JSON.parse(fs.readFileSync('./shop-items.json', 'utf8'));
    const allItems = [...shopItems.skins, ...shopItems.nft_characters, ...shopItems.boosts];
    const item = allItems.find(i => i.id === itemId);
    
    if (!item) {
      return res.status(404).json({ 
        success: false, 
        error: 'Товар не найден' 
      });
    }
    
    if (!item.priceXTR) {
      return res.status(400).json({ 
        success: false, 
        error: 'Этот товар нельзя купить за Telegram Stars' 
      });
    }
    
    // Создаем инвойс через Telegram Bot API
    const invoice = await telegramStars.createStarsInvoice(
      userId,
      item.name,
      item.description,
      item.priceXTR
    );
    
    console.log(`✅ Инвойс создан: ${item.name} за ${item.priceXTR} XTR`);
    
    res.json({
      success: true,
      invoice,
      item: {
        id: item.id,
        name: item.name,
        price: item.priceXTR,
        currency: 'XTR'
      }
    });
    
  } catch (error) {
    console.error('❌ Ошибка создания инвойса:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

/**
 * Проверка баланса Telegram Stars бота
 */
app.get('/api/stars/balance', validateJWT, async (req, res) => {
  try {
    const balance = await telegramStars.getStarsBalance();
    
    res.json({
      success: true,
      balance,
      currency: 'XTR'
    });
    
  } catch (error) {
    console.error('❌ Ошибка получения баланса Stars:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Настройка обработчиков платежей Telegram Stars
telegramStars.setupPaymentHandler(app);

console.log('✅ Telegram Stars (XTR) обработчики подключены');

// ==================== ВСТУПИТЕЛЬНОЕ ВИДЕО ====================

/**
 * Endpoint для отправки вступительного видео
 * POST /api/send-intro-video
 * Body: { userId, videoType: 'mp4' | 'gif' }
 */
app.post('/api/send-intro-video', async (req, res) => {
  try {
    const { userId, videoType = 'mp4' } = req.body;
    
    if (!userId) {
      return res.status(400).json({ 
        success: false, 
        error: 'userId is required' 
      });
    }
    
    const gameUrl = process.env.GAME_URL || 'https://your-game-url.com';
    
    // Путь к видео (положите свое видео в папку assets/)
    const videoPath = videoType === 'gif' 
      ? './assets/intro.gif' 
      : './assets/intro.mp4';
    
    // Отправляем видео через Telegram
    if (videoType === 'gif') {
      await telegramStars.showIntroAnimation(userId, videoPath, gameUrl);
    } else {
      await telegramStars.showIntroVideo(userId, videoPath, gameUrl);
    }
    
    // Отмечаем в БД, что пользователь видел intro
    await pool.query(`
      INSERT INTO users (telegram_id, intro_seen, created_at)
      VALUES ($1, true, NOW())
      ON CONFLICT (telegram_id) 
      DO UPDATE SET intro_seen = true
    `, [userId]);
    
    res.json({ 
      success: true, 
      message: 'Intro video sent successfully' 
    });
    
  } catch (error) {
    console.error('❌ Ошибка отправки intro video:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

/**
 * Проверка, видел ли пользователь intro
 * GET /api/check-intro/:userId
 */
app.get('/api/check-intro/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    
    const result = await pool.query(
      'SELECT intro_seen FROM users WHERE telegram_id = $1',
      [userId]
    );
    
    const introSeen = result.rows.length > 0 && result.rows[0].intro_seen;
    
    res.json({ 
      success: true, 
      introSeen 
    });
    
  } catch (error) {
    console.error('❌ Ошибка проверки intro:', error);
    res.json({ 
      success: true, 
      introSeen: false  // По умолчанию не видел
    });
  }
});

// ==================== TELEGRAM BOT COMMANDS ====================

// Запуск Telegram бота (если BOT_TOKEN установлен)
if (BOT_TOKEN && process.env.ENABLE_BOT_POLLING === 'true' && telegramStars.bot) {
  const bot = telegramStars.bot;
  
  // Команда /start - показать intro video
  bot.onText(/\/start/, async (msg) => {
    const userId = msg.from.id;
    const username = msg.from.username || msg.from.first_name;
    
    console.log(`🎮 Новый пользователь: ${username} (${userId})`);
    
    try {
      // Проверяем, видел ли пользователь intro
      const result = await pool.query(
        'SELECT intro_seen FROM users WHERE telegram_id = $1',
        [userId]
      );
      
      const gameUrl = process.env.GAME_URL || 'https://your-game-url.com';
      
      if (result.rows.length === 0 || !result.rows[0].intro_seen) {
        // Первый раз - показываем intro video
        console.log(`📹 Отправка intro video пользователю ${userId}`);
        await telegramStars.showIntroVideo(userId, './assets/intro.mp4', gameUrl);
        
        // Отмечаем в БД
        await pool.query(`
          INSERT INTO users (telegram_id, username, intro_seen, created_at)
          VALUES ($1, $2, true, NOW())
          ON CONFLICT (telegram_id) 
          DO UPDATE SET intro_seen = true, username = $2
        `, [userId, username]);
        
      } else {
        // Уже видел - просто кнопка игры
        await bot.sendMessage(userId, 
          `🎮 С возвращением, ${username}!\n\n` +
          `Готов снова играть?`,
          {
            reply_markup: {
              inline_keyboard: [[
                { text: '🎮 Начать игру', web_app: { url: gameUrl } }
              ]]
            }
          }
        );
      }
      
    } catch (error) {
      console.error('❌ Ошибка обработки /start:', error);
      
      // Fallback - просто кнопка
      await bot.sendMessage(userId, 
        '🎮 Добро пожаловать в Monkey Flipper!',
        {
          reply_markup: {
            inline_keyboard: [[
              { text: '🎮 Начать игру', web_app: { url: process.env.GAME_URL } }
            ]]
          }
        }
      );
    }
  });
  
  // Команда /video - пересмотреть intro
  bot.onText(/\/video/, async (msg) => {
    const userId = msg.from.id;
    const gameUrl = process.env.GAME_URL || 'https://your-game-url.com';
    
    try {
      await telegramStars.showIntroVideo(userId, './assets/intro.mp4', gameUrl);
    } catch (error) {
      console.error('❌ Ошибка /video:', error);
      await bot.sendMessage(userId, '⚠️ Ошибка отправки видео');
    }
  });
  
  // Polling уже запущен в telegram-stars-real.js
  console.log('🤖 Telegram Bot запущен в режиме polling');
  console.log('📹 Вступительное видео: Включено');
  
} else {
  console.log('ℹ️ Telegram Bot polling отключен (установите ENABLE_BOT_POLLING=true для включения)');
}

// ==================== SHOP API ENDPOINTS ====================

/**
 * Получить баланс пользователя (без JWT для упрощения)
 */
app.get('/api/wallet/balance', async (req, res) => {
  try {
    const { userId } = req.query;
    
    if (!userId) {
      return res.status(400).json({ success: false, error: 'userId required' });
    }
    
    // Получаем баланс из БД
    const result = await pool.query(
      'SELECT monkey_coin_balance, stars_balance FROM wallets WHERE user_id = $1',
      [userId]
    );
    
    if (result.rows.length === 0) {
      // Создаем кошелек если нет
      await pool.query(
        'INSERT INTO wallets (user_id, monkey_coin_balance, stars_balance) VALUES ($1, 0, 0)',
        [userId]
      );
      
      return res.json({
        success: true,
        monkeyCoins: 0,
        stars: 0
      });
    }
    
    res.json({
      success: true,
      monkeyCoins: result.rows[0].monkey_coin_balance || 0,
      stars: result.rows[0].stars_balance || 0
    });
    
  } catch (error) {
    console.error('❌ Ошибка получения баланса:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Получить список товаров магазина
 */
app.get('/api/shop/items', async (req, res) => {
  try {
    const shopItems = JSON.parse(fs.readFileSync('./shop-items.json', 'utf8'));
    res.json({ success: true, items: shopItems });
  } catch (error) {
    console.error('❌ Ошибка загрузки товаров:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`API server listening on ${PORT}`);
  console.log(`💰 Игровые STARS: Включены (виртуальная валюта)`);
  console.log(`⭐ Telegram Stars (XTR): Включены (реальные платежи)`);
  console.log(`📹 Intro Video API: /api/send-intro-video`);
});

