# BuyBye Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a native mobile shopping list app (iOS + Android) with ad monetization, a crowdsourced categorization backend, and a marketing landing page.

**Architecture:** Three independent workstreams that can be developed in parallel: (1) Supabase backend for crowdsourced category data, (2) React Native/Expo mobile app, (3) Static landing page at getbuybye.com. The mobile app is fully offline — category data is baked in at build time, not fetched at runtime.

**Tech Stack:** React Native + Expo SDK 52+ (TypeScript), Supabase (Postgres + Edge Functions), static HTML/CSS/JS for landing page, Google AdMob, react-native-iap.

**Spec:** `docs/superpowers/specs/2026-03-22-buybye-mobile-design.md`

---

## Workstream A: Supabase Categorization Backend

> This workstream lives in the existing `buybye` repo under `supabase/`.

### Task A1: Supabase Database Migration

**Files:**
- Create: `supabase/migrations/001_category_submissions.sql`

- [ ] **Step 1: Create migration file**

```sql
-- 001_category_submissions.sql
create table if not exists category_submissions (
  id uuid primary key default gen_random_uuid(),
  item_name text not null,
  category text not null check (category in ('meat', 'produce', 'bakery', 'dairy', 'drinks', 'grocery')),
  locale text not null check (locale in ('en', 'pt')),
  created_at timestamptz not null default now()
);

-- RLS: anonymous users can only INSERT
alter table category_submissions enable row level security;

create policy "anon_insert" on category_submissions
  for insert to anon
  with check (true);

-- No select/update/delete policies for anon = denied by default
-- Note: service_role (used by sync script) bypasses RLS automatically — no explicit SELECT policy needed
```

- [ ] **Step 2: Commit**

```bash
git add supabase/migrations/001_category_submissions.sql
git commit -m "feat: add category_submissions table migration"
```

---

### Task A2: Supabase Edge Function — submit-category

**Files:**
- Create: `supabase/functions/submit-category/index.ts`

- [ ] **Step 1: Create the edge function**

```typescript
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
```

- [ ] **Step 2: Deploy with public access (no JWT verification)**

```bash
supabase functions deploy submit-category --no-verify-jwt
```

Note: `--no-verify-jwt` is required because the mobile app calls this endpoint without authentication. The function is safe for unauthenticated access — it only performs validated INSERTs.

- [ ] **Step 3: Commit**

```bash
git add supabase/functions/submit-category/index.ts
git commit -m "feat: add submit-category edge function"
```

---

### Task A3: Build-Time Sync Script

**Files:**
- Create: `supabase/sync-categories.js`

This script is run manually or in CI before each app release. It reads from Supabase, merges with hardcoded keywords, and outputs `categories.json` for the mobile app.

- [ ] **Step 1: Create the sync script**

```javascript
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
```

- [ ] **Step 2: Add package.json for the sync script**

```bash
# In supabase/ directory
cd supabase && npm init -y && npm install @supabase/supabase-js
```

Add `"type": "module"` to `supabase/package.json`.

- [ ] **Step 3: Commit**

```bash
git add supabase/sync-categories.js supabase/package.json supabase/package-lock.json
git commit -m "feat: add build-time category sync script"
```

---

## Workstream B: React Native Mobile App

> This workstream creates a new repo/directory at `D:/Coding/buybye-app/`.

### Task B1: Expo Project Scaffold

**Files:**
- Create: `D:/Coding/buybye-app/` (entire Expo project)

- [ ] **Step 1: Create the Expo project**

```bash
cd D:/Coding
npx create-expo-app@latest buybye-app --template blank-typescript
cd buybye-app
```

- [ ] **Step 2: Install core dependencies**

```bash
npx expo install @react-native-async-storage/async-storage
npx expo install react-native-gesture-handler
npx expo install react-native-reanimated
npx expo install @gorhom/bottom-sheet
npx expo install jest-expo jest @types/jest
```

- [ ] **Step 2b: Configure Babel for Reanimated**

Update `babel.config.js` (the Reanimated plugin must be listed **last**):

```javascript
module.exports = function(api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
    plugins: ['react-native-reanimated/plugin'],
  };
};
```

- [ ] **Step 2c: Configure Jest**

Add to `package.json`:

```json
"jest": {
  "preset": "jest-expo"
}
```

- [ ] **Step 3: Update app.json with BuyBye metadata**

Set in `app.json`:
- `name`: "BuyBye"
- `slug`: "buybye"
- `version`: "1.0.0"
- `orientation`: "portrait"
- `icon`: (placeholder for now)
- `splash.backgroundColor`: "#2e7d32"
- `ios.bundleIdentifier`: "com.buybye.app"
- `android.package`: "com.buybye.app"
- `android.adaptiveIcon.backgroundColor`: "#2e7d32"

- [ ] **Step 4: Initialize git and commit**

```bash
cd D:/Coding/buybye-app
git init
git add .
git commit -m "chore: scaffold Expo project for BuyBye"
```

---

### Task B2: Categories Data & Detection Logic

**Files:**
- Create: `src/data/categories.json`
- Create: `src/utils/detectCategory.ts`
- Create: `src/utils/__tests__/detectCategory.test.ts`

- [ ] **Step 1: Create categories.json**

Port the keyword lists from the PWA's `index.html` (lines 126-133) into `src/data/categories.json`:

