# BuyBye — Mobile App, Landing Page & Categorization Backend

## Overview

Transform BuyBye from a single-file PWA into a native mobile app (iOS + Android) with ad monetization, a $0.99 ad-free in-app purchase, a crowdsourced category database, and a marketing landing page at getbuybye.com.

## Goals

- Ship native apps to App Store and Google Play Store
- Monetize with AdMob banner ads + $0.99 one-time IAP to remove ads
- Crowdsource item categorization data from users to grow the keyword database over time
- Replace getbuybye.com with a polished showroom landing page that drives app downloads

## Non-Goals

- User accounts or cloud sync
- Runtime server calls for categorization (everything baked at build time)
- Backend beyond a single Supabase table + edge function
- Server-side receipt validation for IAP

---

## Project Structure

Three independent pieces, each with its own deploy pipeline:

| Piece | Repo / Folder | Tech | Deploy |
|-------|---------------|------|--------|
| Mobile app | `buybye-app/` (new repo) | React Native, Expo, TypeScript | Expo EAS Build → App Store + Play Store |
| Landing page | `buybye-website/` (new repo) | Static HTML/CSS/JS | Static hosting (Netlify/Vercel/GitHub Pages) |
| Categorization backend | `buybye/supabase/` (this repo) | Supabase (Postgres + Edge Function) | Supabase managed (free tier) |

---

## Mobile App

### Tech Stack

- React Native + Expo SDK 52+ (managed workflow), minimum iOS 16+, Android 8+
- TypeScript
- AsyncStorage for local persistence
- `react-native-google-mobile-ads` for AdMob
- `react-native-iap` for in-app purchases (requires EAS Build — cannot be tested in Expo Go; needs Apple IAP entitlement and Google Play billing setup on their respective consoles)

### Screens

The app is intentionally minimal — one main screen plus a settings area:

- **ShoppingList** — Input field at top, items grouped by category in cards, check items off, swipe-left or long-press to delete, collapsible "Done" section for checked items (moved there 1 hour after being checked off). This mirrors the current PWA behavior exactly. The app is renamed from "ShopList" (current PWA title) to "BuyBye" for the mobile release.
- **Settings** — Language toggle (EN/PT). Accessible from the header.

### Data Layer

- **Shopping list:** Stored in AsyncStorage. Same data model as current PWA: `{ id, name, category, checked, checkedAt }`.
- **Category keywords:** Shipped as a static `categories.json` file baked into the app bundle. Updated each release from the Supabase DB via the build-time sync script.
- **Language preference:** Stored in AsyncStorage.

### Auto-Categorization Flow

1. User types an item name
2. App matches against the local `categories.json` keyword list
3. **If match found:** Item is categorized automatically (no server call)
4. **If no match:** A bottom sheet appears with 6 category icons. The item is not added until the user picks a category. If the user dismisses the sheet without choosing, the item is added under "Grocery" and no Supabase POST is sent.
   - Item is categorized immediately in the local list
   - A background POST is sent to Supabase: `{ item_name, category, locale }`
   - If the POST fails (offline, etc.), it's silently dropped — no retry queue needed

### Monetization

- **Free tier:** Google AdMob banner ad fixed at the bottom of the screen. AdMob App ID stored as an EAS secret and injected into app.json at build time. Test ad unit IDs used during development.
- **Paid tier ($0.99):** One-time non-consumable in-app purchase via `react-native-iap`
  - Removes the banner ad permanently
  - Purchase state stored locally in AsyncStorage
  - Client-side receipt verification only (via `react-native-iap` built-in methods — no server-side validation)
  - Restore purchases supported (required by Apple)

### Bilingual Support

Same approach as current PWA:
- A `translations` object with `en` and `pt` keys
- Language preference saved in AsyncStorage
- UI updates immediately on toggle

---

## Supabase Categorization Backend

### Table: `category_submissions`

| Column | Type | Notes |
|--------|------|-------|
| id | uuid | auto-generated primary key |
| item_name | text | lowercase, trimmed |
| category | text | one of: meat, produce, bakery, dairy, drinks, grocery |
| locale | text | "en" or "pt" |
| created_at | timestamptz | auto, default now() |

### Edge Function: `submit-category`

- **Method:** POST
- **Payload:** `{ item_name: string, category: string, locale: string }`
- **Auth:** None (anonymous crowdsourced data)
- **Validation:** Reject empty strings, unknown categories, unknown locales
- **Rate limiting:** Supabase built-in limits

### Row Level Security (RLS)

- Anonymous users: INSERT only
- No SELECT, UPDATE, or DELETE for anonymous users
- Service key (used by build script): full read access

### Build-Time Sync Script: `sync-categories.js`

Runs locally or in CI before each app release (daily or weekly cadence):

1. Queries `category_submissions` using the service key
2. For each `item_name`, selects the most commonly submitted category (majority vote)
3. Applies a minimum threshold of 3 submissions to filter noise (this means crowdsourced additions will be sparse early on — the hardcoded keyword list carries the full weight at launch)
4. Merges results with the existing hardcoded keywords (hardcoded keywords take precedence for known items)
5. Outputs an updated `categories.json` to the app bundle

---

## Landing Page (getbuybye.com)

### Purpose

Marketing showroom that sells the app's simplicity and drives downloads. Replaces the current PWA.

### Sections (top to bottom)

1. **Hero** — App name, tagline ("The simplest shopping list"), phone mockup showing the app, App Store + Play Store download buttons
2. **Features** — 3-4 cards: auto-categorization, swipe to delete, no account needed, bilingual
3. **How it works** — 3-step visual: "Add item → Auto-sorted → Shop & check off"
4. **Download CTA** — Repeat download buttons, "Free with ads / $0.99 ad-free" note
5. **Footer** — Privacy policy link (required by app stores), contact

### Tech

Static HTML/CSS/JS. Design will be created using the `frontend-design` skill — polished, modern marketing aesthetic (not the current green PWA look).

### PWA Retirement

The existing PWA at getbuybye.com gets replaced by the landing page. Users who previously installed the PWA will retain their cached version (service worker left to cache-expire naturally, not explicitly killed), but new visitors see the showroom. No data migration from PWA localStorage to the mobile app — users start fresh on mobile.

---

## App Store Requirements

Things needed for submission that aren't code:

- **Apple Developer Account** ($99/year) — required for App Store
- **Google Play Developer Account** ($25 one-time) — required for Play Store
- **App icons** — 1024x1024 for App Store, 512x512 for Play Store
- **Screenshots** — Multiple device sizes for both stores
- **Privacy policy** — Hosted on getbuybye.com (required by both stores). The app collects: item names + chosen categories (sent anonymously to Supabase). No personal data.
- **App Store description & metadata** — Both EN and PT
