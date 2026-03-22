#!/usr/bin/env node
// sync-categories.js
// Usage: SUPABASE_URL=... SUPABASE_SERVICE_KEY=... node sync-categories.js [output-path]

import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync } from "fs";
import { resolve } from "path";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const MIN_SUBMISSIONS = 3;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_KEY");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// Hardcoded baseline keywords (ported from the PWA)
const HARDCODED = {
  meat: ["frango","peixe","carne","picanha","atum","salmão","salmao","ameijoas","gambas","bacalhau","chicken","fish","beef","pork","lamb","shrimp","tuna","salmon"],
  produce: ["alface","tomate","cenoura","cebola","alho","batata","limão","limao","laranja","maçã","maca","banana","coentros","salsa","pepino","pimento","lettuce","tomato","carrot","onion","garlic","potato","lemon","orange","apple","cucumber","pepper","herbs"],
  bakery: ["pão","pao","bolo","croissant","tostas","bread","cake","pastry","toast"],
  dairy: ["queijo","manteiga","iogurte","ovos","natas","cheese","butter","yogurt","eggs","cream"],
  drinks: ["água","agua","sumo","vinho","cerveja","coca","pepsi","refrigerante","water","juice","wine","beer","soda"],
  grocery: []
};

// Special rules (same as PWA)
const SPECIAL_RULES = [
  { pattern: "^leite$", category: "drinks", locale: "pt" },
  { pattern: "leite", category: "dairy", locale: "pt" },
  { pattern: "milk", category: "dairy", locale: "en" }
];

async function main() {
  const outputPath = resolve(process.argv[2] || "../buybye-app/src/data/categories.json");

  // Fetch all submissions
  const { data, error } = await supabase
    .from("category_submissions")
    .select("item_name, category, locale");

  if (error) {
    console.error("Failed to fetch submissions:", error.message);
    process.exit(1);
  }

  // Group by (item_name, locale) and find majority category
  const votes = {};
  for (const row of data) {
    const key = `${row.locale}:${row.item_name}`;
    if (!votes[key]) votes[key] = {};
    votes[key][row.category] = (votes[key][row.category] || 0) + 1;
  }

  // Build crowdsourced additions (only items with >= MIN_SUBMISSIONS)
  const crowdsourced = {};
  for (const [key, cats] of Object.entries(votes)) {
    const totalVotes = Object.values(cats).reduce((a, b) => a + b, 0);
    if (totalVotes < MIN_SUBMISSIONS) continue;

    const topCategory = Object.entries(cats).sort((a, b) => b[1] - a[1])[0][0];
    const itemName = key.split(":").slice(1).join(":");

    if (!crowdsourced[topCategory]) crowdsourced[topCategory] = [];
    crowdsourced[topCategory].push(itemName);
  }

  // Merge: hardcoded takes precedence
  const allHardcodedKeywords = new Set(Object.values(HARDCODED).flat());
  const merged = { ...HARDCODED };
  for (const [cat, items] of Object.entries(crowdsourced)) {
    for (const item of items) {
      if (!allHardcodedKeywords.has(item)) {
        merged[cat].push(item);
      }
    }
  }

  const output = { categories: merged, specialRules: SPECIAL_RULES };
  writeFileSync(outputPath, JSON.stringify(output, null, 2));
  console.log(`Wrote ${outputPath} (${data.length} submissions processed)`);
}

main();
