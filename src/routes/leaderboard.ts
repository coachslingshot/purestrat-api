import { Router } from 'express';
import { z } from 'zod';
import { supabase } from '../supabase.js';
import { requirePlayerJwt, requireInternalKey } from '../middleware/auth.js';

const router = Router();

// ── GET /leaderboard ─────────────────────────────────────────────────────────
// Top 50 players globally, ordered by their cross-game ELO in player_profiles.
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

// ── GET /leaderboard/games ────────────────────────────────────────────────────
// Returns distinct game IDs that have at least one entry in game_elo.
// The portal uses this to auto-build leaderboard tabs.
router.get('/games', requirePlayerJwt, async (_req, res): Promise<void> => {
    const { data, error } = await supabase
        .from('game_elo')
        .select('game_id')
        .order('game_id');

    if (error) {
        res.status(500).json({ error: error.message });
        return;
    }

    const gameIds = [...new Set((data ?? []).map((r: { game_id: string }) => r.game_id))];
    res.json(gameIds);
});

// ── GET /leaderboard/:gameId ─────────────────────────────────────────────────
// Top 50 players for a specific game. Reads from game_elo (live snapshot).
router.get('/:gameId', requirePlayerJwt, async (req, res): Promise<void> => {
    const { gameId } = req.params;

    const { data, error } = await supabase
        .from('game_elo')
        .select(`
            user_id,
            elo,
            wins,
            losses,
            updated_at,
            profile:user_id ( username )
        `)
        .eq('game_id', gameId)
        .order('elo', { ascending: false })
        .limit(50);

    if (error) {
        res.status(500).json({ error: error.message });
        return;
    }

    const leaderboard = (data ?? []).map((r: {
        user_id: string;
        elo: number;
        wins: number;
        losses: number;
        updated_at: string;
        profile: { username: string }[] | null;
    }) => ({
        user_id: r.user_id,
        username: r.profile?.[0]?.username ?? 'Unknown',
        elo: r.elo,
        wins: r.wins,
        losses: r.losses,
        updated_at: r.updated_at,
    }));

    res.json(leaderboard);
});

// ── POST /leaderboard/submit ─────────────────────────────────────────────────
// Game servers call this after a match ends to record results.
// Updates THREE things:
//   1. game_results — immutable audit log
//   2. game_elo     — live per-game ELO snapshot (upsert)
//   3. player_profiles.elo — global cross-game ELO
const SubmitSchema = z.object({
    gameId: z.string().min(1),
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

    // 1. Append to immutable audit log
    const auditRows = results.map(r => ({
        game_id: gameId,
        user_id: r.userId,
        elo_before: r.eloBefore,
        elo_after: r.eloAfter,
        outcome: r.outcome,
    }));

    const { error: auditErr } = await supabase.from('game_results').insert(auditRows);
    if (auditErr) {
        res.status(500).json({ error: `game_results insert failed: ${auditErr.message}` });
        return;
    }

    // 2. Upsert game_elo — increment wins/losses rather than overwrite
    for (const r of results) {
        const { data: existing } = await supabase
            .from('game_elo')
            .select('wins, losses')
            .eq('user_id', r.userId)
            .eq('game_id', gameId)
            .maybeSingle();

        await supabase
            .from('game_elo')
            .upsert({
                user_id: r.userId,
                game_id: gameId,
                elo: r.eloAfter,
                wins: (existing?.wins ?? 0) + (r.outcome === 'win' ? 1 : 0),
                losses: (existing?.losses ?? 0) + (r.outcome === 'loss' ? 1 : 0),
                updated_at: new Date().toISOString(),
            }, { onConflict: 'user_id,game_id' });
    }

    // 3. Update global ELO in player_profiles
    await Promise.all(results.map(r =>
        supabase
            .from('player_profiles')
            .update({ elo: r.eloAfter })
            .eq('user_id', r.userId)
    ));

    console.log(`[leaderboard] Submitted ${results.length} results for "${gameId}"`);
    res.status(201).json({ recorded: results.length, gameId });
});

export default router;
