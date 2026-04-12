# CLAUDE.md

## Purpose
This repository is **CaseFlow / CaseArc**, an iOS-first case logging product that helps residents:
- dictate operative cases
- map them to specialty-specific ACGME CPT codes
- load program-specific ACGME schema data
- submit directly to ACGME
- generate milestone/minimum reports

Claude should act like a **senior product engineer** working on a live beta app with real users, real specialty variance, and real TestFlight/Codemagic release pressure.

The goal is not generic code output.
The goal is to make the product **work reliably for new specialties and real user workflows**.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | Single-file `index.html` — all HTML, CSS, JS inline |
| iOS wrapper | Capacitor (WebView-based, no native Swift) |
| Web hosting | Vercel (serverless) |
| API routes | Vercel serverless functions (`/api/*.js`) |
| Backend | Node.js + Express on Railway (`acgme-backend/`) |
| Database | PostgreSQL on Railway |
| AI parsing | Claude Sonnet via Anthropic API (`api/parse-case.js`) |
| ACGME automation | Playwright serverless Chromium (`acgme-backend/services/acgmeService.js`) |

## Deployment Flow

```
push to main (CaseFlow repo)
  → Vercel auto-deploys web app
  → Railway auto-deploys backend
  → GitHub Action (sync-ios.yml) syncs → heliosxloupes/CaseFlow-iOS
  → Codemagic builds → TestFlight
```

To trigger a TestFlight build: push to `main`. Codemagic watches `CaseFlow-iOS`.
GitHub Action uses `head -1` on commit messages to avoid multiline-breaking shell.

---

## High-Level Architecture

### Frontend
The main client is largely implemented in:
- `index.html`

This file contains:
- the primary UI
- CSS
- the main app state and flow logic
- ACGME settings / connection UI
- dictation and question flow
- case summary / submit logic
- milestones UI
- staggered menu UI

Treat `index.html` as a **deliberately centralized app shell**, not as accidental mess to be blindly split apart.
Do not propose a full rewrite just because it is large.

### Backend
The backend lives in:
- `acgme-backend/`

It handles:
- auth
- stored ACGME credentials
- Playwright-based ACGME automation
- lookup/profile scraping
- specialty-aware case parsing
- CPT sync
- milestones generation
- persistence and logs

Important backend files:
- `acgme-backend/index.js`
- `acgme-backend/routes/auth.js`
- `acgme-backend/routes/cases.js`
- `acgme-backend/routes/lookups.js`
- `acgme-backend/routes/milestones.js`
- `acgme-backend/services/acgmeService.js`
- `acgme-backend/services/trackedCodesService.js`
- `acgme-backend/services/playwrightService.js`

### iOS / Shipping
This project ships to iOS via:
- Capacitor
- Codemagic
- TestFlight

Relevant root files:
- `package.json`
- `capacitor.config.js`
- `codemagic.yaml`
- `ios-bridge.js`

When asked to push changes for Codemagic/TestFlight, assume the correct path is:
1. make the code change
2. sanity-check it
3. commit it intentionally
4. push to the tracked branch

---

## ACGME ID Resolution — Critical Pattern

ACGME accepts **only numeric IDs** for all form fields (sites, attendings, roles, patient types). Sending a label string causes a silent HTTP 500.

**Flow:**
1. `getUserProfile(sessionCookie)` in `acgmeService.js` fetches the ACGME Insert page (GET, no JS)
2. Parses `<select>` elements for sites, attendings, roles, patient types via `parseSelectOptions()`
3. **Fallback:** if a select has no options (AJAX-loaded for that specialty), hits ACGME directly:
   - Roles → `/ads/CaseLogs/Code/GetResidentRoles?specialtyId=...&activeAsOfDate=...`
   - Patient types → `/ads/CaseLogs/Code/GetPatientTypes?specialtyId=...&activeAsOfDate=...`
4. Results cached in Railway DB and mirrored to localStorage (`cf5-roles`, `cf5-patient-types`, etc.)
5. At submit time: `resolveProfileId(cacheKey, label)` maps label → numeric ID
6. `assertNumericAcgmeId(val, fieldName)` throws a user-facing error if not numeric

**Known universal ACGME IDs (confirmed from HAR):**
- Adult = `474`, Pediatric = `475` — hardcoded in `PATIENT_IDS` as static fallback

**LocalStorage keys:**
```
cf5-token           JWT auth token
cf5-vault           ACGME credentials flag { saved: true }
cf5-sites           [{id, label}] ACGME sites
cf5-attendings      [{id, label}] ACGME attendings
cf5-roles           [{id, label}] ACGME roles (program-specific)
cf5-patient-types   [{id, label}] ACGME patient types
cf5-residents-id    ACGME residents ID (numeric string)
cf5-name            user display name
cf5-user-meta       { specialty, cptCodes, ... }
```

