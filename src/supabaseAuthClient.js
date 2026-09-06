// Separate from supabaseClient.js on purpose: this one uses the real
// @supabase/supabase-js SDK because Auth (sessions, token refresh,
// sign-up/sign-in) needs it. Once a customer is signed in, every
// .from()/.rpc() call made through THIS client automatically carries
// their access token, which is what makes the RLS policies on
// orders/order_items actually apply to them.
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "https://mtenqjudpspxwntamgjv.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_BIsAjxfeXUa90vWHV2sRHA_zkwU4whJ";

export const supabaseAuth = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);