```json
{
  "categories": {
    "meat": ["frango","peixe","carne","picanha","atum","salmão","salmao","ameijoas","gambas","bacalhau","chicken","fish","beef","pork","lamb","shrimp","tuna","salmon"],
    "produce": ["alface","tomate","cenoura","cebola","alho","batata","limão","limao","laranja","maçã","maca","banana","coentros","salsa","pepino","pimento","lettuce","tomato","carrot","onion","garlic","potato","lemon","orange","apple","cucumber","pepper","herbs"],
    "bakery": ["pão","pao","bolo","croissant","tostas","bread","cake","pastry","toast"],
    "dairy": ["queijo","manteiga","iogurte","ovos","natas","cheese","butter","yogurt","eggs","cream"],
    "drinks": ["água","agua","sumo","vinho","cerveja","coca","pepsi","refrigerante","water","juice","wine","beer","soda"],
    "grocery": []
  },
  "specialRules": [
    { "pattern": "^leite$", "category": "drinks", "locale": "pt" },
    { "pattern": "leite", "category": "dairy", "locale": "pt" },
    { "pattern": "milk", "category": "dairy", "locale": "en" }
  ]
}
```

- [ ] **Step 2: Write failing tests for detectCategory**

```typescript
// src/utils/__tests__/detectCategory.test.ts
import { detectCategory } from "../detectCategory";

describe("detectCategory", () => {
  it("detects meat items", () => {
    expect(detectCategory("chicken", "en")).toBe("meat");
    expect(detectCategory("Frango", "pt")).toBe("meat");
  });

  it("detects produce items", () => {
    expect(detectCategory("tomato", "en")).toBe("produce");
    expect(detectCategory("Alface", "pt")).toBe("produce");
  });

  it("detects bakery items", () => {
    expect(detectCategory("bread", "en")).toBe("bakery");
    expect(detectCategory("Pão", "pt")).toBe("bakery");
  });

  it("detects dairy items", () => {
    expect(detectCategory("cheese", "en")).toBe("dairy");
    expect(detectCategory("leite gordo", "pt")).toBe("dairy");
  });

  it("detects drinks", () => {
    expect(detectCategory("water", "en")).toBe("drinks");
    expect(detectCategory("leite", "pt")).toBe("drinks"); // exact "leite" = drinks
  });

  it("returns null for unknown items", () => {
    expect(detectCategory("paper towels", "en")).toBeNull();
    expect(detectCategory("", "en")).toBeNull();
  });

  it("filters special rules by locale", () => {
    // "milk" rule is locale: "en" — should not match in PT mode via special rules
    // but "milk" is not in any keyword list either, so returns null
    expect(detectCategory("milk", "pt")).toBeNull();
    expect(detectCategory("milk", "en")).toBe("dairy");
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

```bash
npx jest src/utils/__tests__/detectCategory.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 4: Implement detectCategory**

```typescript
// src/utils/detectCategory.ts
import categoriesData from "../data/categories.json";
import { Locale } from "../types";

const { categories, specialRules } = categoriesData;

/**
 * Detects the category for an item name.
 * Returns the category key if a match is found, or null if unknown.
 * Null means "show the category picker" — the caller decides the fallback.
 */
export function detectCategory(name: string, locale: Locale): string | null {
  const lower = name.toLowerCase().trim();
  if (!lower) return null;

  // Check special rules first (order matters, filtered by locale)
  for (const rule of specialRules) {
    if (rule.locale !== locale) continue;
    const regex = new RegExp(rule.pattern, "i");
    if (regex.test(lower)) return rule.category;
  }

  // Check keyword lists
  for (const [cat, keywords] of Object.entries(categories)) {
    if (cat === "grocery") continue;
    for (const kw of keywords) {
      if (lower.includes(kw)) return cat;
    }
  }

  return null;
}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
npx jest src/utils/__tests__/detectCategory.test.ts
```

Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add src/data/categories.json src/utils/detectCategory.ts src/utils/__tests__/detectCategory.test.ts
git commit -m "feat: add category detection logic with keyword matching"
```

---

### Task B3: Storage Layer

**Files:**
- Create: `src/storage/items.ts`
- Create: `src/storage/settings.ts`
- Create: `src/types.ts`

- [ ] **Step 1: Define types**

```typescript
// src/types.ts
export interface ShopItem {
  id: string;
  name: string;
  category: string;
  checked: boolean;
  checkedAt: number | null;
}

export type CategoryKey = "meat" | "produce" | "bakery" | "dairy" | "drinks" | "grocery";
export type Locale = "en" | "pt";
```

- [ ] **Step 2: Implement items storage**

```typescript
// src/storage/items.ts
import AsyncStorage from "@react-native-async-storage/async-storage";
import { ShopItem } from "../types";

const STORAGE_KEY = "buybye-items-v1";

export async function loadItems(): Promise<ShopItem[]> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export async function saveItems(items: ShopItem[]): Promise<void> {
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(items));
}

export function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}
```

- [ ] **Step 3: Implement settings storage**

```typescript
// src/storage/settings.ts
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Locale } from "../types";

const LANG_KEY = "buybye-lang";
const ADS_KEY = "buybye-ads-removed";

export async function loadLocale(): Promise<Locale> {
  const val = await AsyncStorage.getItem(LANG_KEY);
  return val === "pt" ? "pt" : "en";
}

export async function saveLocale(locale: Locale): Promise<void> {
  await AsyncStorage.setItem(LANG_KEY, locale);
}

export async function isAdsRemoved(): Promise<boolean> {
  return (await AsyncStorage.getItem(ADS_KEY)) === "true";
}

