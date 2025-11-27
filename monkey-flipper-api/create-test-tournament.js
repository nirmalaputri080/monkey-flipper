// Скрипт для создания тестового турнира
// node create-test-tournament.js

require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false }
});

async function createTestTournament() {
  try {
    const now = new Date();
    const startTime = new Date(now.getTime() + 5 * 60 * 1000); // Через 5 минут
    const endTime = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000); // Через 7 дней
    
    const result = await pool.query(`
      INSERT INTO tournaments (
        name,
        description,
        entry_fee_ton,
        prize_pool_ton,
        platform_fee_percent,
        status,
        start_time,
        end_time,
        max_participants,
        prize_distribution
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10
      ) RETURNING *
    `, [
      'Weekly Championship 🏆',
      'Соревнуйтесь за главный приз недели! Лучшие игроки получат TON.',
      0.5, // Вступительный взнос 0.5 TON
      0, // Стартовый призовой фонд (будет расти с участниками)
      10, // 10% комиссия площадки
      'active', // Сразу активен
      startTime,
      endTime,
      100, // Максимум 100 участников
      JSON.stringify({
        "1": 50, // 1 место - 50%
        "2": 30, // 2 место - 30%
        "3": 20  // 3 место - 20%
      })
    ]);
    
    console.log('✅ Тестовый турнир создан:');
    console.log('ID:', result.rows[0].id);
    console.log('Название:', result.rows[0].name);
    console.log('Взнос:', result.rows[0].entry_fee_ton, 'TON');
    console.log('Начало:', result.rows[0].start_time);
    console.log('Конец:', result.rows[0].end_time);
    console.log('Распределение призов:', result.rows[0].prize_distribution);
    
  } catch (err) {
    console.error('❌ Ошибка создания турнира:', err);
  } finally {
    await pool.end();
  }
}

createTestTournament();
