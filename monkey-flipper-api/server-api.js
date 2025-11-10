const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// PostgreSQL connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
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
    
    console.log('✅ DB ready (player_scores + duels)');
  } catch (err) {
    console.error('DB setup error', err);
  }
})();

// Save score
app.post('/api/save-score', async (req, res) => {
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
    
    // Формируем ссылку для Telegram
    const duelLink = botUsername 
      ? `https://t.me/${botUsername}?startapp=${matchId}`
      : `https://t.me/share/url?url=Duel:${matchId}`;
    
    return res.json({ 
      success: true, 
      matchId, 
      seed,
      duelLink,
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
      SELECT * FROM duels 
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

app.listen(PORT, () => {
  console.log(`API server listening on ${PORT}`);
});