export async function setAdsRemoved(removed: boolean): Promise<void> {
  await AsyncStorage.setItem(ADS_KEY, removed ? "true" : "false");
}
```

- [ ] **Step 4: Commit**

```bash
git add src/types.ts src/storage/items.ts src/storage/settings.ts
git commit -m "feat: add storage layer for items and settings"
```

---

### Task B4: Translations

**Files:**
- Create: `src/i18n/translations.ts`

- [ ] **Step 1: Create translations file**

Port from PWA's `index.html` (lines 77-106):

```typescript
// src/i18n/translations.ts
import { Locale } from "../types";

const translations = {
  en: {
    appName: "BuyBye",
    placeholder: "Add item...",
    add: "Add",
    done: (n: number) => `Done (${n})`,
    delete: "Delete",
    settings: "Settings",
    language: "Language",
    removeAds: "Remove Ads — $0.99",
    restorePurchases: "Restore Purchases",
    pickCategory: "Pick a category",
    categories: {
      meat: "Meat & Fish",
      produce: "Produce",
      bakery: "Bakery",
      dairy: "Dairy & Eggs",
      drinks: "Drinks",
      grocery: "Grocery",
    },
    categoryEmojis: {
      meat: "\u{1F969}",
      produce: "\u{1F966}",
      bakery: "\u{1F35E}",
      dairy: "\u{1F9C0}",
      drinks: "\u{1F964}",
      grocery: "\u{1F6D2}",
    },
  },
  pt: {
    appName: "BuyBye",
    placeholder: "Adicionar item...",
    add: "Adicionar",
    done: (n: number) => `Feito (${n})`,
    delete: "Apagar",
    settings: "Definições",
    language: "Idioma",
    removeAds: "Remover Anúncios — 0,99$",
    restorePurchases: "Restaurar Compras",
    pickCategory: "Escolha uma categoria",
    categories: {
      meat: "Carne & Peixe",
      produce: "Legumes & Frescos",
      bakery: "Padaria",
      dairy: "Laticínios & Ovos",
      drinks: "Bebidas",
      grocery: "Mercearia",
    },
    categoryEmojis: {
      meat: "\u{1F969}",
      produce: "\u{1F966}",
      bakery: "\u{1F35E}",
      dairy: "\u{1F9C0}",
      drinks: "\u{1F964}",
      grocery: "\u{1F6D2}",
    },
  },
} as const;

export function t(locale: Locale) {
  return translations[locale];
}
```

- [ ] **Step 2: Commit**

```bash
git add src/i18n/translations.ts
git commit -m "feat: add bilingual translations (EN/PT)"
```

---

### Task B5: Main Shopping List Screen

**Files:**
- Create: `src/components/Header.tsx`
- Create: `src/components/ItemInput.tsx`
- Create: `src/components/ShopItemRow.tsx`
- Create: `src/components/CategorySection.tsx`
- Create: `src/components/DoneSection.tsx`
- Create: `src/components/CategoryPicker.tsx`
- Modify: `App.tsx`

- [ ] **Step 1: Build Header component**

```typescript
// src/components/Header.tsx
import React from "react";
import { View, Text, TouchableOpacity, Image, StyleSheet } from "react-native";
import { Locale } from "../types";

interface Props {
  locale: Locale;
  onToggleLocale: () => void;
  onOpenSettings?: () => void;
}

export function Header({ locale, onToggleLocale, onOpenSettings }: Props) {
  return (
    <View style={styles.header}>
      <Text style={styles.title}>BuyBye</Text>
      <View style={{ flexDirection: "row", gap: 8 }}>
        <TouchableOpacity onPress={onToggleLocale} style={styles.langBtn}>
          <Text style={styles.langText}>{locale === "en" ? "🇺🇸" : "🇵🇹"}</Text>
        </TouchableOpacity>
        {onOpenSettings && (
          <TouchableOpacity onPress={onOpenSettings} style={styles.langBtn}>
            <Text style={styles.langText}>⚙️</Text>
          </TouchableOpacity>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    backgroundColor: "#2e7d32",
    paddingHorizontal: 16,
    paddingVertical: 12,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  title: { color: "#fff", fontSize: 20, fontWeight: "bold" },
  langBtn: { padding: 4 },
  langText: { fontSize: 24 },
});
```

- [ ] **Step 2: Build ItemInput component**

```typescript
// src/components/ItemInput.tsx
import React, { useState } from "react";
import { View, TextInput, TouchableOpacity, Text, StyleSheet } from "react-native";

interface Props {
  placeholder: string;
  addLabel: string;
  onAdd: (name: string) => void;
}

export function ItemInput({ placeholder, addLabel, onAdd }: Props) {
  const [text, setText] = useState("");

  const handleAdd = () => {
    if (text.trim()) {
      onAdd(text.trim());
      setText("");
    }
  };

  return (
    <View style={styles.row}>
      <TextInput
        style={styles.input}
        placeholder={placeholder}
        value={text}
        onChangeText={setText}
        onSubmitEditing={handleAdd}
        returnKeyType="done"
      />
      <TouchableOpacity style={styles.btn} onPress={handleAdd}>
        <Text style={styles.btnText}>{addLabel}</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
    backgroundColor: "#2e7d32",
  },
  input: {
    flex: 1,
    backgroundColor: "#fff",
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
  },
  btn: {
    backgroundColor: "#1b5e20",
    borderRadius: 8,
    paddingHorizontal: 18,
    justifyContent: "center",
  },
  btnText: { color: "#fff", fontSize: 16, fontWeight: "600" },
});
```

- [ ] **Step 3: Build ShopItemRow with swipe-to-delete and long-press-to-delete**

```typescript
// src/components/ShopItemRow.tsx
import React from "react";
import { View, Text, TouchableOpacity, StyleSheet } from "react-native";
import { Gesture, GestureDetector, LongPressGestureHandler, State } from "react-native-gesture-handler";
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  runOnJS,
} from "react-native-reanimated";
import { ShopItem } from "../types";

