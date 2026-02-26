import { Router } from 'express';
import { z } from 'zod';
import { supabase } from '../supabase.js';
import { requirePlayerJwt, requireInternalKey } from '../middleware/auth.js';

const router = Router();

// ── GET /leaderboard ─────────────────────────────────────────────────────────
// Top 50 players across all games, ordered by ELO.
router.get('/', requirePlayerJwt, async (_req, res): Promise<void> => {
    const { data, error } = await supabase
        .from('player_profiles')
        .select('user_id, username, elo, wins, losses, games_played')
        .order('elo', { ascending: false })
        .limit(50);

    if (error) {
        res.status(500).json({ error: error.message });
        return;
    }

    res.json(data ?? []);
});

// ── GET /leaderboard/:gameId ─────────────────────────────────────────────────
// Top 50 players for a specific game, computed from game_results.
router.get('/:gameId', requirePlayerJwt, async (req, res): Promise<void> => {
    const { gameId } = req.params;

    // Aggregate ELO for this specific game, join profile for username
    const { data, error } = await supabase
        .from('game_results')
        .select(`
            user_id,
            elo_after,
            played_at,
            profile:user_id (username)
        `)
        .eq('game_id', gameId)
        .order('played_at', { ascending: false });

    if (error) {
        res.status(500).json({ error: error.message });
        return;
    }

    // Deduplicate: keep only the most-recent ELO per player
    const seen = new Map<string, { user_id: string; username: string; elo: number; played_at: string }>();
    for (const row of (data ?? []) as Array<{
        user_id: string;
        elo_after: number;
        played_at: string;
        profile: { username: string }[] | null;
    }>) {
        if (!seen.has(row.user_id)) {
            seen.set(row.user_id, {
                user_id: row.user_id,
                username: row.profile?.[0]?.username ?? 'Unknown',
                elo: row.elo_after,
                played_at: row.played_at,
            });
        }
    }

    const leaderboard = [...seen.values()]
        .sort((a, b) => b.elo - a.elo)
        .slice(0, 50);

    res.json(leaderboard);
});

// ── POST /leaderboard/submit ─────────────────────────────────────────────────
// Game servers call this after a match ends to record results.
// Also updates player_profiles ELO so the global leaderboard stays current.
const SubmitSchema = z.object({
    gameId: z.string().min(1),               // e.g. "dualsuit-jujitsu"
    winnerId: z.string().uuid(),
    results: z.array(z.object({
        userId: z.string().uuid(),
        eloBefore: z.number().int(),
        eloAfter: z.number().int(),
        outcome: z.enum(['win', 'loss', 'draw']),
    })).min(1),
});

router.post('/submit', requireInternalKey, async (req, res): Promise<void> => {
    const parsed = SubmitSchema.safeParse(req.body);
    if (!parsed.success) {
        res.status(400).json({ error: parsed.error.flatten() });
        return;
    }

    const { gameId, results } = parsed.data;

    // Insert one game_results row per participant
    const rows = results.map(r => ({
        game_id: gameId,
        user_id: r.userId,
        elo_before: r.eloBefore,
        elo_after: r.eloAfter,
        outcome: r.outcome,
    }));

    const { error: insertErr } = await supabase.from('game_results').insert(rows);

    if (insertErr) {
        res.status(500).json({ error: insertErr.message });
        return;
    }

    // Update each player's ELO in player_profiles (for the global leaderboard)
    const profileUpdates = results.map(r =>
        supabase
            .from('player_profiles')
            .update({ elo: r.eloAfter })
            .eq('user_id', r.userId)
    );
    await Promise.all(profileUpdates);

    console.log(`[leaderboard] Recorded ${results.length} results for game "${gameId}"`);
    res.status(201).json({ recorded: results.length });
});

export default router;
