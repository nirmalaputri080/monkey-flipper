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
    console.log('✅ DB ready');
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

app.listen(PORT, () => {
  console.log(`API server listening on ${PORT}`);
});
