import type { Request, Response, NextFunction } from 'express';
import { supabase } from '../supabase.js';

// Extend Express Request to carry verified identity
declare global {
    namespace Express {
        interface Request {
            userId?: string;
        }
    }
}

const INTERNAL_KEY = process.env.PLATFORM_INTERNAL_KEY;

/**
 * Verifies the Supabase JWT in the Authorization: Bearer <token> header.
 * Sets req.userId to the verified Supabase user UUID on success.
 */
export async function requirePlayerJwt(
    req: Request,
    res: Response,
    next: NextFunction
): Promise<void> {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
        res.status(401).json({ error: 'Missing Authorization: Bearer <token>' });
        return;
    }

    const token = header.slice(7);
    const { data, error } = await supabase.auth.getUser(token);

    if (error || !data?.user) {
        res.status(401).json({ error: 'Invalid or expired token' });
        return;
    }

    req.userId = data.user.id;
    next();
}

/**
 * Verifies the X-Internal-Key header used by game servers calling the platform.
 * Never expose this key to browser clients.
 */
export function requireInternalKey(
    req: Request,
    res: Response,
    next: NextFunction
): void {
    const key = req.headers['x-internal-key'];

    if (!INTERNAL_KEY) {
        console.error('[auth] PLATFORM_INTERNAL_KEY is not set — internal routes are locked');
        res.status(503).json({ error: 'Platform misconfigured' });
        return;
    }

    if (key !== INTERNAL_KEY) {
        res.status(403).json({ error: 'Forbidden: invalid internal key' });
        return;
    }

    next();
}
