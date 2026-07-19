import { createClient } from '@supabase/supabase-js'

// Client-side Supabase client using the publishable/anon key — only ever
// used for direct-to-storage uploads from the browser (e.g. incident
// evidence clips). Never use this for data access that should go through
// createAdminClient() on the server.
export const supabaseBrowser = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
)
