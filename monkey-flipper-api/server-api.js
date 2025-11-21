const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;

// JWT Secret (в production должен быть в .env)
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';
const BOT_TOKEN = process.env.BOT_TOKEN || ''; // Telegram Bot Token

app.use(cors());
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

// Rate limiting - 5 запросов в минуту на игрока
const gameResultLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 минута
  max: 5, // 5 запросов
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
    
    console.log('✅ DB ready (player_scores + duels + wallets + transactions + migrations applied)');
  } catch (err) {
    console.error('DB setup error', err);
  }
})();

// Save score (с rate limiting)
app.post('/api/save-score', gameResultLimiter, async (req, res) => {
  const { userId, username, score } = req.body;
  if (!userId || typeof score !== 'number') {
    return res.status(400).json({ success: false, error: 'Invalid payload' });
  }
  try {
    const bestResult = await pool.query('SELECT MAX(score) as best FROM player_scores WHERE user_id = $1', [userId]);
    const previousBest = bestResult.rows[0]?.best || 0;
    const isNewRecord = score > previousBest;

    await pool.query('INSERT INTO player_scores (user_id, username, score) VALUES ($1, $2, $3)', [userId, username, score]);

    return res.json({ success: true, isNewRecord, bestScore: Math.max(score, previousBest) });
  } catch (err) {
    console.error('Save error', err);
    return res.status(500).json({ success: false, error: 'DB error' });
  }
});

// Leaderboard
app.get('/api/leaderboard', async (req, res) => {
  const limit = parseInt(req.query.limit) || 100;
  try {
    const result = await pool.query(`
      SELECT DISTINCT ON (user_id) user_id, username, score, timestamp
      FROM player_scores
      ORDER BY user_id, score DESC, timestamp DESC
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

app.listen(PORT, () => {
  console.log(`API server listening on ${PORT}`);
});
