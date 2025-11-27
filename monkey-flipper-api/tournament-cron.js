// Крон-задача для автоматического завершения турниров
// Запускать каждые 5 минут: */5 * * * * node tournament-cron.js

require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false }
});

async function finalizeTournaments() {
  const client = await pool.connect();
  
  try {
    console.log('🔍 Проверка турниров для завершения...');
    
    // Находим турниры которые истекли но еще не завершены
    const expiredTournaments = await client.query(`
      SELECT id, name, prize_pool_ton, prize_distribution
      FROM tournaments
      WHERE status IN ('active', 'upcoming')
        AND end_time < NOW()
    `);
    
    if (expiredTournaments.rows.length === 0) {
      console.log('✅ Нет турниров для завершения');
      return;
    }
    
    console.log(`⏰ Найдено турниров для завершения: ${expiredTournaments.rows.length}`);
    
    for (const tournament of expiredTournaments.rows) {
      console.log(`🏁 Завершаем турнир: ${tournament.name} (ID: ${tournament.id})`);
      
      await client.query('BEGIN');
      
      try {
        // Получаем топ участников
        const winners = await client.query(`
          SELECT user_id, username, best_score
          FROM tournament_participants
          WHERE tournament_id = $1
          ORDER BY best_score DESC, joined_at ASC
          LIMIT 10
        `, [tournament.id]);
        
        if (winners.rows.length === 0) {
          console.log('  ℹ️ Нет участников');
          await client.query(
            "UPDATE tournaments SET status = 'finished', updated_at = NOW() WHERE id = $1",
            [tournament.id]
          );
          await client.query('COMMIT');
          continue;
        }
        
        // Распределяем призы
        const prizeDistribution = tournament.prize_distribution;
        const totalPrizePool = parseFloat(tournament.prize_pool_ton);
        let totalPaid = 0;
        
        for (const [place, percent] of Object.entries(prizeDistribution)) {
          const placeNum = parseInt(place);
          if (placeNum <= winners.rows.length) {
            const winner = winners.rows[placeNum - 1];
            const prizeAmount = (totalPrizePool * percent) / 100;
            
            // Начисляем TON
            await client.query(`
              INSERT INTO wallets (user_id, ton_balance)
              VALUES ($1, $2)
              ON CONFLICT (user_id)
              DO UPDATE SET 
                ton_balance = wallets.ton_balance + $2,
                updated_at = NOW()
            `, [winner.user_id, prizeAmount]);
            
            // Записываем приз
            await client.query(`
              INSERT INTO tournament_prizes 
                (tournament_id, user_id, username, place, prize_ton, paid, paid_at)
              VALUES ($1, $2, $3, $4, $5, true, NOW())
            `, [tournament.id, winner.user_id, winner.username, placeNum, prizeAmount]);
            
            totalPaid += prizeAmount;
            console.log(`  💰 Приз ${placeNum} место: ${winner.username} - ${prizeAmount} TON`);
          }
        }
        
        // Обновляем статус турнира
        await client.query(
          "UPDATE tournaments SET status = 'finished', updated_at = NOW() WHERE id = $1",
          [tournament.id]
        );
        
        await client.query('COMMIT');
        console.log(`  ✅ Турнир завершен, выплачено: ${totalPaid} TON`);
        
      } catch (err) {
        await client.query('ROLLBACK');
        console.error(`  ❌ Ошибка завершения турнира ${tournament.id}:`, err);
      }
    }
    
    console.log('✅ Обработка завершена');
    
  } catch (err) {
    console.error('❌ Ошибка:', err);
  } finally {
    client.release();
    await pool.end();
  }
}

// Запускаем
finalizeTournaments()
  .then(() => {
    console.log('🏁 Крон-задача выполнена');
    process.exit(0);
  })
  .catch(err => {
    console.error('💥 Фатальная ошибка:', err);
    process.exit(1);
  });
