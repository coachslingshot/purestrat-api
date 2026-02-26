import { createClient } from '@supabase/supabase-js';
import 'dotenv/config';

const supabaseUrl = process.env.SUPABASE_URL!;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!supabaseUrl || !supabaseKey) {
    throw new Error('[Platform] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env');
}

// Service-role client — bypasses RLS, only used server-side
export const supabase = createClient(supabaseUrl, supabaseKey, {
    auth: { persistSession: false },
});
