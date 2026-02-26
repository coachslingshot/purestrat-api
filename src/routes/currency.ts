import { Router } from 'express';
import { z } from 'zod';
import { supabase } from '../supabase.js';
import { requirePlayerJwt, requireInternalKey } from '../middleware/auth.js';

const router = Router({ mergeParams: true });

// ── GET /users/:userId/currency ──────────────────────────────────────────────
// Get the coin/gem balance for a user.
router.get('/', requirePlayerJwt, async (req, res): Promise<void> => {
    const { userId } = req.params;

    // Upsert ensures every player has a row, even if they've never earned currency
    const { data, error } = await supabase
        .from('currencies')
        .upsert({ user_id: userId, coins: 0, gems: 0 }, { onConflict: 'user_id', ignoreDuplicates: true })
        .select()
        .single();

    if (error) {
        // Try a plain select if upsert gave an issue (e.g. row already exists, returned nothing)
        const { data: existing } = await supabase
            .from('currencies')
            .select()
            .eq('user_id', userId)
            .single();

        if (existing) {
            res.json(existing);
            return;
        }

        res.status(500).json({ error: error.message });
        return;
    }

    res.json(data ?? { user_id: userId, coins: 0, gems: 0 });
});

// ── POST /users/:userId/currency/award ───────────────────────────────────────
// Award coins/gems to a player. Internal-only (called by game servers).
const AwardSchema = z.object({
    coins: z.number().int().min(0).optional(),
    gems: z.number().int().min(0).optional(),
    reason: z.string().optional(),   // e.g. "match_win", "daily_bonus"
});

router.post('/award', requireInternalKey, async (req, res): Promise<void> => {
    const { userId } = req.params;

    const parsed = AwardSchema.safeParse(req.body);
    if (!parsed.success) {
        res.status(400).json({ error: parsed.error.flatten() });
        return;
    }

    const { coins = 0, gems = 0, reason } = parsed.data;

    // Upsert base row first, then increment
    await supabase
        .from('currencies')
        .upsert({ user_id: userId, coins: 0, gems: 0 }, { onConflict: 'user_id', ignoreDuplicates: true });

    const { data, error } = await supabase.rpc('increment_currency', {
        p_user_id: userId,
        p_coins: coins,
        p_gems: gems,
    });

    if (error) {
        // Fallback: manual read-then-write if RPC not deployed yet
        const { data: current } = await supabase
            .from('currencies')
            .select()
            .eq('user_id', userId)
            .single();

        const updated = await supabase
            .from('currencies')
            .update({
                coins: ((current as { coins: number } | null)?.coins ?? 0) + coins,
                gems: ((current as { gems: number } | null)?.gems ?? 0) + gems,
                updated_at: new Date().toISOString(),
            })
            .eq('user_id', userId)
            .select()
            .single();

        console.log(`[currency] Awarded ${coins} coins, ${gems} gems to ${userId} (${reason ?? 'no reason'})`);
        res.json(updated.data);
        return;
    }

    console.log(`[currency] Awarded ${coins} coins, ${gems} gems to ${userId} (${reason ?? 'no reason'})`);
    res.json(data);
});

// ── POST /users/:userId/currency/deduct ──────────────────────────────────────
// Deduct coins/gems (e.g. for in-game purchases). Internal-only.
const DeductSchema = z.object({
    coins: z.number().int().min(0).optional(),
    gems: z.number().int().min(0).optional(),
    reason: z.string().optional(),
});

router.post('/deduct', requireInternalKey, async (req, res): Promise<void> => {
    const { userId } = req.params;

    const parsed = DeductSchema.safeParse(req.body);
    if (!parsed.success) {
        res.status(400).json({ error: parsed.error.flatten() });
        return;
    }

    const { coins = 0, gems = 0, reason } = parsed.data;

    const { data: current, error: fetchErr } = await supabase
        .from('currencies')
        .select()
        .eq('user_id', userId)
        .single();

    if (fetchErr || !current) {
        res.status(404).json({ error: 'Currency record not found' });
        return;
    }

    const currentTyped = current as { coins: number; gems: number };

    if (currentTyped.coins < coins || currentTyped.gems < gems) {
        res.status(402).json({ error: 'Insufficient funds' });
        return;
    }

    const { data, error } = await supabase
        .from('currencies')
        .update({
            coins: currentTyped.coins - coins,
            gems: currentTyped.gems - gems,
            updated_at: new Date().toISOString(),
        })
        .eq('user_id', userId)
        .select()
        .single();

    if (error) {
        res.status(500).json({ error: error.message });
        return;
    }

    console.log(`[currency] Deducted ${coins} coins, ${gems} gems from ${userId} (${reason ?? 'no reason'})`);
    res.json(data);
});

export default router;