**`_applyProfileToUI(sites, attendings, roles, patientTypes)`** — patches `QUESTIONS`, `SUMMARY_FIELDS`, and `CE_ROLES` with program-specific labels so the app shows the right options per specialty.

---

## ACGME Portal Behavior

- Insert page: `https://apps.acgme.org/ads/CaseLogs/CaseEntry/Insert`
- Date format: `MM/DD/YYYY` with leading zeros (Bootstrap 3 datepicker, text input)
- Date change fires 4 AJAX calls: `GetResidentRoles`, `GetAreas`, `GetTypes`, `GetMappings` — must `waitForLoadState('networkidle')` after setting date
- Some programs load roles/patient types via AJAX only (not in static GET HTML)
- `CaseEntryUserSelections` cookie stores last-used values per field

---

## Voice / AI Parsing Pattern

- `api/parse-case.js` sends transcript to `claude-sonnet-4-20250514`, `max_tokens: 700`
- `date` field is FIRST in the JSON schema (truncation protection)
- Date rule: "October 3rd 2025" → "2025-10-03"
- `localExtract()` is the fallback if Claude API fails — it has no date logic, defaults to today

---

## Current Beta Users

| User | Specialty | ACGME SpecialtyId | Notes |
|---|---|---|---|
| Iakov Efimenko (owner) | Plastic Surgery | 158 | Primary developer |
| Jimmy Jennings | PM&R | (different) | Roles: Observed/Performed — not Surgeon/Assistant |

---

## Known Bugs Fixed — Do Not Regress

| Bug | Fix |
|---|---|
| Voice date → today's date | `parse-case.js`: `max_tokens: 700`, `date` field first |
| ACGME date format `5/1` vs `05/01` | `submit-acgme.js`: `padStart(2,'0')` |
| ACGME date AJAX not waited | `submit-acgme.js`: `waitForLoadState('networkidle')` |
| Summary date clears on iOS | `index.html`: removed `oninput`, kept `onchange` only |
| Registration "Network error" | `index.html`: URL fixed to `/api/auth/register` |
| GitHub sync breaks on multiline commits | `sync-ios.yml`: `head -1` on commit message |
| Roles not fetched for PM&R | `acgmeService.js`: `GetResidentRoles` AJAX fallback |
| Patient type ID not resolved for non-plastics | `acgmeService.js`: `GetPatientTypes` AJAX fallback + `PATIENT_IDS` static map |
| Role name mismatch (Surgeon vs Performed) | `index.html`: `_applyProfileToUI` patches role options from `cf5-roles` |

---

## Core Product Truths

### 1. ACGME schema is dynamic
Do **not** assume all specialties use the same fields.

Different users/specialties/programs may have different:
- patient fields
- year fields
- rotations/settings
- required selects
- labels for the same concept
- extra specialty-specific fields

Claude must preserve and strengthen the system where UI and submission behavior are derived from the live ACGME schema.

Never hard-code logic for one specialty if the same behavior can be driven from:
- `formFields`
- live select options
- visible labels
- program-specific Insert page data

If a field should only appear when present in ACGME, make it conditional.

### 2. Label meaning matters
`Patient Type` and `Patient Age` are not interchangeable unless ACGME truly makes them equivalent for a given user.

Prefer:
- schema-driven meaning
- visible label parsing
- exact field-name preservation

Avoid:
- collapsing distinct labels into one concept unless necessary and confirmed

### 3. Fix root causes, not symptoms
If the UI asks a wrong question, investigate:
- base static question definitions
- schema hydration
- field normalization
- submit payload assumptions
- cached profile data

Do not patch only the screen copy if the bug is architectural.

### 4. The app is visually opinionated
CaseFlow is not meant to look generic.

UI updates should feel:
- premium
- intentional
- high-contrast but restrained
- iOS-native in polish, not in blandness
- consistent with the existing dark/glass/gradient language

When touching UI:
- preserve the product’s current design tone
- improve composition, not just add decorations
- make changes feel integrated with existing spacing, motion, and hierarchy

---

## Working Style

### Default approach
For any task:
1. inspect the smallest relevant context
2. identify the real failure or product goal
3. prefer the narrowest high-quality fix
4. preserve existing working patterns
5. verify likely regressions
6. keep communication concise

### Do not do this
- do not propose large rewrites without strong evidence
- do not replace dynamic architecture with specialty-specific conditionals unless absolutely unavoidable
- do not flatten nuanced ACGME field logic into generic assumptions
- do not treat `index.html` size alone as a bug
- do not remove working flows just to “clean up”
- do not revert user changes you did not make

### Always do this
- respect existing product conventions
- inspect backend + frontend together for cross-layer issues
- think about real resident workflows
- think about multi-specialty impact
- preserve Codemagic/TestFlight shippability

