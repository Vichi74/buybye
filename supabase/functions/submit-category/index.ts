import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const VALID_CATEGORIES = ["meat", "produce", "bakery", "dairy", "drinks", "grocery"];
const VALID_LOCALES = ["en", "pt"];

serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  try {
    const { item_name, category, locale } = await req.json();

    const trimmed = (item_name ?? "").toString().toLowerCase().trim();
    if (!trimmed) {
      return new Response(JSON.stringify({ error: "item_name is required" }), { status: 400 });
    }
    if (!VALID_CATEGORIES.includes(category)) {
      return new Response(JSON.stringify({ error: "invalid category" }), { status: 400 });
    }
    if (!VALID_LOCALES.includes(locale)) {
      return new Response(JSON.stringify({ error: "invalid locale" }), { status: 400 });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!
    );

    const { error } = await supabase
      .from("category_submissions")
      .insert({ item_name: trimmed, category, locale });

    if (error) {
      return new Response(JSON.stringify({ error: error.message }), { status: 500 });
    }

    return new Response(JSON.stringify({ ok: true }), { status: 201 });
  } catch {
    return new Response(JSON.stringify({ error: "invalid request body" }), { status: 400 });
  }
});
