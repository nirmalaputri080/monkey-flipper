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
  'https://monkey-flipper-djm1.onrender.com',  // Render API (same-origin для admin)
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

// Раздача статических файлов (admin-stats.html и др.)
app.use(express.static(__dirname));

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
    
    // ==================== ТУРНИРЫ ====================
    // Таблица tournaments - турнирная система
    await pool.query(`
      CREATE TABLE IF NOT EXISTS tournaments (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        description TEXT,
        entry_fee_ton DECIMAL(20, 8) NOT NULL DEFAULT 0,
        prize_pool_ton DECIMAL(20, 8) NOT NULL DEFAULT 0,
        platform_fee_percent INTEGER NOT NULL DEFAULT 10,
        status VARCHAR(50) NOT NULL DEFAULT 'upcoming',
        start_time TIMESTAMP NOT NULL,
        end_time TIMESTAMP NOT NULL,
        max_participants INTEGER DEFAULT 100,
        current_participants INTEGER DEFAULT 0,
        prize_distribution JSONB NOT NULL DEFAULT '{"1": 50, "2": 30, "3": 20}'::jsonb,
        auto_renew_enabled BOOLEAN DEFAULT false,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_tournaments_status ON tournaments(status);
      CREATE INDEX IF NOT EXISTS idx_tournaments_end_time ON tournaments(end_time);
    `);

    // Таблица tournament_participants - участники турниров
    await pool.query(`
      CREATE TABLE IF NOT EXISTS tournament_participants (
        id SERIAL PRIMARY KEY,
        tournament_id INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
        user_id VARCHAR(255) NOT NULL,
        username VARCHAR(255) NOT NULL,
        best_score INTEGER DEFAULT 0,
        attempts INTEGER DEFAULT 0,
        paid_entry BOOLEAN DEFAULT false,
        auto_renew BOOLEAN DEFAULT false,
        joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_attempt_at TIMESTAMP,
        UNIQUE(tournament_id, user_id)
      );
      CREATE INDEX IF NOT EXISTS idx_tournament_participants_tournament ON tournament_participants(tournament_id);
      CREATE INDEX IF NOT EXISTS idx_tournament_participants_user ON tournament_participants(user_id);
      CREATE INDEX IF NOT EXISTS idx_tournament_participants_score ON tournament_participants(tournament_id, best_score DESC);
    `);

    // Таблица tournament_prizes - выплаченные призы
    await pool.query(`
      CREATE TABLE IF NOT EXISTS tournament_prizes (
        id SERIAL PRIMARY KEY,
        tournament_id INTEGER NOT NULL REFERENCES tournaments(id),
        user_id VARCHAR(255) NOT NULL,
        username VARCHAR(255) NOT NULL,
        place INTEGER NOT NULL,
        prize_ton DECIMAL(20, 8) NOT NULL,
        paid BOOLEAN DEFAULT false,
        paid_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_tournament_prizes_tournament ON tournament_prizes(tournament_id);
      CREATE INDEX IF NOT EXISTS idx_tournament_prizes_user ON tournament_prizes(user_id);
    `);

    // Таблица referrals - реферальная система
    await pool.query(`
      CREATE TABLE IF NOT EXISTS referrals (
        id SERIAL PRIMARY KEY,
        referrer_id VARCHAR(255) NOT NULL,
        referred_id VARCHAR(255) NOT NULL UNIQUE,
        referred_username VARCHAR(255),
        bonus_paid BOOLEAN DEFAULT FALSE,
        bonus_amount INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_referrals_referrer ON referrals(referrer_id);
      CREATE INDEX IF NOT EXISTS idx_referrals_referred ON referrals(referred_id);
    `);
    
    // Таблица daily_rewards - ежедневные награды
    await pool.query(`
      CREATE TABLE IF NOT EXISTS daily_rewards (
        id SERIAL PRIMARY KEY,
        user_id VARCHAR(255) NOT NULL,
        day_streak INTEGER DEFAULT 1,
        last_claim_date DATE NOT NULL,
        total_claimed INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id)
      );
      CREATE INDEX IF NOT EXISTS idx_daily_rewards_user ON daily_rewards(user_id);
    `);
    
    // Таблица achievements - достижения пользователей
    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_achievements (
        id SERIAL PRIMARY KEY,
        user_id VARCHAR(255) NOT NULL,
        achievement_id VARCHAR(50) NOT NULL,
        unlocked_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        claimed BOOLEAN DEFAULT FALSE,
        UNIQUE(user_id, achievement_id)
      );
      CREATE INDEX IF NOT EXISTS idx_achievements_user ON user_achievements(user_id);
    `);
    
    // Таблица возвращённых Stars транзакций
    await pool.query(`
      CREATE TABLE IF NOT EXISTS refunded_stars (
        id SERIAL PRIMARY KEY,
        transaction_id TEXT NOT NULL UNIQUE,
        user_id VARCHAR(255) NOT NULL,
        refunded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    
    console.log('✅ DB ready (all tables + achievements)');
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
    
    // Проверяем количество игр (для реферального бонуса)
    const gamesCountResult = await client.query(
      'SELECT COUNT(*) as count FROM player_scores WHERE user_id = $1',
      [userId]
    );
    const isFirstGame = parseInt(gamesCountResult.rows[0].count) === 0;
    
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
    
    // РЕФЕРАЛЬНЫЙ БОНУС: Проверяем есть ли невыплаченный бонус рефереру
    // Выплачиваем при первой игре ПОСЛЕ регистрации реферала (не при первой игре вообще)
    let referralBonusPaid = false;
    const refResult = await client.query(
      'SELECT id, referrer_id, bonus_paid, bonus_amount FROM referrals WHERE referred_id = $1 AND bonus_paid = false',
      [userId]
    );
    
    if (refResult.rows.length > 0) {
      const ref = refResult.rows[0];
      
      // Начисляем бонус рефереру
      await client.query(`
        INSERT INTO wallets (user_id, monkey_coin_balance)
        VALUES ($1, $2)
        ON CONFLICT (user_id)
        DO UPDATE SET 
          monkey_coin_balance = wallets.monkey_coin_balance + $2,
          updated_at = NOW()
      `, [ref.referrer_id, ref.bonus_amount]);
      
      // Отмечаем бонус как выплаченный
      await client.query(
        'UPDATE referrals SET bonus_paid = true WHERE id = $1',
        [ref.id]
      );
      
      referralBonusPaid = true;
      console.log(`💰 Referral bonus paid: ${ref.bonus_amount} to ${ref.referrer_id} (referred: ${userId})`);
    }
    
    await client.query('COMMIT');

    return res.json({ 
      success: true, 
      isNewRecord, 
      bestScore: Math.max(score, previousBest),
      coinsEarned,
      newBalance,
      referralBonusPaid
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

// ==================== PLAYER STATS ENDPOINT ====================

// Получить полную статистику игрока
app.get('/api/stats/:userId', async (req, res) => {
  const { userId } = req.params;
  
  if (!userId) {
    return res.status(400).json({ success: false, error: 'userId required' });
  }

  try {
    // Статистика по играм
    const gamesStats = await pool.query(`
      SELECT 
        COUNT(*) as total_games,
        COALESCE(MAX(score), 0) as best_score,
        COALESCE(AVG(score)::int, 0) as avg_score,
        COALESCE(SUM(score), 0) as total_score,
        MIN(timestamp) as first_game,
        MAX(timestamp) as last_game
      FROM player_scores 
      WHERE user_id = $1
    `, [userId]);

    // Статистика по дуэлям
    const duelsStats = await pool.query(`
      SELECT 
        COUNT(*) FILTER (WHERE status = 'completed') as total_duels,
        COUNT(*) FILTER (WHERE winner = $1) as duels_won,
        COUNT(*) FILTER (WHERE status = 'completed' AND winner != $1 AND winner IS NOT NULL) as duels_lost
      FROM duels 
      WHERE player1_id = $1 OR player2_id = $1
    `, [userId]);

    // Баланс кошелька
    const walletData = await pool.query(`
      SELECT monkey_coin_balance, stars_balance, ton_balance
      FROM wallets 
      WHERE user_id = $1
    `, [userId]);

    // Количество покупок
    const purchasesData = await pool.query(`
      SELECT COUNT(*) as total_purchases
      FROM purchases 
      WHERE user_id = $1
    `, [userId]);

    // Позиция в рейтинге
    const rankData = await pool.query(`
      WITH best_scores AS (
        SELECT DISTINCT ON (user_id) user_id, score
        FROM player_scores
        ORDER BY user_id, score DESC
      ),
      ranked AS (
        SELECT user_id, score, RANK() OVER (ORDER BY score DESC) as rank
        FROM best_scores
      )
      SELECT rank, score FROM ranked WHERE user_id = $1
    `, [userId]);

    const games = gamesStats.rows[0];
    const duels = duelsStats.rows[0];
    const wallet = walletData.rows[0] || { monkey_coin_balance: 0, stars_balance: 0, ton_balance: 0 };
    const purchases = purchasesData.rows[0];
    const rank = rankData.rows[0] || { rank: '-', score: 0 };

    return res.json({
      success: true,
      stats: {
        // Игры
        totalGames: parseInt(games.total_games) || 0,
        bestScore: parseInt(games.best_score) || 0,
        avgScore: parseInt(games.avg_score) || 0,
        totalScore: parseInt(games.total_score) || 0,
        firstGame: games.first_game,
        lastGame: games.last_game,
        
        // Дуэли
        totalDuels: parseInt(duels.total_duels) || 0,
        duelsWon: parseInt(duels.duels_won) || 0,
        duelsLost: parseInt(duels.duels_lost) || 0,
        winRate: duels.total_duels > 0 
          ? Math.round((duels.duels_won / duels.total_duels) * 100) 
          : 0,
        
        // Кошелёк
        monkeyCoins: parseInt(wallet.monkey_coin_balance) || 0,
        stars: parseFloat(wallet.stars_balance) || 0,
        ton: parseFloat(wallet.ton_balance) || 0,
        
        // Прочее
        totalPurchases: parseInt(purchases.total_purchases) || 0,
        rank: rank.rank,
        rankScore: parseInt(rank.score) || 0
      }
    });
  } catch (err) {
    console.error('Stats error:', err);
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

// Получить баланс кошелька (переименован чтобы не конфликтовал с /api/wallet/ton-info)
app.get('/api/wallet/balance/:userId', async (req, res) => {
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

// Обратная совместимость - старый путь (должен быть после всех /api/wallet/* путей)
// Перемещён в конец файла

// ==================== TON CONNECT ENDPOINTS ====================

// Подключить TON кошелек
app.post('/api/wallet/connect-ton', async (req, res) => {
  const { userId, walletAddress } = req.body;
  
  console.log('🔗 Connect TON request:', { userId, walletAddress });
  
  if (!userId || !walletAddress) {
    return res.status(400).json({ success: false, error: 'userId and walletAddress required' });
  }

  // Валидация адреса TON - поддерживаем разные форматы:
  // 1. User-friendly: EQ... или UQ... (48 символов)
  // 2. Raw: 0:... (66 символов с префиксом)
  // 3. Raw hex без префикса (64 символа)
  const isUserFriendly = /^(EQ|UQ)[a-zA-Z0-9_-]{46}$/.test(walletAddress);
  const isRawWithPrefix = /^0:[a-fA-F0-9]{64}$/.test(walletAddress);
  const isRawHex = /^[a-fA-F0-9]{64}$/.test(walletAddress);
  
  if (!isUserFriendly && !isRawWithPrefix && !isRawHex) {
    console.log('❌ Invalid TON address format:', walletAddress);
    return res.status(400).json({ success: false, error: 'Invalid TON wallet address format' });
  }

  try {
    // Проверяем не привязан ли уже этот адрес к другому пользователю
    const existingWallet = await pool.query(
      'SELECT user_id FROM wallets WHERE wallet_address = $1 AND user_id != $2',
      [walletAddress, userId]
    );

    if (existingWallet.rows.length > 0) {
      return res.status(400).json({ 
        success: false, 
        error: 'This wallet is already connected to another account' 
      });
    }

    // Создаем или обновляем кошелек
    await pool.query(`
      INSERT INTO wallets (user_id, wallet_address, monkey_coin_balance, stars_balance, ton_balance)
      VALUES ($1, $2, 0, 0, 0)
      ON CONFLICT (user_id)
      DO UPDATE SET 
        wallet_address = $2,
        updated_at = NOW()
    `, [userId, walletAddress]);

    // Записываем в audit_log
    await pool.query(`
      INSERT INTO audit_log (user_id, event_type, metadata)
      VALUES ($1, 'ton_wallet_connected', $2)
    `, [userId, JSON.stringify({ walletAddress })]);

    console.log(`✅ TON wallet connected: ${userId} -> ${walletAddress}`);

    return res.json({
      success: true,
      message: 'TON wallet connected successfully',
      walletAddress
    });
  } catch (err) {
    console.error('Connect TON wallet error:', err);
    return res.status(500).json({ success: false, error: 'DB error' });
  }
});

// Отключить TON кошелек
app.post('/api/wallet/disconnect-ton', async (req, res) => {
  const { userId } = req.body;
  
  if (!userId) {
    return res.status(400).json({ success: false, error: 'userId required' });
  }

  try {
    // Получаем текущий адрес для лога
    const current = await pool.query(
      'SELECT wallet_address FROM wallets WHERE user_id = $1',
      [userId]
    );

    const oldAddress = current.rows[0]?.wallet_address;

    // Удаляем адрес кошелька
    await pool.query(`
      UPDATE wallets 
      SET wallet_address = NULL, updated_at = NOW()
      WHERE user_id = $1
    `, [userId]);

    // Записываем в audit_log
    if (oldAddress) {
      await pool.query(`
        INSERT INTO audit_log (user_id, event_type, metadata)
        VALUES ($1, 'ton_wallet_disconnected', $2)
      `, [userId, JSON.stringify({ oldAddress })]);
    }

    console.log(`🔌 TON wallet disconnected: ${userId}`);

    return res.json({
      success: true,
      message: 'TON wallet disconnected'
    });
  } catch (err) {
    console.error('Disconnect TON wallet error:', err);
    return res.status(500).json({ success: false, error: 'DB error' });
  }
});

// Получить информацию о подключенном TON кошельке
app.get('/api/wallet/ton-info/:userId', async (req, res) => {
  const { userId } = req.params;

  try {
    const result = await pool.query(
      'SELECT wallet_address, ton_balance FROM wallets WHERE user_id = $1',
      [userId]
    );

    if (result.rows.length === 0 || !result.rows[0].wallet_address) {
      return res.json({
        success: true,
        connected: false,
        wallet: null
      });
    }

    const wallet = result.rows[0];
    
    // Форматируем адрес для отображения (первые 4 и последние 4 символа)
    const shortAddress = wallet.wallet_address 
      ? `${wallet.wallet_address.slice(0, 6)}...${wallet.wallet_address.slice(-4)}`
      : null;

    return res.json({
      success: true,
      connected: true,
      wallet: {
        address: wallet.wallet_address,
        shortAddress,
        tonBalance: parseFloat(wallet.ton_balance) || 0
      }
    });
  } catch (err) {
    console.error('Get TON info error:', err);
    return res.status(500).json({ success: false, error: 'DB error' });
  }
});

// ==================== END TON CONNECT ====================

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

// Получить купленные товары пользователя (только активные за последние 24 часа)
app.get('/api/shop/purchases/:userId', async (req, res) => {
  const { userId } = req.params;
  
  try {
    // Показываем только покупки за последние 24 часа
    // ВАЖНО: Показываем и 'active' и 'equipped' предметы (но НЕ 'used')
    const result = await pool.query(`
      SELECT 
        item_id, 
        item_name, 
        MIN(price) as price, 
        COUNT(*) FILTER (WHERE status = 'active') as count,
        COUNT(*) FILTER (WHERE status = 'equipped') as equipped_count,
        MAX(purchased_at) as purchased_at,
        MAX(purchased_at) + INTERVAL '24 hours' as expires_at
      FROM purchases
      WHERE user_id = $1 
        AND status IN ('active', 'equipped')
        AND purchased_at > NOW() - INTERVAL '24 hours'
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
    console.log(`   Invoice result:`, invoice, typeof invoice);
    
    res.json({
      success: true,
      invoice: invoice,
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

// ==================== TON PAYMENT ====================

// Адрес кошелька для приема TON платежей (настройте в .env)
const TON_WALLET_ADDRESS = process.env.TON_WALLET_ADDRESS || 'UQD-example-wallet-address';

/**
 * Создать данные для TON транзакции
 * POST /api/shop/create-ton-transaction
 */
app.post('/api/shop/create-ton-transaction', validateShopAuth, async (req, res) => {
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
    
    if (!item.priceTON) {
      return res.status(400).json({ 
        success: false, 
        error: 'Этот товар нельзя купить за TON' 
      });
    }
    
    // Создаем уникальный ID транзакции
    const txUuid = crypto.randomUUID();
    const transactionId = `ton_${userId}_${itemId}_${Date.now()}`;
    
    // Сохраняем pending транзакцию в БД
    await pool.query(`
      INSERT INTO transactions (id, user_id, type, amount, currency, status, nonce, created_at)
      VALUES ($1, $2, 'ton_purchase', $3, 'TON', 'pending', $4, NOW())
    `, [txUuid, userId, item.priceTON, transactionId]);
    
    // Формируем данные для TON Connect транзакции
    const amountNano = Math.floor(item.priceTON * 1e9).toString(); // TON в nanoTON (строка)
    
    const transaction = {
      validUntil: Math.floor(Date.now() / 1000) + 600, // 10 минут на оплату
      messages: [
        {
          address: TON_WALLET_ADDRESS,
          amount: amountNano
        }
      ]
    };
    
    console.log(`✅ TON транзакция создана:`, JSON.stringify(transaction));
    console.log(`   Item: ${item.name}, Price: ${item.priceTON} TON, Wallet: ${TON_WALLET_ADDRESS}`);
    
    res.json({
      success: true,
      transaction,
      transactionId,
      txUuid,
      item: {
        id: item.id,
        name: item.name,
        price: item.priceTON,
        currency: 'TON'
      }
    });
    
  } catch (error) {
    console.error('❌ Ошибка создания TON транзакции:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

/**
 * Подтвердить TON платеж (вызывается после успешной транзакции)
 * POST /api/shop/confirm-ton-payment
 */
app.post('/api/shop/confirm-ton-payment', validateShopAuth, async (req, res) => {
  try {
    const { userId, transactionId, txHash } = req.body;
    
    if (!userId || !transactionId) {
      return res.status(400).json({ 
        success: false, 
        error: 'userId и transactionId обязательны' 
      });
    }
    
    // Находим pending транзакцию по nonce (там хранится transactionId)
    const txResult = await pool.query(
      'SELECT * FROM transactions WHERE nonce = $1 AND user_id = $2 AND status = $3',
      [transactionId, userId, 'pending']
    );
    
    if (txResult.rows.length === 0) {
      return res.status(404).json({ 
        success: false, 
        error: 'Транзакция не найдена или уже обработана' 
      });
    }
    
    const tx = txResult.rows[0];
    
    // Извлекаем itemId из transactionId (формат: ton_userId_itemId_timestamp)
    const parts = transactionId.split('_');
    const itemId = parts[2];
    
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
    
    // Обновляем транзакцию как completed
    await pool.query(
      'UPDATE transactions SET status = $1, updated_at = NOW() WHERE id = $2',
      ['completed', tx.id]
    );
    
    // Создаем запись о покупке
    const purchaseId = crypto.randomUUID();
    await pool.query(`
      INSERT INTO purchases (id, user_id, item_id, item_name, price, currency, status, purchased_at)
      VALUES ($1, $2, $3, $4, $5, 'TON', 'active', NOW())
    `, [purchaseId, userId, itemId, item.name, tx.amount]);
    
    console.log(`✅ TON покупка подтверждена: user ${userId}, item ${itemId}, txHash: ${txHash || 'N/A'}`);
    
    res.json({
      success: true,
      purchase: {
        id: purchaseId,
        itemId,
        itemName: item.name,
        price: tx.amount,
        currency: 'TON'
      }
    });
    
  } catch (error) {
    console.error('❌ Ошибка подтверждения TON платежа:', error);
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

// ==================== TON CONNECT MANIFEST ====================
// Манифест для TON Connect - позволяет подключать TON кошельки
app.get('/tonconnect-manifest.json', (req, res) => {
  const manifest = {
    url: "https://monkey-flipper-djm1.onrender.com",
    name: "Monkey Flipper",
    iconUrl: "https://monkey-flipper-djm1.onrender.com/assets/icon-512.png"
  };
  
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.json(manifest);
});

// ==================== REFERRAL SYSTEM ====================
// Константы реферальной системы
const REFERRAL_BONUS_REFERRER = 500;  // Бонус пригласившему
const REFERRAL_BONUS_REFERRED = 200;  // Бонус приглашённому

// Получить реферальную статистику пользователя
app.get('/api/referral/stats/:userId', async (req, res) => {
  const { userId } = req.params;
  
  try {
    // Получаем количество приглашённых и общий бонус
    const referralsResult = await pool.query(`
      SELECT 
        COUNT(*) as total_referrals,
        COUNT(CASE WHEN bonus_paid = true THEN 1 END) as paid_referrals,
        COALESCE(SUM(CASE WHEN bonus_paid = true THEN bonus_amount ELSE 0 END), 0) as total_earned
      FROM referrals 
      WHERE referrer_id = $1
    `, [userId]);
    
    // Получаем список последних приглашённых
    const recentResult = await pool.query(`
      SELECT referred_username, bonus_paid, bonus_amount, created_at
      FROM referrals 
      WHERE referrer_id = $1
      ORDER BY created_at DESC
      LIMIT 20
    `, [userId]);
    
    const stats = referralsResult.rows[0];
    
    res.json({
      success: true,
      stats: {
        totalReferrals: parseInt(stats.total_referrals) || 0,
        paidReferrals: parseInt(stats.paid_referrals) || 0,
        totalEarned: parseInt(stats.total_earned) || 0,
        bonusPerReferral: REFERRAL_BONUS_REFERRER
      },
      referrals: recentResult.rows.map(r => ({
        username: r.referred_username || 'Anonymous',
        bonusPaid: r.bonus_paid,
        bonusAmount: r.bonus_amount,
        date: r.created_at
      }))
    });
  } catch (err) {
    console.error('Referral stats error:', err);
    res.status(500).json({ success: false, error: 'DB error' });
  }
});

// Применить реферальный код (вызывается при первом входе)
app.post('/api/referral/apply', async (req, res) => {
  const { referrerId, referredId, referredUsername } = req.body;
  
  if (!referrerId || !referredId) {
    return res.status(400).json({ success: false, error: 'referrerId and referredId required' });
  }
  
  // === ЗАЩИТА ОТ НАКРУТКИ ===
  
  // 1. Нельзя пригласить самого себя
  if (String(referrerId) === String(referredId)) {
    console.log(`⚠️ Referral blocked: self-referral attempt ${referrerId}`);
    return res.json({ success: false, error: 'Cannot refer yourself' });
  }
  
  // 2. Проверяем что ID похожи на настоящие Telegram ID (числа)
  if (!/^\d+$/.test(String(referrerId)) || !/^\d+$/.test(String(referredId))) {
    console.log(`⚠️ Referral blocked: invalid ID format`);
    return res.json({ success: false, error: 'Invalid user ID format' });
  }
  
  try {
    // 3. Проверяем, не был ли уже приглашён этот пользователь
    const existingRef = await pool.query(
      'SELECT id FROM referrals WHERE referred_id = $1',
      [referredId]
    );
    
    if (existingRef.rows.length > 0) {
      console.log(`⚠️ Referral blocked: ${referredId} already referred`);
      return res.json({ success: false, error: 'User already referred', alreadyReferred: true });
    }
    
    // 4. Проверяем существует ли реферер в системе (должен был хоть раз сыграть)
    const referrerExists = await pool.query(
      'SELECT telegram_id FROM users WHERE telegram_id = $1',
      [referrerId]
    );
    
    if (referrerExists.rows.length === 0) {
      console.log(`⚠️ Referral blocked: referrer ${referrerId} not found`);
      return res.json({ success: false, error: 'Referrer not found' });
    }
    
    // 5. Проверяем не приглашал ли реферер слишком много людей за последний час (анти-спам)
    const recentReferrals = await pool.query(`
      SELECT COUNT(*) as count FROM referrals 
      WHERE referrer_id = $1 AND created_at > NOW() - INTERVAL '1 hour'
    `, [referrerId]);
    
    if (parseInt(recentReferrals.rows[0].count) >= 10) {
      console.log(`⚠️ Referral blocked: ${referrerId} too many referrals in last hour`);
      return res.json({ success: false, error: 'Too many referrals, try again later' });
    }
    
    // 6. Проверяем не является ли приглашённый реферером того кто его приглашает (циклическая ссылка)
    const reverseRef = await pool.query(
      'SELECT id FROM referrals WHERE referrer_id = $1 AND referred_id = $2',
      [referredId, referrerId]
    );
    
    if (reverseRef.rows.length > 0) {
      console.log(`⚠️ Referral blocked: circular referral ${referrerId} <-> ${referredId}`);
      return res.json({ success: false, error: 'Circular referral not allowed' });
    }
    
    // 7. Проверяем что приглашённый - новый пользователь (не играл раньше)
    const existingPlayer = await pool.query(
      'SELECT user_id FROM player_scores WHERE user_id = $1',
      [referredId]
    );
    
    if (existingPlayer.rows.length > 0) {
      console.log(`⚠️ Referral blocked: ${referredId} already played before`);
      return res.json({ success: false, error: 'User already exists in system' });
    }
    
    // === ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ ===
    
    // Создаём реферальную связь
    await pool.query(`
      INSERT INTO referrals (referrer_id, referred_id, referred_username, bonus_paid, bonus_amount, created_at)
      VALUES ($1, $2, $3, false, $4, NOW())
    `, [referrerId, referredId, referredUsername || 'Anonymous', REFERRAL_BONUS_REFERRER]);
    
    // Начисляем бонус приглашённому сразу
    await pool.query(`
      INSERT INTO wallets (user_id, monkey_coin_balance)
      VALUES ($1, $2)
      ON CONFLICT (user_id)
      DO UPDATE SET 
        monkey_coin_balance = wallets.monkey_coin_balance + $2,
        updated_at = NOW()
    `, [referredId, REFERRAL_BONUS_REFERRED]);
    
    // Логируем
    await logAudit('referral_applied', referredId, {
      referrerId,
      bonusReceived: REFERRAL_BONUS_REFERRED
    });
    
    console.log(`🎁 Referral applied: ${referrerId} invited ${referredId}`);
    
    res.json({
      success: true,
      message: 'Referral applied successfully',
      bonusReceived: REFERRAL_BONUS_REFERRED
    });
  } catch (err) {
    console.error('Apply referral error:', err);
    res.status(500).json({ success: false, error: 'DB error' });
  }
});

// Выплатить бонус рефереру (когда приглашённый совершает первую игру)
app.post('/api/referral/claim-bonus', async (req, res) => {
  const { referredId } = req.body;
  
  if (!referredId) {
    return res.status(400).json({ success: false, error: 'referredId required' });
  }
  
  try {
    // Находим реферальную запись
    const refResult = await pool.query(
      'SELECT id, referrer_id, bonus_paid, bonus_amount FROM referrals WHERE referred_id = $1',
      [referredId]
    );
    
    if (refResult.rows.length === 0) {
      return res.json({ success: false, error: 'No referral found' });
    }
    
    const ref = refResult.rows[0];
    
    if (ref.bonus_paid) {
      return res.json({ success: false, error: 'Bonus already paid', alreadyPaid: true });
    }
    
    // Начисляем бонус рефереру
    await pool.query(`
      INSERT INTO wallets (user_id, monkey_coin_balance)
      VALUES ($1, $2)
      ON CONFLICT (user_id)
      DO UPDATE SET 
        monkey_coin_balance = wallets.monkey_coin_balance + $2,
        updated_at = NOW()
    `, [ref.referrer_id, ref.bonus_amount]);
    
    // Отмечаем бонус как выплаченный
    await pool.query(
      'UPDATE referrals SET bonus_paid = true WHERE id = $1',
      [ref.id]
    );
    
    // Логируем
    await logAudit('referral_bonus_paid', ref.referrer_id, {
      referredId,
      bonusAmount: ref.bonus_amount
    });
    
    console.log(`💰 Referral bonus paid: ${ref.bonus_amount} to ${ref.referrer_id}`);
    
    res.json({
      success: true,
      referrerId: ref.referrer_id,
      bonusPaid: ref.bonus_amount
    });
  } catch (err) {
    console.error('Claim referral bonus error:', err);
    res.status(500).json({ success: false, error: 'DB error' });
  }
});

// ==================== END REFERRAL SYSTEM ====================

// ==================== TOURNAMENT SYSTEM ====================

// Получить список активных турниров
app.get('/api/tournaments/active', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        t.*,
        COALESCE(COUNT(tp.id), 0) as current_participants,
        EXTRACT(EPOCH FROM (t.end_time - NOW())) as seconds_until_end
      FROM tournaments t
      LEFT JOIN tournament_participants tp ON t.id = tp.tournament_id
      WHERE t.status IN ('upcoming', 'active')
        AND t.end_time > NOW()
      GROUP BY t.id
      ORDER BY t.start_time ASC
    `);

    res.json({
      success: true,
      tournaments: result.rows.map(t => ({
        ...t,
        timeRemaining: Math.max(0, t.seconds_until_end),
        isFull: t.current_participants >= t.max_participants,
        prizeDistribution: t.prize_distribution
      }))
    });
  } catch (err) {
    console.error('Get tournaments error:', err);
    res.status(500).json({ success: false, error: 'DB error' });
  }
});

// Получить детали турнира с лидербордом
app.get('/api/tournaments/:tournamentId', async (req, res) => {
  const { tournamentId } = req.params;
  
  try {
    // Получаем турнир
    const tournament = await pool.query(
      'SELECT * FROM tournaments WHERE id = $1',
      [tournamentId]
    );
    
    if (tournament.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Tournament not found' });
    }
    
    // Получаем топ участников
    const leaderboard = await pool.query(`
      SELECT 
        user_id,
        username,
        best_score,
        attempts,
        joined_at
      FROM tournament_participants
      WHERE tournament_id = $1
      ORDER BY best_score DESC, joined_at ASC
      LIMIT 100
    `, [tournamentId]);
    
    res.json({
      success: true,
      tournament: tournament.rows[0],
      leaderboard: leaderboard.rows
    });
  } catch (err) {
    console.error('Get tournament details error:', err);
    res.status(500).json({ success: false, error: 'DB error' });
  }
});

// Вступить в турнир
app.post('/api/tournaments/:tournamentId/join', async (req, res) => {
  const { tournamentId } = req.params;
  const { userId, username, autoRenew } = req.body;
  
  if (!userId || !username) {
    return res.status(400).json({ success: false, error: 'userId and username required' });
  }
  
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    // Получаем турнир с блокировкой
    const tournament = await client.query(
      'SELECT * FROM tournaments WHERE id = $1 FOR UPDATE',
      [tournamentId]
    );
    
    if (tournament.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, error: 'Турнир не найден' });
    }
    
    const t = tournament.rows[0];
    
    // Проверки
    if (t.status === 'finished') {
      await client.query('ROLLBACK');
      return res.json({ success: false, error: 'Турнир уже завершен' });
    }
    
    if (new Date() > new Date(t.end_time)) {
      await client.query('ROLLBACK');
      return res.json({ success: false, error: 'Время турнира истекло' });
    }
    
    // Проверяем лимит участников
    const participantCount = await client.query(
      'SELECT COUNT(*) as count FROM tournament_participants WHERE tournament_id = $1',
      [tournamentId]
    );
    
    if (t.max_participants && participantCount.rows[0].count >= t.max_participants) {
      await client.query('ROLLBACK');
      return res.json({ success: false, error: 'Турнир заполнен! Все места заняты' });
    }
    
    // Проверяем не вступил ли уже
    const existing = await client.query(
      'SELECT id FROM tournament_participants WHERE tournament_id = $1 AND user_id = $2',
      [tournamentId, userId]
    );
    
    if (existing.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.json({ success: false, error: 'Вы уже участвуете в этом турнире!', alreadyJoined: true });
    }
    
    // Проверяем баланс TON (если требуется вступительный взнос)
    if (parseFloat(t.entry_fee_ton) > 0) {
      const wallet = await client.query(
        'SELECT ton_balance FROM wallets WHERE user_id = $1',
        [userId]
      );
      
      // Проверяем наличие кошелька
      if (wallet.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.json({ 
          success: false, 
          error: 'У вас нет TON кошелька! Подключите кошелек в профиле',
          needWallet: true
        });
      }
      
      const userBalance = parseFloat(wallet.rows[0].ton_balance);
      const entryFee = parseFloat(t.entry_fee_ton);
      
      if (userBalance < entryFee) {
        await client.query('ROLLBACK');
        return res.json({ 
          success: false, 
          error: `Недостаточно TON! Нужно ${entryFee.toFixed(2)} TON, у вас ${userBalance.toFixed(2)} TON`,
          needTopUp: true,
          required: entryFee,
          current: userBalance
        });
      }
      
      // Списываем вступительный взнос
      await client.query(`
        UPDATE wallets 
        SET ton_balance = ton_balance - $1,
            updated_at = NOW()
        WHERE user_id = $2
      `, [t.entry_fee_ton, userId]);
      
      // Увеличиваем призовой фонд
      const platformFee = parseFloat(t.entry_fee_ton) * (t.platform_fee_percent / 100);
      const toPrizePool = parseFloat(t.entry_fee_ton) - platformFee;
      
      await client.query(`
        UPDATE tournaments 
        SET prize_pool_ton = prize_pool_ton + $1,
            updated_at = NOW()
        WHERE id = $2
      `, [toPrizePool, tournamentId]);
    }
    
    // Добавляем участника
    await client.query(`
      INSERT INTO tournament_participants 
        (tournament_id, user_id, username, auto_renew, paid_entry)
      VALUES ($1, $2, $3, $4, $5)
    `, [tournamentId, userId, username, autoRenew || false, parseFloat(t.entry_fee_ton) > 0]);
    
    // ВАЖНО: Обновляем счетчик участников
    await client.query(`
      UPDATE tournaments 
      SET current_participants = current_participants + 1,
          updated_at = NOW()
      WHERE id = $1
    `, [tournamentId]);
    
    // Логируем
    await logAudit('tournament_joined', userId, {
      tournamentId,
      entryFee: t.entry_fee_ton,
      autoRenew: autoRenew || false
    });
    
    await client.query('COMMIT');
    
    console.log(`🏆 User ${userId} joined tournament ${tournamentId}`);
    
    res.json({
      success: true,
      message: 'Вы успешно вступили в турнир!',
      entryFeePaid: t.entry_fee_ton
    });
    
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Join tournament error:', err);
    res.status(500).json({ success: false, error: 'Ошибка сервера. Попробуйте позже' });
  } finally {
    client.release();
  }
});

// Отправить результат в турнире
app.post('/api/tournaments/:tournamentId/submit-score', async (req, res) => {
  const { tournamentId } = req.params;
  const { userId, score } = req.body;
  
  if (!userId || score === undefined) {
    return res.status(400).json({ success: false, error: 'userId and score required' });
  }
  
  try {
    // Проверяем что турнир активен
    const tournament = await pool.query(
      'SELECT * FROM tournaments WHERE id = $1 AND status = $2 AND end_time > NOW()',
      [tournamentId, 'active']
    );
    
    if (tournament.rows.length === 0) {
      return res.json({ success: false, error: 'Турнир неактивен или завершен' });
    }
    
    // Проверяем что пользователь участвует
    const participant = await pool.query(
      'SELECT * FROM tournament_participants WHERE tournament_id = $1 AND user_id = $2',
      [tournamentId, userId]
    );
    
    if (participant.rows.length === 0) {
      return res.json({ success: false, error: 'Вы не участник этого турнира' });
    }
    
    // Обновляем лучший результат если новый лучше
    const currentBest = participant.rows[0].best_score || 0;
    const newScore = parseInt(score);
    
    if (newScore > currentBest) {
      await pool.query(`
        UPDATE tournament_participants 
        SET best_score = $1,
            attempts = attempts + 1,
            last_attempt_at = NOW()
        WHERE tournament_id = $2 AND user_id = $3
      `, [newScore, tournamentId, userId]);
      
      console.log(`🎯 New tournament best: ${userId} - ${newScore} in tournament ${tournamentId}`);
      
      res.json({
        success: true,
        newBest: true,
        score: newScore,
        previousBest: currentBest
      });
    } else {
      await pool.query(`
        UPDATE tournament_participants 
        SET attempts = attempts + 1,
            last_attempt_at = NOW()
        WHERE tournament_id = $2 AND user_id = $3
      `, [tournamentId, userId]);
      
      res.json({
        success: true,
        newBest: false,
        score: newScore,
        best: currentBest
      });
    }
    
  } catch (err) {
    console.error('Submit tournament score error:', err);
    res.status(500).json({ success: false, error: 'Ошибка сервера. Попробуйте позже' });
  }
});

// Завершить турнир и распределить призы (вызывается крон-задачей или вручную)
app.post('/api/tournaments/:tournamentId/finalize', async (req, res) => {
  const { tournamentId } = req.params;
  const { adminKey } = req.body;
  
  // Простая защита (в проде использовать proper auth)
  if (adminKey !== process.env.ADMIN_KEY) {
    return res.status(403).json({ success: false, error: 'Unauthorized' });
  }
  
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    // Получаем турнир
    const tournament = await client.query(
      'SELECT * FROM tournaments WHERE id = $1 FOR UPDATE',
      [tournamentId]
    );
    
    if (tournament.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, error: 'Tournament not found' });
    }
    
    const t = tournament.rows[0];
    
    if (t.status === 'finished') {
      await client.query('ROLLBACK');
      return res.json({ success: false, error: 'Already finalized' });
    }
    
    // Получаем топ участников
    const winners = await client.query(`
      SELECT user_id, username, best_score
      FROM tournament_participants
      WHERE tournament_id = $1
      ORDER BY best_score DESC, joined_at ASC
      LIMIT 10
    `, [tournamentId]);
    
    if (winners.rows.length === 0) {
      // Нет участников - просто закрываем турнир
      await client.query(
        "UPDATE tournaments SET status = 'finished', updated_at = NOW() WHERE id = $1",
        [tournamentId]
      );
      await client.query('COMMIT');
      return res.json({ success: true, message: 'No participants, tournament closed' });
    }
    
    // Распределяем призы по prize_distribution
    const prizeDistribution = t.prize_distribution;
    const totalPrizePool = parseFloat(t.prize_pool_ton);
    const prizes = [];
    
    Object.keys(prizeDistribution).forEach((place) => {
      const placeNum = parseInt(place);
      if (placeNum <= winners.rows.length) {
        const percent = prizeDistribution[place];
        const prizeAmount = (totalPrizePool * percent) / 100;
        prizes.push({
          place: placeNum,
          userId: winners.rows[placeNum - 1].user_id,
          username: winners.rows[placeNum - 1].username,
          amount: prizeAmount
        });
      }
    });
    
    // Выплачиваем призы
    for (const prize of prizes) {
      // Начисляем TON победителю
      await client.query(`
        INSERT INTO wallets (user_id, ton_balance)
        VALUES ($1, $2)
        ON CONFLICT (user_id)
        DO UPDATE SET 
          ton_balance = wallets.ton_balance + $2,
          updated_at = NOW()
      `, [prize.userId, prize.amount]);
      
      // Записываем приз
      await client.query(`
        INSERT INTO tournament_prizes 
          (tournament_id, user_id, username, place, prize_ton, paid, paid_at)
        VALUES ($1, $2, $3, $4, $5, true, NOW())
      `, [tournamentId, prize.userId, prize.username, prize.place, prize.amount]);
      
      // Логируем
      await logAudit('tournament_prize_paid', prize.userId, {
        tournamentId,
        place: prize.place,
        prizeTon: prize.amount
      });
      
      console.log(`💰 Prize paid: ${prize.username} (place ${prize.place}) - ${prize.amount} TON`);
    }
    
    // Обновляем статус турнира
    await client.query(
      "UPDATE tournaments SET status = 'finished', updated_at = NOW() WHERE id = $1",
      [tournamentId]
    );
    
    await client.query('COMMIT');
    
    console.log(`🏁 Tournament ${tournamentId} finalized, ${prizes.length} prizes paid`);
    
    res.json({
      success: true,
      message: 'Tournament finalized',
      prizesPaid: prizes
    });
    
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Finalize tournament error:', err);
    res.status(500).json({ success: false, error: 'DB error' });
  } finally {
    client.release();
  }
});

// Получить мои турниры
app.get('/api/tournaments/my/:userId', async (req, res) => {
  const { userId } = req.params;
  
  try {
    const result = await pool.query(`
      SELECT 
        t.*,
        tp.best_score,
        tp.attempts,
        tp.auto_renew,
        tp.joined_at,
        (
          SELECT COUNT(*) + 1
          FROM tournament_participants tp2
          WHERE tp2.tournament_id = t.id
            AND tp2.best_score > tp.best_score
        ) as current_place
      FROM tournaments t
      INNER JOIN tournament_participants tp ON t.id = tp.tournament_id
      WHERE tp.user_id = $1
      ORDER BY t.end_time DESC
      LIMIT 20
    `, [userId]);
    
    res.json({
      success: true,
      tournaments: result.rows
    });
  } catch (err) {
    console.error('Get my tournaments error:', err);
    res.status(500).json({ success: false, error: 'DB error' });
  }
});

// ==================== END TOURNAMENT SYSTEM ====================

// ==================== DAILY REWARDS SYSTEM ====================
// Награды по дням (прогрессивная система)
const DAILY_REWARDS = [
  { day: 1, coins: 50, bonus: null },
  { day: 2, coins: 75, bonus: null },
  { day: 3, coins: 100, bonus: null },
  { day: 4, coins: 150, bonus: null },
  { day: 5, coins: 200, bonus: null },
  { day: 6, coins: 300, bonus: null },
  { day: 7, coins: 500, bonus: '🎁 Недельный бонус!' },
  // После 7 дней цикл повторяется с множителем
];

// Получить статус ежедневной награды
app.get('/api/daily-reward/status/:userId', async (req, res) => {
  const { userId } = req.params;
  
  try {
    const result = await pool.query(
      'SELECT day_streak, last_claim_date, total_claimed FROM daily_rewards WHERE user_id = $1',
      [userId]
    );
    
    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    
    if (result.rows.length === 0) {
      // Новый пользователь - может забрать награду
      return res.json({
        success: true,
        canClaim: true,
        currentStreak: 0,
        nextReward: DAILY_REWARDS[0],
        rewards: DAILY_REWARDS,
        totalClaimed: 0
      });
    }
    
    const data = result.rows[0];
    const lastClaim = data.last_claim_date.toISOString().split('T')[0];
    const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
    
    // Проверяем можно ли забрать награду сегодня
    const canClaim = lastClaim !== today;
    
    // Проверяем streak - если пропустил день, сбрасываем
    let currentStreak = data.day_streak;
    if (lastClaim !== today && lastClaim !== yesterday) {
      // Пропустил день - streak сбросится при следующем claim
      currentStreak = 0;
    }
    
    // Следующая награда (циклично по 7 дням)
    const nextDay = canClaim ? (currentStreak % 7) : ((currentStreak % 7) + 1) % 7;
    const nextReward = DAILY_REWARDS[nextDay];
    
    // Добавляем множитель за каждую полную неделю
    const weekMultiplier = Math.floor(currentStreak / 7) + 1;
    const adjustedReward = {
      ...nextReward,
      coins: nextReward.coins * weekMultiplier,
      multiplier: weekMultiplier > 1 ? `x${weekMultiplier}` : null
    };
    
    return res.json({
      success: true,
      canClaim,
      currentStreak,
      nextReward: adjustedReward,
      rewards: DAILY_REWARDS.map((r, i) => ({
        ...r,
        coins: r.coins * weekMultiplier,
        completed: i < (currentStreak % 7),
        current: i === (currentStreak % 7)
      })),
      totalClaimed: data.total_claimed,
      lastClaimDate: lastClaim
    });
  } catch (err) {
    console.error('Daily reward status error:', err);
    res.status(500).json({ success: false, error: 'DB error' });
  }
});

// Забрать ежедневную награду
app.post('/api/daily-reward/claim', async (req, res) => {
  const { userId } = req.body;
  
  if (!userId) {
    return res.status(400).json({ success: false, error: 'userId required' });
  }
  
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    const today = new Date().toISOString().split('T')[0];
    const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
    
    // Получаем текущие данные
    const result = await client.query(
      'SELECT day_streak, last_claim_date, total_claimed FROM daily_rewards WHERE user_id = $1 FOR UPDATE',
      [userId]
    );
    
    let currentStreak = 0;
    let totalClaimed = 0;
    
    if (result.rows.length > 0) {
      const data = result.rows[0];
      const lastClaim = data.last_claim_date.toISOString().split('T')[0];
      
      // Проверяем не забрал ли уже сегодня
      if (lastClaim === today) {
        await client.query('ROLLBACK');
        return res.json({ success: false, error: 'Already claimed today', alreadyClaimed: true });
      }
      
      // Проверяем streak
      if (lastClaim === yesterday) {
        // Продолжаем streak
        currentStreak = data.day_streak;
      } else {
        // Пропустил день - сбрасываем streak
        currentStreak = 0;
      }
      
      totalClaimed = data.total_claimed;
    }
    
    // Вычисляем награду
    const rewardDay = currentStreak % 7;
    const weekMultiplier = Math.floor(currentStreak / 7) + 1;
    const baseReward = DAILY_REWARDS[rewardDay];
    const coinsReward = baseReward.coins * weekMultiplier;
    
    // Начисляем монеты
    await client.query(`
      INSERT INTO wallets (user_id, monkey_coin_balance)
      VALUES ($1, $2)
      ON CONFLICT (user_id)
      DO UPDATE SET 
        monkey_coin_balance = wallets.monkey_coin_balance + $2,
        updated_at = NOW()
    `, [userId, coinsReward]);
    
    // Обновляем daily_rewards
    const newStreak = currentStreak + 1;
    await client.query(`
      INSERT INTO daily_rewards (user_id, day_streak, last_claim_date, total_claimed)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (user_id)
      DO UPDATE SET 
        day_streak = $2,
        last_claim_date = $3,
        total_claimed = daily_rewards.total_claimed + $4
    `, [userId, newStreak, today, coinsReward]);
    
    // Логируем
    await logAudit('daily_reward_claimed', userId, {
      day: rewardDay + 1,
      streak: newStreak,
      coins: coinsReward,
      multiplier: weekMultiplier
    });
    
    await client.query('COMMIT');
    
    console.log(`🏆 Daily reward claimed: ${userId} - Day ${rewardDay + 1}, Streak ${newStreak}, +${coinsReward} coins`);
    
    // Получаем новый баланс
    const balanceResult = await pool.query(
      'SELECT monkey_coin_balance FROM wallets WHERE user_id = $1',
      [userId]
    );
    
    return res.json({
      success: true,
      reward: {
        day: rewardDay + 1,
        coins: coinsReward,
        bonus: baseReward.bonus,
        multiplier: weekMultiplier > 1 ? `x${weekMultiplier}` : null
      },
      newStreak,
      newBalance: balanceResult.rows[0]?.monkey_coin_balance || coinsReward,
      totalClaimed: totalClaimed + coinsReward
    });
    
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Daily reward claim error:', err);
    res.status(500).json({ success: false, error: 'DB error' });
  } finally {
    client.release();
  }
});

// ==================== END DAILY REWARDS ====================

// ==================== ACHIEVEMENTS SYSTEM ====================
// Список всех достижений
const ACHIEVEMENTS = [
  // Игровые достижения
  { id: 'first_game', name: 'Первые шаги', description: 'Сыграй свою первую игру', icon: '🎮', reward: 50, category: 'game' },
  { id: 'score_100', name: 'Новичок', description: 'Набери 100 очков в одной игре', icon: '⭐', reward: 100, category: 'game' },
  { id: 'score_500', name: 'Опытный', description: 'Набери 500 очков в одной игре', icon: '🌟', reward: 250, category: 'game' },
  { id: 'score_1000', name: 'Мастер', description: 'Набери 1000 очков в одной игре', icon: '💫', reward: 500, category: 'game' },
  { id: 'score_2000', name: 'Легенда', description: 'Набери 2000 очков в одной игре', icon: '🏆', reward: 1000, category: 'game' },
  { id: 'score_5000', name: 'Бог прыжков', description: 'Набери 5000 очков в одной игре', icon: '👑', reward: 2500, category: 'game' },
  
  // Достижения по количеству игр
  { id: 'games_10', name: 'Играющий', description: 'Сыграй 10 игр', icon: '🎯', reward: 100, category: 'progress' },
  { id: 'games_50', name: 'Упорный', description: 'Сыграй 50 игр', icon: '💪', reward: 300, category: 'progress' },
  { id: 'games_100', name: 'Преданный', description: 'Сыграй 100 игр', icon: '🔥', reward: 500, category: 'progress' },
  { id: 'games_500', name: 'Фанат', description: 'Сыграй 500 игр', icon: '💎', reward: 1500, category: 'progress' },
  
  // Социальные достижения
  { id: 'first_referral', name: 'Друг зовёт', description: 'Пригласи первого друга', icon: '👥', reward: 200, category: 'social' },
  { id: 'referrals_5', name: 'Популярный', description: 'Пригласи 5 друзей', icon: '🌐', reward: 500, category: 'social' },
  { id: 'referrals_10', name: 'Лидер', description: 'Пригласи 10 друзей', icon: '🚀', reward: 1000, category: 'social' },
  
  // Достижения по монетам
  { id: 'coins_1000', name: 'Копилка', description: 'Накопи 1000 монет', icon: '🪙', reward: 100, category: 'economy' },
  { id: 'coins_10000', name: 'Богач', description: 'Накопи 10000 монет', icon: '💰', reward: 500, category: 'economy' },
  { id: 'coins_100000', name: 'Миллионер', description: 'Накопи 100000 монет', icon: '🤑', reward: 2000, category: 'economy' },
  
  // Дуэли
  { id: 'first_duel_win', name: 'Победитель', description: 'Выиграй первую дуэль', icon: '⚔️', reward: 150, category: 'duel' },
  { id: 'duel_wins_10', name: 'Боец', description: 'Выиграй 10 дуэлей', icon: '🥊', reward: 400, category: 'duel' },
  { id: 'duel_wins_50', name: 'Чемпион', description: 'Выиграй 50 дуэлей', icon: '🏅', reward: 1000, category: 'duel' },
  
  // Серии
  { id: 'streak_7', name: 'Неделя подряд', description: 'Заходи 7 дней подряд', icon: '📅', reward: 300, category: 'streak' },
  { id: 'streak_30', name: 'Месяц подряд', description: 'Заходи 30 дней подряд', icon: '📆', reward: 1500, category: 'streak' },
];

// Получить достижения пользователя
app.get('/api/achievements/:userId', async (req, res) => {
  const { userId } = req.params;
  
  try {
    // Сначала убедимся что таблица существует
    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_achievements (
        id SERIAL PRIMARY KEY,
        user_id VARCHAR(255) NOT NULL,
        achievement_id VARCHAR(50) NOT NULL,
        unlocked_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        claimed BOOLEAN DEFAULT FALSE,
        UNIQUE(user_id, achievement_id)
      )
    `);
    
    // Получаем разблокированные достижения
    const unlockedResult = await pool.query(
      'SELECT achievement_id, unlocked_at, claimed FROM user_achievements WHERE user_id = $1',
      [userId]
    );
    
    const unlockedMap = {};
    unlockedResult.rows.forEach(row => {
      unlockedMap[row.achievement_id] = {
        unlockedAt: row.unlocked_at,
        claimed: row.claimed
      };
    });
    
    // Получаем статистику пользователя для прогресса (отдельными запросами для надёжности)
    let gamesPlayed = 0, bestScore = 0, coins = 0, referrals = 0, duelWins = 0, streak = 0;
    
    try {
      const r1 = await pool.query('SELECT COUNT(*) as cnt FROM player_scores WHERE user_id = $1', [userId]);
      gamesPlayed = parseInt(r1.rows[0]?.cnt) || 0;
    } catch(e) { console.error('Stats error games:', e.message); }
    
    try {
      const r2 = await pool.query('SELECT MAX(score) as mx FROM player_scores WHERE user_id = $1', [userId]);
      bestScore = parseInt(r2.rows[0]?.mx) || 0;
    } catch(e) { console.error('Stats error score:', e.message); }
    
    try {
      const r3 = await pool.query('SELECT monkey_coin_balance FROM wallets WHERE user_id = $1', [userId]);
      coins = parseInt(r3.rows[0]?.monkey_coin_balance) || 0;
    } catch(e) { console.error('Stats error coins:', e.message); }
    
    try {
      const r4 = await pool.query('SELECT COUNT(*) as cnt FROM referrals WHERE referrer_id = $1 AND bonus_paid = true', [userId]);
      referrals = parseInt(r4.rows[0]?.cnt) || 0;
    } catch(e) { console.error('Stats error referrals:', e.message); }
    
    try {
      const r5 = await pool.query('SELECT COUNT(*) as cnt FROM duels WHERE (player1_id = $1 OR player2_id = $1) AND winner_id = $1', [userId]);
      duelWins = parseInt(r5.rows[0]?.cnt) || 0;
    } catch(e) { console.error('Stats error duels:', e.message); }
    
    try {
      const r6 = await pool.query('SELECT day_streak FROM daily_rewards WHERE user_id = $1', [userId]);
      streak = parseInt(r6.rows[0]?.day_streak) || 0;
    } catch(e) { console.error('Stats error streak:', e.message); }
    
    const stats = { games_played: gamesPlayed, best_score: bestScore, coins, referrals, duel_wins: duelWins, streak };
    
    // Формируем ответ с прогрессом
    const achievements = ACHIEVEMENTS.map(ach => {
      const unlocked = unlockedMap[ach.id];
      let progress = 0;
      let target = 1;
      
      // Вычисляем прогресс в зависимости от типа достижения
      if (ach.id === 'first_game') {
        progress = Math.min(stats.games_played, 1);
      } else if (ach.id.startsWith('score_')) {
        target = parseInt(ach.id.split('_')[1]);
        progress = Math.min(stats.best_score, target);
      } else if (ach.id.startsWith('games_')) {
        target = parseInt(ach.id.split('_')[1]);
        progress = Math.min(stats.games_played, target);
      } else if (ach.id === 'first_referral') {
        progress = Math.min(stats.referrals, 1);
      } else if (ach.id.startsWith('referrals_')) {
        target = parseInt(ach.id.split('_')[1]);
        progress = Math.min(stats.referrals, target);
      } else if (ach.id.startsWith('coins_')) {
        target = parseInt(ach.id.split('_')[1]);
        progress = Math.min(stats.coins, target);
      } else if (ach.id === 'first_duel_win') {
        progress = Math.min(stats.duel_wins, 1);
      } else if (ach.id.startsWith('duel_wins_')) {
        target = parseInt(ach.id.split('_')[1]);
        progress = Math.min(stats.duel_wins, target);
      } else if (ach.id.startsWith('streak_')) {
        target = parseInt(ach.id.split('_')[1]);
        progress = Math.min(stats.streak, target);
      }
      
      return {
        ...ach,
        unlocked: !!unlocked,
        unlockedAt: unlocked?.unlockedAt || null,
        claimed: unlocked?.claimed || false,
        progress,
        target
      };
    });
    
    // Считаем статистику
    const totalUnlocked = achievements.filter(a => a.unlocked).length;
    const totalClaimed = achievements.filter(a => a.claimed).length;
    const unclaimedRewards = achievements
      .filter(a => a.unlocked && !a.claimed)
      .reduce((sum, a) => sum + a.reward, 0);
    
    res.json({
      success: true,
      achievements,
      stats: {
        total: ACHIEVEMENTS.length,
        unlocked: totalUnlocked,
        claimed: totalClaimed,
        unclaimedRewards
      }
    });
  } catch (err) {
    console.error('Get achievements error:', err.message, err.stack);
    res.status(500).json({ success: false, error: 'DB error', details: err.message });
  }
});

// Проверить и разблокировать достижения (вызывается после игры/действия)
app.post('/api/achievements/check', async (req, res) => {
  const { userId } = req.body;
  
  if (!userId) {
    return res.status(400).json({ success: false, error: 'userId required' });
  }
  
  try {
    // Получаем статистику отдельными запросами
    let gamesPlayed = 0, bestScore = 0, coins = 0, referrals = 0, duelWins = 0, streak = 0;
    
    try {
      const r1 = await pool.query('SELECT COUNT(*) as cnt FROM player_scores WHERE user_id = $1', [userId]);
      gamesPlayed = parseInt(r1.rows[0]?.cnt) || 0;
    } catch(e) {}
    
    try {
      const r2 = await pool.query('SELECT MAX(score) as mx FROM player_scores WHERE user_id = $1', [userId]);
      bestScore = parseInt(r2.rows[0]?.mx) || 0;
    } catch(e) {}
    
    try {
      const r3 = await pool.query('SELECT monkey_coin_balance FROM wallets WHERE user_id = $1', [userId]);
      coins = parseInt(r3.rows[0]?.monkey_coin_balance) || 0;
    } catch(e) {}
    
    try {
      const r4 = await pool.query('SELECT COUNT(*) as cnt FROM referrals WHERE referrer_id = $1 AND bonus_paid = true', [userId]);
      referrals = parseInt(r4.rows[0]?.cnt) || 0;
    } catch(e) {}
    
    try {
      const r5 = await pool.query('SELECT COUNT(*) as cnt FROM duels WHERE (player1_id = $1 OR player2_id = $1) AND winner_id = $1', [userId]);
      duelWins = parseInt(r5.rows[0]?.cnt) || 0;
    } catch(e) {}
    
    try {
      const r6 = await pool.query('SELECT day_streak FROM daily_rewards WHERE user_id = $1', [userId]);
      streak = parseInt(r6.rows[0]?.day_streak) || 0;
    } catch(e) {}
    
    // Получаем уже разблокированные
    const unlockedResult = await pool.query(
      'SELECT achievement_id FROM user_achievements WHERE user_id = $1',
      [userId]
    );
    const alreadyUnlocked = new Set(unlockedResult.rows.map(r => r.achievement_id));
    
    // Проверяем какие достижения можно разблокировать
    const newlyUnlocked = [];
    
    for (const ach of ACHIEVEMENTS) {
      if (alreadyUnlocked.has(ach.id)) continue;
      
      let shouldUnlock = false;
      
      if (ach.id === 'first_game' && gamesPlayed >= 1) shouldUnlock = true;
      else if (ach.id === 'score_100' && bestScore >= 100) shouldUnlock = true;
      else if (ach.id === 'score_500' && bestScore >= 500) shouldUnlock = true;
      else if (ach.id === 'score_1000' && bestScore >= 1000) shouldUnlock = true;
      else if (ach.id === 'score_2000' && bestScore >= 2000) shouldUnlock = true;
      else if (ach.id === 'score_5000' && bestScore >= 5000) shouldUnlock = true;
      else if (ach.id === 'games_10' && gamesPlayed >= 10) shouldUnlock = true;
      else if (ach.id === 'games_50' && gamesPlayed >= 50) shouldUnlock = true;
      else if (ach.id === 'games_100' && gamesPlayed >= 100) shouldUnlock = true;
      else if (ach.id === 'games_500' && gamesPlayed >= 500) shouldUnlock = true;
      else if (ach.id === 'first_referral' && referrals >= 1) shouldUnlock = true;
      else if (ach.id === 'referrals_5' && referrals >= 5) shouldUnlock = true;
      else if (ach.id === 'referrals_10' && referrals >= 10) shouldUnlock = true;
      else if (ach.id === 'coins_1000' && coins >= 1000) shouldUnlock = true;
      else if (ach.id === 'coins_10000' && coins >= 10000) shouldUnlock = true;
      else if (ach.id === 'coins_100000' && coins >= 100000) shouldUnlock = true;
      else if (ach.id === 'first_duel_win' && duelWins >= 1) shouldUnlock = true;
      else if (ach.id === 'duel_wins_10' && duelWins >= 10) shouldUnlock = true;
      else if (ach.id === 'duel_wins_50' && duelWins >= 50) shouldUnlock = true;
      else if (ach.id === 'streak_7' && streak >= 7) shouldUnlock = true;
      else if (ach.id === 'streak_30' && streak >= 30) shouldUnlock = true;
      
      if (shouldUnlock) {
        await pool.query(
          'INSERT INTO user_achievements (user_id, achievement_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [userId, ach.id]
        );
        newlyUnlocked.push(ach);
        console.log(`🎯 Achievement unlocked: ${userId} - ${ach.name}`);
      }
    }
    
    res.json({
      success: true,
      newlyUnlocked,
      count: newlyUnlocked.length
    });
  } catch (err) {
    console.error('Check achievements error:', err.message);
    res.status(500).json({ success: false, error: 'DB error', details: err.message });
  }
});

// Забрать награду за достижение
app.post('/api/achievements/claim', async (req, res) => {
  const { userId, achievementId } = req.body;
  
  if (!userId || !achievementId) {
    return res.status(400).json({ success: false, error: 'userId and achievementId required' });
  }
  
  const achievement = ACHIEVEMENTS.find(a => a.id === achievementId);
  if (!achievement) {
    return res.status(400).json({ success: false, error: 'Achievement not found' });
  }
  
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    // Проверяем что достижение разблокировано и не забрано
    const checkResult = await client.query(
      'SELECT claimed FROM user_achievements WHERE user_id = $1 AND achievement_id = $2 FOR UPDATE',
      [userId, achievementId]
    );
    
    if (checkResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.json({ success: false, error: 'Achievement not unlocked' });
    }
    
    if (checkResult.rows[0].claimed) {
      await client.query('ROLLBACK');
      return res.json({ success: false, error: 'Already claimed', alreadyClaimed: true });
    }
    
    // Начисляем награду
    await client.query(`
      INSERT INTO wallets (user_id, monkey_coin_balance)
      VALUES ($1, $2)
      ON CONFLICT (user_id)
      DO UPDATE SET 
        monkey_coin_balance = wallets.monkey_coin_balance + $2,
        updated_at = NOW()
    `, [userId, achievement.reward]);
    
    // Отмечаем как забранное
    await client.query(
      'UPDATE user_achievements SET claimed = true WHERE user_id = $1 AND achievement_id = $2',
      [userId, achievementId]
    );
    
    await client.query('COMMIT');
    
    // Получаем новый баланс
    const balanceResult = await pool.query(
      'SELECT monkey_coin_balance FROM wallets WHERE user_id = $1',
      [userId]
    );
    
    console.log(`🎁 Achievement reward claimed: ${userId} - ${achievement.name} (+${achievement.reward})`);
    
    res.json({
      success: true,
      achievement,
      reward: achievement.reward,
      newBalance: balanceResult.rows[0]?.monkey_coin_balance || 0
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Claim achievement error:', err);
    res.status(500).json({ success: false, error: 'DB error' });
  } finally {
    client.release();
  }
});

// Забрать все доступные награды
app.post('/api/achievements/claim-all', async (req, res) => {
  const { userId } = req.body;
  
  if (!userId) {
    return res.status(400).json({ success: false, error: 'userId required' });
  }
  
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    // Получаем незабранные достижения
    const unclaimedResult = await client.query(
      'SELECT achievement_id FROM user_achievements WHERE user_id = $1 AND claimed = false FOR UPDATE',
      [userId]
    );
    
    if (unclaimedResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.json({ success: true, claimed: 0, totalReward: 0 });
    }
    
    let totalReward = 0;
    const claimedAchievements = [];
    
    for (const row of unclaimedResult.rows) {
      const achievement = ACHIEVEMENTS.find(a => a.id === row.achievement_id);
      if (achievement) {
        totalReward += achievement.reward;
        claimedAchievements.push(achievement);
      }
    }
    
    // Начисляем все награды
    await client.query(`
      INSERT INTO wallets (user_id, monkey_coin_balance)
      VALUES ($1, $2)
      ON CONFLICT (user_id)
      DO UPDATE SET 
        monkey_coin_balance = wallets.monkey_coin_balance + $2,
        updated_at = NOW()
    `, [userId, totalReward]);
    
    // Отмечаем все как забранные
    await client.query(
      'UPDATE user_achievements SET claimed = true WHERE user_id = $1 AND claimed = false',
      [userId]
    );
    
    await client.query('COMMIT');
    
    // Получаем новый баланс
    const balanceResult = await pool.query(
      'SELECT monkey_coin_balance FROM wallets WHERE user_id = $1',
      [userId]
    );
    
    console.log(`🎁 All achievements claimed: ${userId} - ${claimedAchievements.length} achievements (+${totalReward})`);
    
    res.json({
      success: true,
      claimed: claimedAchievements.length,
      totalReward,
      achievements: claimedAchievements,
      newBalance: balanceResult.rows[0]?.monkey_coin_balance || 0
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Claim all achievements error:', err);
    res.status(500).json({ success: false, error: 'DB error' });
  } finally {
    client.release();
  }
});

// ==================== END ACHIEVEMENTS ====================

// ==================== ADMIN API ====================

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

// Админ логин
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  
  if (password === ADMIN_PASSWORD) {
    const token = jwt.sign({ admin: true }, JWT_SECRET, { expiresIn: '24h' });
    res.json({ success: true, token });
  } else {
    res.status(401).json({ success: false, error: 'Invalid password' });
  }
});

// Middleware для админских запросов
const validateAdmin = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, error: 'No token' });
  }
  
  try {
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET);
    if (!decoded.admin) {
      return res.status(403).json({ success: false, error: 'Not admin' });
    }
    next();
  } catch (err) {
    res.status(401).json({ success: false, error: 'Invalid token' });
  }
};

// Получить Stars транзакции
app.get('/api/admin/stars-transactions', validateAdmin, async (req, res) => {
  try {
    const transactions = await telegramStars.getStarsTransactions();
    
    // Фильтруем только ВХОДЯЩИЕ платежи (от пользователей)
    // Исходящие (refunds) имеют receiver вместо source
    const incomingTransactions = transactions.filter(tx => 
      tx.source && tx.source.type === 'user' && tx.source.user
    );
    
    // Получаем список возвращённых транзакций из БД
    let refundedIds = new Set();
    try {
      const refundedResult = await pool.query(
        `SELECT transaction_id FROM refunded_stars WHERE transaction_id IS NOT NULL`
      );
      refundedIds = new Set(refundedResult.rows.map(r => r.transaction_id));
    } catch (e) {
      // Таблица может не существовать
      console.log('refunded_stars table not found, creating...');
      await pool.query(`
        CREATE TABLE IF NOT EXISTS refunded_stars (
          id SERIAL PRIMARY KEY,
          transaction_id TEXT NOT NULL UNIQUE,
          user_id VARCHAR(255) NOT NULL,
          refunded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);
    }
    
    let totalStars = 0;
    const txList = incomingTransactions.map(tx => {
      const isRefunded = refundedIds.has(tx.id);
      if (!isRefunded) {
        totalStars += tx.amount;
      }
      return {
        id: tx.id,
        amount: tx.amount,
        date: tx.date,
        source: tx.source,
        refunded: isRefunded
      };
    });
    
    res.json({
      success: true,
      totalStars,
      transactions: txList
    });
  } catch (err) {
    console.error('Admin stars error:', err);
    res.json({ success: true, totalStars: 0, transactions: [] });
  }
});

