// API endpoint для получения глобального рейтинга
// Vercel Serverless Function

// ПЕРЕНАПРАВЛЕНИЕ: Теперь leaderboard находится в save-score.js
// Это решает проблему изолированной памяти между функциями

export default async function handler(req, res) {
    // Включаем CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    // Перенаправляем на save-score с GET методом
    const limit = req.query.limit || '100';
    
    // Используем внутренний редирект
    return res.redirect(307, `/api/save-score?limit=${limit}`);
}
