<div align="center">
  <img src="assets/icon.png" alt="Notomi logo" width="112" />
  <h1>Notomi</h1>
  <p><strong>An AI-native academic workspace for planning, learning, creating and studying together.</strong></p>
  <p>
    <a href="https://notomii.web.app"><strong>Open the live app</strong></a>
    ·
    <a href="#what-notomi-does">Features</a>
    ·
    <a href="#architecture">Architecture</a>
    ·
    <a href="#run-locally">Run locally</a>
  </p>
</div>

---

Notomi turns schedules, academic calendars, syllabuses, lecture slides and notes into one connected student workspace. It is designed for desktop, iPhone and iPadOS with an Expo/React Native Web interface, Firebase synchronization, Cloudflare R2 storage and Gemini-powered document intelligence.

## What Notomi does

| Surface | Student experience |
| --- | --- |
| **Dashboard** | A complete Monday–Sunday schedule with classes, venues, routines, term progress and workload forecasting. |
| **Knowledge** | Subject folders, multi-file ingestion, a document vault, grounded Open Reader chat and locally rendered PDFs. |
| **Schedule & Calendar** | AI schedule scanning, academic-calendar anchoring, editable import review, conflict detection and manual term management. |
| **Tasks & Focus** | Assignment task extraction, task boards, Pomodoro focus rooms, ambient sound and synchronized study sprints. |
| **Notomi Notes** | Infinite Apple Pencil canvas, pressure-sensitive ink, PDF/image nodes, notebooks, pages, offline caching and compressed sync. |
| **Notomi Reel** | A vertical micro-learning feed with quizzes, source jumps, bookmarks, mastery tracking and spaced repetition. |
| **Arena & Social** | Student discovery, verified universities, classmate matching, live/ghost quiz battles, deck sharing and shared free-time matching. |

## Product highlights

- Universal staging queue for up to 10 PDFs, images or slide decks per batch.
- AI classification that routes schedules, calendars, syllabuses, slides and general notes automatically.
- Parent/child academic data model: `Subject` owns `ClassSession` and `Material` records through `subjectId`.
- Gemini model fallback, response caching and rolling chat history to reduce quota pressure.
- Client-side PDF parsing, note export and compressed offline-first canvas storage.
- Privacy-aware social presence: students share course codes or busy intervals only when they opt in.
- Anonymous guest sessions that are removed with their workspace data when the student signs out.
- Responsive sidebar navigation, `100dvh` wrappers and safe-area support without a bottom navigation bar.

## Architecture

```text
Expo Router + React Native Web
        |
        +-- Firebase Authentication + App Check
        +-- Cloud Firestore (relational academic and social records)
        +-- Firebase AI Logic -> Gemini Flash model pool
        +-- Cloudflare Worker -> private R2 material storage
        +-- IndexedDB + LZ String (instant local Notomi Notes state)
        +-- PDF.js + perfect-freehand (local PDF and pencil rendering)
```

### Data and privacy boundaries

- Private schedules, materials, marks and notes remain under `users/{uid}`.
- Public profiles contain only the name, username, selected university, major, bio, opted-in course codes and aggregate learning stats.
- Free-time matching uses anonymous busy intervals; it never exposes course names, rooms or task details.
- R2 objects are namespaced under `users/{uid}/` and the Worker verifies Firebase identity before private reads, writes or deletes.
- Profile images use a dedicated public image route; the route cannot access course materials or note attachments.

## Technology

- Expo Router, React 19, React Native Web and NativeWind
- Firebase Auth, Cloud Firestore, App Check and Firebase AI Logic
- Cloudflare Workers and R2
- Gemini Flash model pool with cooldown and fallback handling
- PDF.js, Mammoth, JSZip, jsPDF, perfect-freehand, IndexedDB and LZ String
- Lucide vector iconography

## Run locally

```bash
npm install
copy .env.example .env.local
npm run web
```

Fill the public Firebase web configuration and Worker URL in `.env.local`. Firebase web identifiers are safe to expose; authorization is enforced by App Check, Firestore rules and the authenticated R2 Worker.

Useful commands:

```bash
npm run typecheck
npm run build:web
npm run deploy:rules
npm run deploy:hosting
```

The storage Worker lives in `worker/`:

```bash
cd worker
npm install
npx wrangler types
npx wrangler deploy
```

## Deployment

The current production build is available at **[notomii.web.app](https://notomii.web.app)**.

- Firebase Hosting serves the static Expo export.
- Firestore rules enforce ownership and bounded public-profile access.
- `notomi-r2.filazliakim.workers.dev` brokers authenticated R2 operations.
- The open-source university directory is bundled locally, so university lookup does not consume Firestore reads.

## License

This repository currently has no open-source license. All rights are reserved by the project owner unless a license is added later.
