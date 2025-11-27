// Миграция для создания таблиц турниров
// Запустить ОДИН РАЗ после деплоя: node migrate-tournaments.js

require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false }
});

async function migrate() {
  const client = await pool.connect();
  
  try {
    console.log('🔧 Начинаем миграцию турниров...');
    
    await client.query('BEGIN');
    
    // Таблица tournaments
    console.log('📦 Создаём таблицу tournaments...');
    await client.query(`
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
    `);
    
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_tournaments_status ON tournaments(status);
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_tournaments_end_time ON tournaments(end_time);
    `);
    
    // Таблица tournament_participants
    console.log('📦 Создаём таблицу tournament_participants...');
    await client.query(`
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
    `);
    
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_tournament_participants_tournament 
      ON tournament_participants(tournament_id);
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_tournament_participants_user 
      ON tournament_participants(user_id);
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_tournament_participants_score 
      ON tournament_participants(tournament_id, best_score DESC);
    `);
    
    // Таблица tournament_prizes
    console.log('📦 Создаём таблицу tournament_prizes...');
    await client.query(`
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
    `);
    
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_tournament_prizes_tournament 
      ON tournament_prizes(tournament_id);
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_tournament_prizes_user 
      ON tournament_prizes(user_id);
    `);
    
    await client.query('COMMIT');
    
    console.log('✅ Миграция завершена успешно!');
    console.log('');
    console.log('📊 Созданные таблицы:');
    console.log('  - tournaments');
    console.log('  - tournament_participants');
    console.log('  - tournament_prizes');
    console.log('');
    console.log('🎯 Теперь можно создать тестовый турнир:');
    console.log('   node create-test-tournament.js');
    
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Ошибка миграции:', err);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

migrate()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('💥 Фатальная ошибка:', err);
    process.exit(1);
  });
