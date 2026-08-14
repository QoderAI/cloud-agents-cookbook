import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/src/supabase/types";

let adminClient: SupabaseClient<Database> | null = null;

export function getSupabaseAdmin() {
  if (typeof window !== "undefined") {
    throw new Error("Supabase admin access is server-only");
  }
  if (adminClient) return adminClient;

  const url = process.env.SUPABASE_URL?.trim();
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !serviceRoleKey) {
    throw new Error(
      "Meoo persistence is unavailable: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required",
    );
  }

  adminClient = createClient<Database>(url, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
  return adminClient;
}
