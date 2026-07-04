import { createClient } from "@supabase/supabase-js";

export const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
export const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  // eslint-disable-next-line no-console
  console.warn(
    "Supabase URL/anon key are missing. Copy .env.example to .env and fill in your project's " +
      "values (see README.md) — the app can't load or save data without them."
  );
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

const TABLE = "league_kv";

// A drop-in replacement for the Claude-artifact "window.storage" API this app was originally
// built against: get/set/delete(key, shared). "shared" data lives in Supabase (visible to
// everyone using the app); "personal" data (shared=false) lives in this browser's localStorage.
export const storage = {
  async get(key, shared) {
    if (!shared) {
      const value = localStorage.getItem(key);
      return value === null ? null : { key, value, shared: false };
    }
    const { data, error } = await supabase.from(TABLE).select("value").eq("key", key).maybeSingle();
    if (error) throw error;
    if (!data) return null;
    return { key, value: data.value, shared: true };
  },

  async set(key, value, shared) {
    if (!shared) {
      localStorage.setItem(key, value);
      return { key, value, shared: false };
    }
    const { error } = await supabase
      .from(TABLE)
      .upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: "key" });
    if (error) throw error;
    return { key, value, shared: true };
  },

  async delete(key, shared) {
    if (!shared) {
      localStorage.removeItem(key);
      return { key, deleted: true, shared: false };
    }
    const { error } = await supabase.from(TABLE).delete().eq("key", key);
    if (error) throw error;
    return { key, deleted: true, shared: true };
  },
};

// Lists keys matching a prefix (used to find nightly auto-backups), newest first.
export async function listByPrefix(prefix) {
  const { data, error } = await supabase
    .from(TABLE)
    .select("key, updated_at")
    .like("key", `${prefix}%`)
    .order("updated_at", { ascending: false });
  if (error) throw error;
  return data || [];
}

// Real-time push updates: fires the instant anyone else's browser saves this key, instead of
// waiting for the next poll. This is the "actual live sync" the artifact version couldn't do.
export function subscribeToKey(key, onChange) {
  const channel = supabase
    .channel(`kv-changes-${key}`)
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: TABLE, filter: `key=eq.${key}` },
      (payload) => {
        const row = payload.new && Object.keys(payload.new).length ? payload.new : payload.old;
        onChange(row);
      }
    )
    .subscribe();

  return () => supabase.removeChannel(channel);
}