interface Props {
  item: ShopItem;
  deleteLabel: string;
  onToggle: (id: string) => void;
  onDelete: (id: string) => void;
  isDone?: boolean;
}

export function ShopItemRow({ item, deleteLabel, onToggle, onDelete, isDone }: Props) {
  const translateX = useSharedValue(0);

  const pan = Gesture.Pan()
    .onUpdate((e) => {
      if (e.translationX < 0) {
        translateX.value = Math.max(e.translationX, -80);
      }
    })
    .onEnd(() => {
      if (translateX.value < -40) {
        translateX.value = withSpring(-80);
      } else {
        translateX.value = withSpring(0);
      }
    });

  const animStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value }],
  }));

  const longPress = Gesture.LongPress()
    .minDuration(500)
    .onEnd((_e, success) => {
      if (success) runOnJS(onDelete)(item.id);
    });

  const composed = Gesture.Race(pan, longPress);

  return (
    <View style={styles.container}>
      <TouchableOpacity
        style={styles.deleteBtn}
        onPress={() => onDelete(item.id)}
      >
        <Text style={styles.deleteText}>{deleteLabel}</Text>
      </TouchableOpacity>
      <GestureDetector gesture={composed}>
        <Animated.View style={[styles.row, animStyle]}>
          <TouchableOpacity
            style={[styles.check, item.checked && styles.checked, isDone && styles.checkDone]}
            onPress={() => onToggle(item.id)}
          >
            {item.checked && <Text style={styles.checkmark}>✓</Text>}
          </TouchableOpacity>
          <Text style={[styles.name, item.checked && styles.struck, isDone && styles.nameDone]}>
            {item.name}
          </Text>
        </Animated.View>
      </GestureDetector>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { position: "relative", overflow: "hidden" },
  row: {
    flexDirection: "row",
    alignItems: "center",
    padding: 12,
    paddingHorizontal: 14,
    backgroundColor: "#fff",
    borderBottomWidth: 1,
    borderBottomColor: "#eee",
  },
  check: {
    width: 24,
    height: 24,
    borderRadius: 12,
    borderWidth: 2,
    borderColor: "#2e7d32",
    marginRight: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  checked: { backgroundColor: "#2e7d32" },
  checkDone: { borderColor: "#aaa", backgroundColor: "#aaa" },
  checkmark: { color: "#fff", fontSize: 14, fontWeight: "bold" },
  name: { flex: 1, fontSize: 16 },
  struck: { textDecorationLine: "line-through", color: "#999" },
  nameDone: { color: "#aaa", textDecorationLine: "line-through" },
  deleteBtn: {
    position: "absolute",
    right: 0,
    top: 0,
    bottom: 0,
    width: 80,
    backgroundColor: "#e53935",
    alignItems: "center",
    justifyContent: "center",
  },
  deleteText: { color: "#fff", fontWeight: "600", fontSize: 14 },
});
```

- [ ] **Step 4: Build CategorySection**

```typescript
// src/components/CategorySection.tsx
import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { ShopItemRow } from "./ShopItemRow";
import { ShopItem } from "../types";

interface Props {
  title: string;
  emoji: string;
  items: ShopItem[];
  deleteLabel: string;
  onToggle: (id: string) => void;
  onDelete: (id: string) => void;
}

