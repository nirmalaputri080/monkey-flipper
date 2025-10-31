// API endpoint для получения глобального рейтинга
// Vercel Serverless Function

// ПЕРЕНАПРАВЛЕНИЕ: Теперь leaderboard находится в save-score.js
// Это решает проблему изолированной памяти между функциями

export default async function handler(req, res) {
    // Перенаправляем на save-score с GET методом
    const url = new URL(req.url, `https://${req.headers.host}`);
    const limit = url.searchParams.get('limit') || '100';
    
    // Используем внутренний редирект
    return res.redirect(307, `/api/save-score?limit=${limit}`);
}

export default async function handler(req, res) {
    // Включаем CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        // Получаем параметр limit (по умолчанию 100)
        const limit = parseInt(req.query.limit) || 100;

        // Формируем рейтинг
        const leaderboard = Object.entries(scoresDB)
            .map(([userId, data]) => ({
                userId: userId,
                username: data.username || 'Anonymous',
                bestScore: data.bestScore,
                gamesPlayed: data.gamesPlayed,
                lastPlayed: data.lastPlayed
            }))
            .sort((a, b) => b.bestScore - a.bestScore) // Сортировка по убыванию счета
            .slice(0, limit); // Берем топ N игроков

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
