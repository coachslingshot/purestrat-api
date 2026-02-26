import { Router } from 'express';
import { z } from 'zod';
import { supabase } from '../supabase.js';
import { requirePlayerJwt } from '../middleware/auth.js';

const router = Router({ mergeParams: true });

// ── GET /users/:userId/friends ───────────────────────────────────────────────
// List all accepted friends for a user.
router.get('/', requirePlayerJwt, async (req, res): Promise<void> => {
    const { userId } = req.params;

    const { data, error } = await supabase
        .from('friends')
        .select(`
            id,
            status,
            created_at,
            friend:friend_id (user_id, username, elo),
            requester:user_id (user_id, username, elo)
        `)
        .or(`user_id.eq.${userId},friend_id.eq.${userId}`)
        .eq('status', 'accepted');

    if (error) {
        res.status(500).json({ error: error.message });
        return;
    }

    // Normalise so the "other" person is always returned as the friend
    const friends = (data ?? []).map((row: Record<string, unknown>) => {
        const friend = row['user_id'] === userId ? row['friend'] : row['requester'];
        return { id: row['id'], friend, since: row['created_at'] };
    });

    res.json(friends);
});

// ── GET /users/:userId/friends/requests ──────────────────────────────────────
// List pending incoming friend requests for the authenticated user (own only).
router.get('/requests', requirePlayerJwt, async (req, res): Promise<void> => {
    const { userId } = req.params;

    if (req.userId !== userId) {
        res.status(403).json({ error: 'Cannot view another player\'s requests' });
        return;
    }

    const { data, error } = await supabase
        .from('friends')
        .select('id, created_at, requester:user_id(user_id, username, elo)')
        .eq('friend_id', userId)
        .eq('status', 'pending');

    if (error) {
        res.status(500).json({ error: error.message });
        return;
    }

    res.json(data ?? []);
});

// ── POST /users/:userId/friends ──────────────────────────────────────────────
// Send a friend request from the authenticated user to :userId.
const AddFriendSchema = z.object({
    friendId: z.string().uuid(),
});

router.post('/', requirePlayerJwt, async (req, res): Promise<void> => {
    const { userId } = req.params;

    if (req.userId !== userId) {
        res.status(403).json({ error: 'Cannot send requests on behalf of another player' });
        return;
    }

    const parsed = AddFriendSchema.safeParse(req.body);
    if (!parsed.success) {
        res.status(400).json({ error: parsed.error.flatten() });
        return;
    }

    const { friendId } = parsed.data;

    if (friendId === userId) {
        res.status(400).json({ error: 'Cannot friend yourself' });
        return;
    }

    const { data, error } = await supabase
        .from('friends')
        .insert({ user_id: userId, friend_id: friendId, status: 'pending' })
        .select()
        .single();

    if (error) {
        // Unique constraint violation = request already exists
        res.status(409).json({ error: 'Friend request already exists' });
        return;
    }

    res.status(201).json(data);
});

// ── PATCH /users/:userId/friends/:friendId ───────────────────────────────────
// Accept or decline an incoming friend request.
const UpdateFriendSchema = z.object({
    status: z.enum(['accepted', 'declined']),
});

router.patch('/:friendId', requirePlayerJwt, async (req, res): Promise<void> => {
    const { userId, friendId } = req.params;

    if (req.userId !== userId) {
        res.status(403).json({ error: 'Cannot update another player\'s requests' });
        return;
    }

    const parsed = UpdateFriendSchema.safeParse(req.body);
    if (!parsed.success) {
        res.status(400).json({ error: parsed.error.flatten() });
        return;
    }

    // Only the recipient (friend_id) can accept/decline
    const { data, error } = await supabase
        .from('friends')
        .update({ status: parsed.data.status })
        .eq('user_id', friendId)
        .eq('friend_id', userId)
        .eq('status', 'pending')
        .select()
        .single();

    if (error || !data) {
        res.status(404).json({ error: 'Pending request not found' });
        return;
    }

    res.json(data);
});

// ── DELETE /users/:userId/friends/:friendId ──────────────────────────────────
// Remove an accepted friendship (either direction).
router.delete('/:friendId', requirePlayerJwt, async (req, res): Promise<void> => {
    const { userId, friendId } = req.params;

    if (req.userId !== userId) {
        res.status(403).json({ error: 'Cannot remove another player\'s friends' });
        return;
    }

    const { error } = await supabase
        .from('friends')
        .delete()
        .or(
            `and(user_id.eq.${userId},friend_id.eq.${friendId}),` +
            `and(user_id.eq.${friendId},friend_id.eq.${userId})`
        );

    if (error) {
        res.status(500).json({ error: error.message });
        return;
    }

    res.status(204).send();
});

export default router;