export function CategorySection({ title, emoji, items, deleteLabel, onToggle, onDelete }: Props) {
  if (!items.length) return null;
  return (
    <View style={styles.section}>
      <Text style={styles.title}>{emoji} {title}</Text>
      <View style={styles.card}>
        {items.map((item) => (
          <ShopItemRow
            key={item.id}
            item={item}
            deleteLabel={deleteLabel}
            onToggle={onToggle}
            onDelete={onDelete}
          />
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  section: { marginTop: 12 },
  title: {
    fontSize: 14,
    fontWeight: "700",
    color: "#555",
    paddingHorizontal: 8,
    paddingVertical: 4,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  card: { backgroundColor: "#fff", borderRadius: 10, marginTop: 6, overflow: "hidden" },
});
```

- [ ] **Step 5: Build DoneSection**

```typescript
// src/components/DoneSection.tsx
import React, { useState } from "react";
import { View, Text, TouchableOpacity, StyleSheet } from "react-native";
import { ShopItemRow } from "./ShopItemRow";
import { ShopItem } from "../types";

interface Props {
  items: ShopItem[];
  label: string;
  deleteLabel: string;
  onToggle: (id: string) => void;
  onDelete: (id: string) => void;
}

export function DoneSection({ items, label, deleteLabel, onToggle, onDelete }: Props) {
  const [open, setOpen] = useState(false);
  if (!items.length) return null;

  return (
    <View style={styles.section}>
      <TouchableOpacity onPress={() => setOpen(!open)} style={styles.header}>
        <Text style={styles.arrow}>{open ? "▾" : "▸"}</Text>
        <Text style={styles.label}>{label}</Text>
      </TouchableOpacity>
      {open && (
        <View style={styles.card}>
          {items.map((item) => (
            <ShopItemRow
              key={item.id}
              item={item}
              deleteLabel={deleteLabel}
              onToggle={onToggle}
              onDelete={onDelete}
              isDone
            />
          ))}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  section: { marginTop: 20 },
  header: { flexDirection: "row", alignItems: "center", padding: 8 },
  arrow: { color: "#777", fontSize: 14, marginRight: 6 },
  label: { color: "#777", fontSize: 14, fontWeight: "600" },
  card: { backgroundColor: "#fafafa", borderRadius: 10, marginTop: 6, overflow: "hidden" },
});
```

- [ ] **Step 6: Build CategoryPicker bottom sheet**

```typescript
// src/components/CategoryPicker.tsx
import React, { useCallback, useMemo, forwardRef } from "react";
import { View, Text, TouchableOpacity, StyleSheet } from "react-native";
import BottomSheet, { BottomSheetBackdrop } from "@gorhom/bottom-sheet";
import { CategoryKey, Locale } from "../types";
import { t } from "../i18n/translations";

interface Props {
  locale: Locale;
  onPick: (category: CategoryKey) => void;
  onDismiss: () => void;
}

const CATEGORY_KEYS: CategoryKey[] = ["meat", "produce", "bakery", "dairy", "drinks", "grocery"];

export const CategoryPicker = forwardRef<BottomSheet, Props>(
  ({ locale, onPick, onDismiss }, ref) => {
    const snapPoints = useMemo(() => ["35%"], []);
    const strings = t(locale);

    const renderBackdrop = useCallback(
      (props: any) => (
        <BottomSheetBackdrop {...props} disappearsOnIndex={-1} appearsOnIndex={0} />
      ),
      []
    );

    return (
      <BottomSheet
        ref={ref}
        index={-1}
        snapPoints={snapPoints}
        enablePanDownToClose
        onClose={onDismiss}
        backdropComponent={renderBackdrop}
      >
        <View style={styles.content}>
          <Text style={styles.title}>{strings.pickCategory}</Text>
          <View style={styles.grid}>
            {CATEGORY_KEYS.map((key) => (
              <TouchableOpacity
                key={key}
                style={styles.option}
                onPress={() => onPick(key)}
              >
                <Text style={styles.emoji}>{strings.categoryEmojis[key]}</Text>
                <Text style={styles.catName}>{strings.categories[key]}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>
      </BottomSheet>
    );
  }
);

const styles = StyleSheet.create({
  content: { padding: 16 },
  title: { fontSize: 16, fontWeight: "600", textAlign: "center", marginBottom: 16 },
  grid: { flexDirection: "row", flexWrap: "wrap", justifyContent: "space-around" },
  option: { alignItems: "center", width: "30%", marginBottom: 16, padding: 8 },
  emoji: { fontSize: 32 },
  catName: { fontSize: 12, marginTop: 4, color: "#555", textAlign: "center" },
});
```

- [ ] **Step 7: Wire everything in App.tsx**

```typescript
// App.tsx
import React, { useState, useEffect, useCallback, useRef } from "react";
import { SafeAreaView, ScrollView, StatusBar, StyleSheet, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import BottomSheet from "@gorhom/bottom-sheet";
import { Header } from "./src/components/Header";
import { ItemInput } from "./src/components/ItemInput";
import { CategorySection } from "./src/components/CategorySection";
import { DoneSection } from "./src/components/DoneSection";
import { CategoryPicker } from "./src/components/CategoryPicker";
import { loadItems, saveItems, generateId } from "./src/storage/items";
import { loadLocale, saveLocale } from "./src/storage/settings";
import { detectCategory } from "./src/utils/detectCategory";
import { t } from "./src/i18n/translations";
import { ShopItem, CategoryKey, Locale } from "./src/types";
import { submitCategory } from "./src/api/submitCategory";

const ONE_HOUR = 3600000;
const CATEGORY_ORDER: CategoryKey[] = ["meat", "produce", "bakery", "dairy", "drinks", "grocery"];

export default function App() {
  const [items, setItems] = useState<ShopItem[]>([]);
  const [locale, setLocale] = useState<Locale>("en");
  const [pendingItem, setPendingItem] = useState<string | null>(null);
  const bottomSheetRef = useRef<BottomSheet>(null);

  useEffect(() => {
    (async () => {
      setItems(await loadItems());
      setLocale(await loadLocale());
    })();
  }, []);

  useEffect(() => {
    saveItems(items);
  }, [items]);

  const strings = t(locale);

  const toggleLocale = useCallback(() => {
    const next = locale === "en" ? "pt" : "en";
    setLocale(next);
    saveLocale(next);
  }, [locale]);

  const addItem = useCallback(
    (name: string) => {
      const category = detectCategory(name, locale);
      if (category === null) {
        // Unknown item — ask user to categorize
        setPendingItem(name);
        bottomSheetRef.current?.snapToIndex(0);
      } else {
        const newItem: ShopItem = {
          id: generateId(),
          name,
          category,
          checked: false,
          checkedAt: null,
        };
        setItems((prev) => [...prev, newItem]);
      }
    },
    [locale]
  );

  const onCategoryPicked = useCallback(
    (category: CategoryKey) => {
      if (!pendingItem) return;
      const newItem: ShopItem = {
        id: generateId(),
        name: pendingItem,
        category,
        checked: false,
        checkedAt: null,
      };
      setItems((prev) => [...prev, newItem]);
      // Fire and forget — send to Supabase
      submitCategory(pendingItem, category, locale).catch(() => {});
      setPendingItem(null);
      bottomSheetRef.current?.close();
    },
    [pendingItem, locale]
  );

  const onPickerDismiss = useCallback(() => {
    if (pendingItem) {
      // Dismissed without picking — add as grocery, no Supabase POST
      const newItem: ShopItem = {
        id: generateId(),
        name: pendingItem,
        category: "grocery",
        checked: false,
        checkedAt: null,
      };
      setItems((prev) => [...prev, newItem]);
      setPendingItem(null);
    }
  }, [pendingItem]);

  const toggleItem = useCallback((id: string) => {
    setItems((prev) =>
      prev.map((i) =>
        i.id === id
          ? { ...i, checked: !i.checked, checkedAt: !i.checked ? Date.now() : null }
          : i
      )
    );
  }, []);

  const deleteItem = useCallback((id: string) => {
    setItems((prev) => prev.filter((i) => i.id !== id));
  }, []);

  const isInDone = (item: ShopItem) =>
    item.checked && item.checkedAt != null && Date.now() - item.checkedAt >= ONE_HOUR;

  const active = items.filter((i) => !isInDone(i));
  const done = items.filter((i) => isInDone(i));

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaView style={styles.container}>
        <StatusBar backgroundColor="#2e7d32" barStyle="light-content" />
        <Header locale={locale} onToggleLocale={toggleLocale} />
        <ItemInput
          placeholder={strings.placeholder}
          addLabel={strings.add}
          onAdd={addItem}
        />
        <ScrollView style={styles.list} contentContainerStyle={{ paddingBottom: 80 }}>
          {CATEGORY_ORDER.map((cat) => {
            const catItems = active
              .filter((i) => i.category === cat)
              .sort((a, b) => (a.checked ? 1 : 0) - (b.checked ? 1 : 0));
            return (
              <CategorySection
                key={cat}
                title={strings.categories[cat]}
                emoji={strings.categoryEmojis[cat]}
                items={catItems}
                deleteLabel={strings.delete}
                onToggle={toggleItem}
                onDelete={deleteItem}
              />
            );
          })}
          <DoneSection
            items={done}
            label={strings.done(done.length)}
            deleteLabel={strings.delete}
            onToggle={toggleItem}
            onDelete={deleteItem}
          />
        </ScrollView>
        <CategoryPicker
          ref={bottomSheetRef}
          locale={locale}
          onPick={onCategoryPicked}
          onDismiss={onPickerDismiss}
        />
      </SafeAreaView>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#f0f0f0" },
  list: { flex: 1, paddingHorizontal: 12 },
});
```

- [ ] **Step 8: Commit**

```bash
git add src/components/ App.tsx
git commit -m "feat: add main shopping list UI with all components"
```

---

### Task B6: Supabase API Client

**Files:**
- Create: `src/api/submitCategory.ts`
- Create: `src/api/config.ts`

- [ ] **Step 1: Create config**

```typescript
// src/api/config.ts
// In production, these come from EAS secrets injected into app.json extra field
export const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL ?? "";
export const SUPABASE_ANON_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? "";
```

- [ ] **Step 2: Create submitCategory**

```typescript
// src/api/submitCategory.ts
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config";
import { CategoryKey, Locale } from "../types";

export async function submitCategory(
  itemName: string,
  category: CategoryKey,
  locale: Locale
): Promise<void> {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return; // Not configured — skip silently

  const url = `${SUPABASE_URL}/functions/v1/submit-category`;
  await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "apikey": SUPABASE_ANON_KEY,
    },
    body: JSON.stringify({
      item_name: itemName.toLowerCase().trim(),
      category,
      locale,
    }),
  });
}
```

- [ ] **Step 3: Commit**

```bash
git add src/api/
git commit -m "feat: add Supabase category submission API client"
```

---

### Task B7: AdMob Integration

**Files:**
- Modify: `app.json` (add AdMob plugin config)
- Create: `src/components/AdBanner.tsx`
- Modify: `App.tsx` (add ad banner)

- [ ] **Step 1: Install AdMob package**

```bash
npx expo install react-native-google-mobile-ads
```

- [ ] **Step 2: Update app.json with AdMob plugin**

Add to `app.json` under `expo.plugins`:

```json
[
  "react-native-google-mobile-ads",
  {
    "androidAppId": "ca-app-pub-xxxxxxxxxxxxxxxx~yyyyyyyyyy",
    "iosAppId": "ca-app-pub-xxxxxxxxxxxxxxxx~zzzzzzzzzz"
  }
]
```

Note: Use test App IDs during development. Replace with real IDs from AdMob console before production build.

- [ ] **Step 3: Create AdBanner component**

```typescript
// src/components/AdBanner.tsx
import React from "react";
import { View, StyleSheet } from "react-native";
import { BannerAd, BannerAdSize, TestIds } from "react-native-google-mobile-ads";

const AD_UNIT_ID = __DEV__
  ? TestIds.BANNER
  : "ca-app-pub-xxxxxxxxxxxxxxxx/yyyyyyyyyy"; // Replace with real ad unit ID

interface Props {
  visible: boolean;
}

export function AdBanner({ visible }: Props) {
  if (!visible) return null;

  return (
    <View style={styles.container}>
      <BannerAd
        unitId={AD_UNIT_ID}
        size={BannerAdSize.ANCHORED_ADAPTIVE_BANNER}
        requestOptions={{ requestNonPersonalizedAdsOnly: true }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    alignItems: "center",
  },
});
```

- [ ] **Step 4: Add AdBanner to App.tsx**

Import `AdBanner` and `isAdsRemoved` from settings. Add state `showAds` (default `true`). Load `isAdsRemoved()` in the initial `useEffect`. Render `<AdBanner visible={showAds} />` after the ScrollView.

- [ ] **Step 5: Commit**

```bash
git add app.json src/components/AdBanner.tsx App.tsx
git commit -m "feat: add AdMob banner integration"
```

---

### Task B8: In-App Purchase (Remove Ads)

**Files:**
- Create: `src/iap/purchase.ts`
- Modify: `App.tsx` (add remove ads flow)

Note: This requires EAS Build — cannot be tested in Expo Go. Setup requires Apple IAP entitlement in App Store Connect and Google Play billing setup with a published APK on the Play Console.

- [ ] **Step 1: Install react-native-iap v8+**

```bash
npx expo install react-native-iap@8
```

- [ ] **Step 2: Create purchase module**

```typescript
// src/iap/purchase.ts
import {
  initConnection,
  getProducts,
  requestPurchase,
  finishTransaction,
  purchaseUpdatedListener,
  purchaseErrorListener,
  getAvailablePurchases,
  Product,
  Purchase,
} from "react-native-iap";
import { Platform } from "react-native";
import { setAdsRemoved } from "../storage/settings";

const PRODUCT_ID = Platform.select({
  ios: "com.buybye.removeads",
  android: "remove_ads",
}) as string;

export async function initIAP(): Promise<void> {
  await initConnection();
}

export async function getRemoveAdsProduct(): Promise<Product | null> {
  const products = await getProducts({ skus: [PRODUCT_ID] });
  return products[0] ?? null;
}

export async function purchaseRemoveAds(): Promise<void> {
  if (Platform.OS === "ios") {
    await requestPurchase({ sku: PRODUCT_ID });
  } else {
    await requestPurchase({ skus: [PRODUCT_ID] });
  }
}

export async function restorePurchases(): Promise<boolean> {
  const purchases = await getAvailablePurchases();
  const found = purchases.some((p) => p.productId === PRODUCT_ID);
  if (found) {
    await setAdsRemoved(true);
  }
  return found;
}

export function setupPurchaseListeners(
  onSuccess: () => void,
  onError: (msg: string) => void
) {
  const purchaseSub = purchaseUpdatedListener(async (purchase: Purchase) => {
    await finishTransaction({ purchase });
    await setAdsRemoved(true);
    onSuccess();
  });

  const errorSub = purchaseErrorListener((error) => {
    onError(error.message);
  });

  return () => {
    purchaseSub.remove();
    errorSub.remove();
  };
}
```

- [ ] **Step 3: Create SettingsModal component**

Create `src/components/SettingsModal.tsx` — a simple modal triggered by the gear icon in Header. Contains:
- "Remove Ads — $0.99" button (visible when `showAds` is true) — calls `purchaseRemoveAds()`
- "Restore Purchases" button — calls `restorePurchases()`, shows alert on success/failure

```typescript
// src/components/SettingsModal.tsx
import React from "react";
import { Modal, View, Text, TouchableOpacity, StyleSheet, Alert } from "react-native";
import { purchaseRemoveAds, restorePurchases } from "../iap/purchase";
import { Locale } from "../types";
import { t } from "../i18n/translations";

interface Props {
  visible: boolean;
  locale: Locale;
  showAds: boolean;
  onClose: () => void;
  onAdsRemoved: () => void;
}

export function SettingsModal({ visible, locale, showAds, onClose, onAdsRemoved }: Props) {
  const strings = t(locale);

  const handleRemoveAds = async () => {
    try {
      await purchaseRemoveAds();
    } catch (e) {
      Alert.alert("Error", String(e));
    }
  };

  const handleRestore = async () => {
    try {
      const found = await restorePurchases();
      if (found) {
        onAdsRemoved();
        Alert.alert("Success", "Purchases restored!");
      } else {
        Alert.alert("Not found", "No previous purchase found.");
      }
    } catch (e) {
      Alert.alert("Error", String(e));
    }
  };

  return (
    <Modal visible={visible} animationType="slide" transparent>
      <View style={styles.overlay}>
        <View style={styles.sheet}>
          <Text style={styles.title}>{strings.settings}</Text>
          {showAds && (
            <TouchableOpacity style={styles.btn} onPress={handleRemoveAds}>
              <Text style={styles.btnText}>{strings.removeAds}</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity style={styles.btn} onPress={handleRestore}>
            <Text style={styles.btnText}>{strings.restorePurchases}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.closeBtn} onPress={onClose}>
            <Text style={styles.closeBtnText}>✕</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(0,0,0,0.4)" },
  sheet: { backgroundColor: "#fff", borderTopLeftRadius: 16, borderTopRightRadius: 16, padding: 24 },
  title: { fontSize: 18, fontWeight: "bold", marginBottom: 16 },
  btn: { backgroundColor: "#2e7d32", borderRadius: 8, padding: 14, marginBottom: 10, alignItems: "center" },
  btnText: { color: "#fff", fontSize: 16, fontWeight: "600" },
  closeBtn: { alignItems: "center", padding: 12 },
  closeBtnText: { fontSize: 20, color: "#999" },
});
```

- [ ] **Step 4: Wire IAP and SettingsModal into App.tsx**

In `App.tsx`:
- Add state: `showSettings` (boolean), `showAds` (boolean, default `true`)
- Call `initIAP()` in the initial `useEffect`
- Call `setupPurchaseListeners()` to handle purchase completion (set `showAds = false`)
- Load `isAdsRemoved()` in the initial `useEffect` to set `showAds`
- Pass `onOpenSettings={() => setShowSettings(true)}` to Header
- Render `<SettingsModal>` with the appropriate props

- [ ] **Step 5: Commit**

```bash
git add src/iap/purchase.ts App.tsx
git commit -m "feat: add in-app purchase for ad removal"
```

---

### Task B9: EAS Build Configuration

**Files:**
- Create: `eas.json`
- Modify: `.gitignore`

- [ ] **Step 1: Install EAS CLI and configure**

```bash
npm install -g eas-cli
cd D:/Coding/buybye-app
eas init
```

- [ ] **Step 2: Create eas.json**

```json
{
  "cli": { "version": ">= 5.0.0" },
  "build": {
    "development": {
      "developmentClient": true,
      "distribution": "internal"
    },
    "preview": {
      "distribution": "internal"
    },
    "production": {}
  },
  "submit": {
    "production": {
      "ios": { "appleId": "YOUR_APPLE_ID", "ascAppId": "YOUR_ASC_APP_ID" },
      "android": { "serviceAccountKeyPath": "./google-services.json" }
    }
  }
}
```

- [ ] **Step 3: Update .gitignore**

Add `google-services.json`, `.env.local`, and any local secret files.

- [ ] **Step 4: Create .env.local for local development (gitignored)**

```bash
# .env.local — not committed
EXPO_PUBLIC_SUPABASE_URL=https://YOUR_PROJECT.supabase.co
EXPO_PUBLIC_SUPABASE_ANON_KEY=YOUR_ANON_KEY
```

- [ ] **Step 5: Set EAS secrets for production builds**

```bash
eas secret:create --scope project --name EXPO_PUBLIC_SUPABASE_URL --value "https://YOUR_PROJECT.supabase.co"
eas secret:create --scope project --name EXPO_PUBLIC_SUPABASE_ANON_KEY --value "YOUR_ANON_KEY"
```

- [ ] **Step 6: Commit**

```bash
git add eas.json .gitignore
git commit -m "chore: add EAS build configuration"
```

---

### Task B10: Create GitHub Repo & Push

- [ ] **Step 1: Create repo on GitHub**

```bash
cd D:/Coding/buybye-app
gh repo create Vichi74/buybye-app --public --source=. --push
```

- [ ] **Step 2: Verify push**

```bash
git log --oneline
```

---

## Workstream C: Landing Page

> This workstream creates a new repo/directory at `D:/Coding/buybye-website/`.

### Task C1: Landing Page Design & Build

**Files:**
- Create: `D:/Coding/buybye-website/index.html`
- Create: `D:/Coding/buybye-website/privacy.html`

- [ ] **Step 1: Use the `frontend-design` skill**

Invoke `frontend-design` with this brief:

> Build a polished, modern marketing landing page for BuyBye — a simple shopping list mobile app. Sections: Hero (app name, tagline "The simplest shopping list", phone mockup, App Store + Play Store download buttons), Features (auto-categorization, swipe to delete, no account needed, bilingual EN/PT), How It Works (3-step: add item, auto-sorted, shop & check off), Download CTA (repeat buttons, "Free with ads / $0.99 ad-free"), Footer (privacy policy link, contact). Theme: green (#2e7d32) accent but modern marketing aesthetic, not flat PWA. Single HTML file with inline CSS/JS. Mobile-responsive.

- [ ] **Step 2: Create privacy policy page**

```html
<!-- privacy.html -->
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>BuyBye — Privacy Policy</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 640px; margin: 40px auto; padding: 0 20px; line-height: 1.6; color: #333; }
    h1 { color: #2e7d32; }
  </style>
</head>
<body>
  <h1>Privacy Policy</h1>
  <p><strong>Last updated:</strong> March 2026</p>
  <h2>What we collect</h2>
  <p>When you add an item that isn't automatically categorized, you may choose a category for it. If you do, the item name and chosen category are sent anonymously to our server to improve categorization for all users. No personal information, account data, or device identifiers are collected.</p>
  <h2>What we don't collect</h2>
  <p>We do not collect your shopping list, personal data, location, contacts, or any other information. Your shopping list is stored only on your device.</p>
  <h2>Ads</h2>
  <p>The free version shows ads via Google AdMob. AdMob may collect device identifiers for ad targeting per Google's privacy policy. You can remove ads with a one-time $0.99 purchase.</p>
  <h2>Contact</h2>
  <p>Questions? Email us at privacy@getbuybye.com</p>
</body>
</html>
```

- [ ] **Step 3: Initialize git and commit**

```bash
cd D:/Coding/buybye-website
git init
git add .
git commit -m "feat: add landing page and privacy policy"
```

- [ ] **Step 4: Create GitHub repo and push**

```bash
gh repo create Vichi74/buybye-website --public --source=. --push
```

---

## Execution Order

The three workstreams are fully independent and can be developed in parallel:

| Workstream | Tasks | Dependencies |
|-----------|-------|--------------|
| A: Supabase Backend | A1 → A2 → A3 | None |
| B: Mobile App | B1 → B2 → B3 → B4 → B5 → B6 → B7 → B8 → B9 → B10 | None (B6 references Supabase URL but works without it) |
| C: Landing Page | C1 | None |

**Post-development (manual steps by the user):**
1. Create Supabase project and run migration
2. Deploy edge function
3. Create Apple Developer Account ($99/year) and Google Play Developer Account ($25)
4. Set up AdMob app and ad units
5. Configure IAP products in App Store Connect and Google Play Console
6. Run `eas build` for iOS and Android
7. Submit to app stores
8. Deploy landing page to hosting
9. Update getbuybye.com DNS/hosting to point to the landing page
