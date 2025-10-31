// API endpoint для сохранения счета игрока
// Vercel Serverless Function

// Простая "база данных" в памяти (для демо)
// В продакшене используйте настоящую БД (MongoDB, PostgreSQL)
// ВАЖНО: Vercel хранит это в памяти только во время выполнения функции!
// Используем global для сохранения между вызовами в рамках одного инстанса
if (!global.scoresDB) {
    global.scoresDB = {};
}

export default async function handler(req, res) {
    // Включаем CORS для доступа из игры
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    // Обработка preflight запроса
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    // НОВОЕ: Добавлена поддержка GET для получения leaderboard
    if (req.method === 'GET') {
        try {
            const limit = parseInt(req.query.limit) || 100;

            const leaderboard = Object.entries(global.scoresDB)
                .map(([userId, data]) => ({
                    userId: userId,
                    username: data.username || 'Anonymous',
                    bestScore: data.bestScore,
                    gamesPlayed: data.gamesPlayed,
                    lastPlayed: data.lastPlayed
                }))
                .sort((a, b) => b.bestScore - a.bestScore)
                .slice(0, limit);

            return res.status(200).json({
                success: true,
                count: leaderboard.length,
                leaderboard: leaderboard
            });
        } catch (error) {
            console.error('❌ Ошибка получения рейтинга:', error);
            return res.status(500).json({
                success: false,
                error: 'Internal server error'
            });
        }
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        const { userId, score, timestamp, username } = req.body;

        // Валидация данных
        if (!userId || typeof score !== 'number') {
            return res.status(400).json({ 
                success: false, 
                error: 'Invalid data: userId and score required' 
            });
        }

        // Инициализируем пользователя если его нет
        if (!global.scoresDB[userId]) {
            global.scoresDB[userId] = {
                bestScore: 0,
                gamesPlayed: 0,
                lastPlayed: null,
                username: username || 'Anonymous',
                history: []
            };
        }

        // Обновляем данные
        global.scoresDB[userId].gamesPlayed += 1;
        global.scoresDB[userId].lastPlayed = timestamp || new Date().toISOString();
        global.scoresDB[userId].history.push({
            score: score,
            timestamp: timestamp || new Date().toISOString()
        });

        // Обновляем лучший счет
        const isNewRecord = score > global.scoresDB[userId].bestScore;
        if (isNewRecord) {
            global.scoresDB[userId].bestScore = score;
        }

        // Ограничиваем историю последними 100 играми
        if (global.scoresDB[userId].history.length > 100) {
            global.scoresDB[userId].history = global.scoresDB[userId].history.slice(-100);
        }

        console.log(`✅ Счет сохранен: userId=${userId}, score=${score}, isNewRecord=${isNewRecord}`);

        // Отправляем ответ
        return res.status(200).json({
            success: true,
            isNewRecord: isNewRecord,
            bestScore: global.scoresDB[userId].bestScore,
            gamesPlayed: global.scoresDB[userId].gamesPlayed,
            message: isNewRecord ? 'New record!' : 'Score saved'
        });

    } catch (error) {
        console.error('❌ Ошибка сохранения счета:', error);
        return res.status(500).json({ 
            success: false, 
            error: 'Internal server error' 
        });
    }
}
