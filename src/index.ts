import 'dotenv/config';
import express from 'express';
import cors from 'cors';

import profilesRouter from './routes/profiles.js';
import friendsRouter from './routes/friends.js';
import currencyRouter from './routes/currency.js';
import leaderboardRouter from './routes/leaderboard.js';

const PORT = Number(process.env.PORT ?? 4000);

// Accept requests from the game clients (Vite dev) and game server
const ALLOWED_ORIGINS = /^http:\/\/localhost(:\d+)?$/;

const app = express();
app.use(cors({ origin: ALLOWED_ORIGINS }));
app.use(express.json());

// ── Health check ─────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: 'platform-api', timestamp: new Date().toISOString() });
});

// ── Routes ───────────────────────────────────────────────────────────────────
app.use('/users', profilesRouter);
// Friends and currency are nested under /users/:userId
app.use('/users/:userId/friends', friendsRouter);
app.use('/users/:userId/currency', currencyRouter);
app.use('/leaderboard', leaderboardRouter);

// ── 404 fallback ─────────────────────────────────────────────────────────────
app.use((_req, res) => {
    res.status(404).json({ error: 'Not found' });
});

// ── Global error handler ─────────────────────────────────────────────────────
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error('[platform-api] Unhandled error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
    console.log(`🌐 Platform API running on http://localhost:${PORT}`);
    console.log(`   /health    — status check`);
    console.log(`   /users     — profiles`);
    console.log(`   /users/:id/friends   — friends`);
    console.log(`   /users/:id/currency  — currency`);
    console.log(`   /leaderboard         — cross-game leaderboard`);
});
