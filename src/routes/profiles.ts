import { Router } from 'express';
import { z } from 'zod';
import { supabase } from '../supabase.js';
import { requirePlayerJwt } from '../middleware/auth.js';

const router = Router();

// ── GET /users/:userId ───────────────────────────────────────────────────────
// Returns the player_profile row for the given userId.
router.get('/:userId', requirePlayerJwt, async (req, res): Promise<void> => {
    const { userId } = req.params;

    const { data, error } = await supabase
        .from('player_profiles')
        .select('*')
        .eq('user_id', userId)
        .single();

    if (error || !data) {
        res.status(404).json({ error: 'Profile not found' });
        return;
    }

    res.json(data);
});

// ── PATCH /users/:userId ─────────────────────────────────────────────────────
// Update mutable profile fields. Players can only update their own profile.
const UpdateSchema = z.object({
    username: z.string().min(2).max(32).optional(),
    avatar_url: z.string().url().optional(),
});

router.patch('/:userId', requirePlayerJwt, async (req, res): Promise<void> => {
    const { userId } = req.params;

    // Players can only update their own profile
    if (req.userId !== userId) {
        res.status(403).json({ error: 'Cannot update another player\'s profile' });
        return;
    }

    const parsed = UpdateSchema.safeParse(req.body);
    if (!parsed.success) {
        res.status(400).json({ error: parsed.error.flatten() });
        return;
    }

    const { data, error } = await supabase
        .from('player_profiles')
        .update(parsed.data)
        .eq('user_id', userId)
        .select()
        .single();

    if (error || !data) {
        res.status(500).json({ error: error?.message ?? 'Update failed' });
        return;
    }

    res.json(data);
});

export default router;