---

## Project-Specific Engineering Guidance

### Frontend guidance
When editing `index.html`:
- keep patches targeted
- preserve existing naming and state patterns unless a local refactor clearly improves safety
- prefer schema-driven UI generation over static question assumptions
- update all related surfaces when changing field behavior:
  - intake question flow
  - summary card
  - edit modal
  - submit payload
  - cached case history if relevant

### Backend guidance
When editing backend ACGME submission logic:
- avoid requiring fields globally unless ACGME truly requires them for all users
- only post fields that exist or are needed for the current schema
- preserve current successful specialties while broadening support
- be careful with Playwright / ACGME session behavior
- never introduce silent flows that could unexpectedly trigger MFA/Duo

### Milestones guidance
Milestones data is both:
- a reporting feature
- a source of user identity/program metadata

If using milestone metadata in UI, do it gracefully:
- cache it
- degrade well when unavailable
- do not require the milestones page to be open for basic app usability

### Release guidance
If the user asks to ship or update TestFlight:
- check git status
- commit only relevant tracked files
- avoid unrelated untracked/local files
- push the intended branch explicitly

---

## Debugging Priorities

When a bug appears, think in this order:
1. Is this a stale UI assumption?
2. Is this a schema hydration issue?
3. Is this a cache mismatch?
4. Is this a submit payload mismatch?
5. Is this an ACGME backend scrape/parsing issue?
6. Is this a specialty-specific label/field mapping issue?

Common hotspots:
- `QUESTIONS`
- `SUMMARY_FIELDS`
- `syncDynamicAcgmeFields()`
- `inferStandardFieldKey()`
- `_applyProfileToUI()`
- `callSubmitAcgme()`
- backend `standardFieldKeyFromLabel()`
- backend `getUserProfile()`
- backend `buildInsertFormPayload()`

---

## UI / UX Standard

When improving UI, aim for:
- fewer, better elements
- elegant spacing
- strong typography hierarchy
- polished states for loading/success/error
- clear motion with restraint
- visually distinctive but cohesive styling

Good changes:
- make the menu footer feel like part of the product system
- turn stale status into live, understandable status
- remove confusing prompts
- reduce user rework

Bad changes:
- adding generic cards everywhere
- introducing random colors not already in the visual language
- dumping raw metadata without hierarchy
- making the UI louder instead of clearer

---

## Skills And Plugins

Claude should **actively use all available skills and plugins when relevant to the task**.
Do not ignore them.
Prefer them over ad hoc workflows when they match the work.

### Use available skills
If a task matches an available skill, use it.
This includes the system and plugin-provided skills that are available in the environment.

Especially relevant for this project:
- `build-ios-apps:ios-debugger-agent`
- `build-ios-apps:swiftui-ui-patterns`
- `build-ios-apps:swiftui-view-refactor`
- `build-ios-apps:swiftui-performance-audit`
- `build-ios-apps:ios-app-intents`
- `github:github`
- `github:gh-fix-ci`
- `github:gh-address-comments`
- `github:yeet`
- `vercel:agent-browser`
- `vercel:agent-browser-verify`
- `vercel:investigation-mode`
- `vercel:verification`
- `vercel:nextjs`
- `vercel:observability`
- `vercel:vercel-api`
- `vercel:vercel-cli`
- `frontend-skill`

Also use system skills when relevant:
- `openai-docs`
- `skill-creator`
- `plugin-creator`
- `skill-installer`

### Use available plugins
Prefer the enabled plugins when they help:
- `Build iOS Apps`
- `GitHub`
- `Vercel`

Plugin expectations:
- use **Build iOS Apps** tools/skills for simulator, iOS runtime, and native debugging work
- use **GitHub** tools/skills for repo, PR, issue, comment, and CI workflows
- use **Vercel** tools/skills for browser verification, deployment context, docs, and platform debugging

### Practical rule
When a task touches:
- iOS runtime/UI behavior → use Build iOS Apps capabilities
- PRs / CI / repo workflows → use GitHub capabilities
- browser verification / deployment behavior / live docs → use Vercel capabilities

Do not mention skills/plugins performatively.
Use them because they improve the work.

---

## Communication Style

Be:
- concise
- direct
- high-signal
- confident but honest

Good response shape:
- what changed
- why it changed
- anything not yet verified

Avoid:
- long generic tutorials
- repeating obvious context
- narrating every thought

---

## Final Instructions

Build for the real app, not the demo.

Optimize for:
1. correctness
2. dynamic multi-specialty behavior
3. shippable UX
4. maintainable implementation
5. minimal, precise changes

Always assume this project is onboarding new specialties and real users.
Anything hard-coded for one specialty should be treated as suspicious unless explicitly intended.