// Возврат Stars по transaction ID (для транзакций из Telegram API)
app.post('/api/admin/refund-by-payload', validateAdmin, async (req, res) => {
  try {
    const { userId, transactionId } = req.body;
    
    if (!userId || !transactionId) {
      return res.status(400).json({ success: false, error: 'userId and transactionId required' });
    }
    
    // Проверяем не был ли уже возвращён
    const checkResult = await pool.query(
      'SELECT id FROM refunded_stars WHERE transaction_id = $1',
      [transactionId]
    );
    
    if (checkResult.rows.length > 0) {
      return res.json({ success: false, error: 'Эта транзакция уже была возвращена' });
    }
    
    console.log(`💸 Возврат Stars: userId=${userId}, transactionId=${transactionId}`);
    
    // Делаем возврат через Telegram API
    const response = await fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/refundStarPayment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        user_id: userId,
        telegram_payment_charge_id: transactionId
      })
    });
    
    const result = await response.json();
    
    if (result.ok) {
      // Сохраняем в БД что транзакция возвращена
      await pool.query(
        'INSERT INTO refunded_stars (transaction_id, user_id, refunded_at) VALUES ($1, $2, NOW())',
        [transactionId, userId]
      );
      
      console.log(`✅ Возврат успешен: userId=${userId}`);
      res.json({ success: true, message: `Stars успешно возвращены пользователю ${userId}` });
    } else {
      // Если уже возвращено через Telegram - тоже сохраним
      if (result.description && result.description.includes('ALREADY_REFUNDED')) {
        await pool.query(
          'INSERT INTO refunded_stars (transaction_id, user_id, refunded_at) VALUES ($1, $2, NOW()) ON CONFLICT DO NOTHING',
          [transactionId, userId]
        );
        return res.json({ success: false, error: 'Транзакция уже была возвращена ранее' });
      }
      
      console.error(`❌ Ошибка возврата:`, result);
      res.json({ success: false, error: result.description || 'Ошибка возврата' });
    }
    
  } catch (err) {
    console.error('Refund error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Получить статистику покупок
app.get('/api/admin/purchases-stats', validateAdmin, async (req, res) => {
  try {
    // Общее количество покупок
    const totalRes = await pool.query('SELECT COUNT(*) as count FROM purchases');
    const totalPurchases = parseInt(totalRes.rows[0].count);
    
    // Уникальные пользователи
    const usersRes = await pool.query('SELECT COUNT(DISTINCT user_id) as count FROM purchases');
    const uniqueUsers = parseInt(usersRes.rows[0].count);
    
    // TON транзакции
    const tonRes = await pool.query(`
      SELECT SUM(price) as total FROM purchases WHERE currency = 'TON' AND status != 'pending'
    `);
    const tonReceived = parseFloat(tonRes.rows[0].total) || 0;
    
    // TON транзакции список
    const tonTxRes = await pool.query(`
      SELECT user_id, item_name, price, purchased_at 
      FROM purchases 
      WHERE currency = 'TON' AND status != 'pending'
      ORDER BY purchased_at DESC 
      LIMIT 20
    `);
    
    // Последние покупки
    const recentRes = await pool.query(`
      SELECT user_id, item_name, price, currency, purchased_at 
      FROM purchases 
      ORDER BY purchased_at DESC 
      LIMIT 20
    `);
    
    res.json({
      success: true,
      totalPurchases,
      uniqueUsers,
      tonReceived,
      tonTransactions: tonTxRes.rows,
      recentPurchases: recentRes.rows
    });
  } catch (err) {
    console.error('Admin purchases error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Возврат Stars пользователю
app.post('/api/admin/refund-stars', validateAdmin, async (req, res) => {
  const { userId, purchaseId } = req.body;
  
  if (!userId || !purchaseId) {
    return res.status(400).json({ success: false, error: 'userId and purchaseId required' });
  }
  
  try {
    // Находим покупку с charge_id
    const purchaseRes = await pool.query(`
      SELECT id, user_id, item_name, price, nonce as charge_id, status
      FROM purchases 
      WHERE id = $1 AND currency = 'XTR'
    `, [purchaseId]);
    
    if (purchaseRes.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Purchase not found' });
    }
    
    const purchase = purchaseRes.rows[0];
    
    if (purchase.status === 'refunded') {
      return res.status(400).json({ success: false, error: 'Already refunded' });
    }
    
    if (!purchase.charge_id) {
      return res.status(400).json({ success: false, error: 'No charge_id - refund not possible for old purchases' });
    }
    
    // Делаем возврат через Telegram API
    await telegramStars.refundStarsPayment(parseInt(purchase.user_id), purchase.charge_id);
    
    // Помечаем покупку как возвращённую
    await pool.query(`
      UPDATE purchases SET status = 'refunded' WHERE id = $1
    `, [purchaseId]);
    
    console.log(`✅ Refund successful: ${purchase.item_name} for user ${purchase.user_id}`);
    
    res.json({ 
      success: true, 
      message: `Возврат ${purchase.price} ⭐ за "${purchase.item_name}" выполнен` 
    });
    
  } catch (err) {
    console.error('Refund error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Получить покупки Stars с возможностью возврата
app.get('/api/admin/stars-purchases', validateAdmin, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, user_id, item_id, item_name, price, status, purchased_at,
             CASE WHEN status != 'refunded' THEN true ELSE false END as can_refund
      FROM purchases 
      WHERE currency = 'XTR'
      ORDER BY purchased_at DESC 
      LIMIT 50
    `);
    
    res.json({ success: true, purchases: result.rows });
  } catch (err) {
    console.error('Stars purchases error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==================== END ADMIN API ====================

app.listen(PORT, () => {
  console.log(`API server listening on ${PORT}`);
  console.log(`💰 Игровые STARS: Включены (виртуальная валюта)`);
  console.log(`⭐ Telegram Stars (XTR): Включены (реальные платежи)`);
  console.log(`📹 Intro Video API: /api/send-intro-video`);
  console.log(`🎁 Referral System: Active (${REFERRAL_BONUS_REFERRER}/${REFERRAL_BONUS_REFERRED} coins)`);
  console.log(`🏆 Daily Rewards: Active`);
  console.log(`🎯 Achievements: ${ACHIEVEMENTS.length} achievements`);
  console.log(`🔗 TON Connect manifest: /tonconnect-manifest.json`);
});