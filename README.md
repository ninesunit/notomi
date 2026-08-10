# Notomi

**Live: https://notomii.web.app**

A NotebookLM-style study workspace for **desktop, iPhone and iPadOS**, built on
Expo Router + React Native Web and running entirely on your own Firebase
project. There are no third-party AI keys anywhere in the stack — Gemini is
reached through Firebase AI Logic, and document parsing happens on the device.

## Deployment status

| Piece | State |
| --- | --- |
| Hosting (`notomii.web.app`) | Deployed |
| Firestore rules | Deployed |
| Auth: Email/Password, Google, Anonymous | Enabled |
| Firestore composite indexes | None needed — every query is single-field |
| Cloud Storage for Firebase | No longer used — replaced by Cloudflare R2 |
| **R2 broker Worker** | **Not deployed — see below** |
| **Firebase AI Logic API** | **Not enabled — see below** |

Two things are still outstanding, both needing access this environment does not
have. Until they are done the app runs and signs in, documents are parsed and
saved, and the UI says plainly what is unavailable.

1. **Deploy the R2 Worker.** `cd worker && npm install && npx wrangler deploy`
   — see [`worker/README.md`](worker/README.md) for the three secrets and the
   bucket CORS policy. Then set `EXPO_PUBLIC_R2_WORKER_URL` in `.env` and
   redeploy. Until then originals are not stored; extracted text still is, so
   chat, quizzes and audio overviews are unaffected.

2. **Enable Firebase AI Logic** —
   https://console.firebase.google.com/project/notomii/ailogic — choose the
   **Gemini Developer API** backend. This turns on
   `firebasevertexai.googleapis.com`, which powers summaries, deadline
   extraction, chat, quizzes and audio overviews. A project **Owner** must do
   this: the Admin SDK service account lacks `serviceusage.services.enable`.

## Where the R2 credential lives, and why

The web app is a static bundle, so every `EXPO_PUBLIC_*` value is readable by
anyone who opens the site. An R2 access key placed there would grant the public
read, write and delete on the whole bucket.

So the key lives in the Worker instead. The browser asks the Worker for a
short-lived presigned URL and then talks to R2 directly; the Worker verifies
the caller's Firebase ID token and refuses any key outside
`users/{their-uid}/`. `src/services/r2Storage.ts` keeps a direct-signing path
for native builds and local development, and deliberately refuses it in a
production web build.

## How it works

| Concern | Choice |
| --- | --- |
| UI | Expo Router + `react-native-web`, NativeWind (Tailwind) |
| Auth / data | Firebase Auth (Email, Google, Anonymous), Cloud Firestore |
| Original files | Cloudflare R2 (`notomi-materials`) via an S3-compatible client |
| AI | Firebase AI Logic (`firebase/ai`) → Gemini. No OpenAI/Anthropic keys |
| Parsing | `pdfjs-dist` and `mammoth` in the browser — nothing is uploaded to parse |
| Retrieval | None. Gemini's long context takes the whole corpus verbatim |

### Why the Firebase JS SDK and not `@react-native-firebase`

`@react-native-firebase/*` is native-only and does not run under
`react-native-web`. Since the target is a web app that has to work on desktop
Safari/Chrome, iPhone and iPad, Notomi uses the Firebase **JS** SDK (v12),
whose `firebase/ai` entry point is the same Firebase AI Logic service. The
Expo/React Native project structure is kept, so shipping real native builds
later is a config change rather than a rewrite.

### No RAG, on purpose

Gemini's context window is over a million tokens. Instead of chunking and
embedding, Notomi stores each document's full text in Firestore and
concatenates every source for a subject into one prompt (`buildContext` in
`src/lib/ai.ts`, capped at 600k characters). Cross-document questions work
because the model genuinely sees every document at once.

## Setup

### 1. Firebase console

In the [`notomii` project](https://console.firebase.google.com/u/0/project/notomii/overview):

1. **Project settings → General → Your apps** — add a **Web** app if there
   isn't one, and copy the SDK config.
2. **Authentication → Sign-in method** — enable **Email/Password**, **Google**
   and **Anonymous** (the last powers "Continue as guest").
3. **Firestore Database** — create the database.
4. **Build → AI Logic** — enable it and pick the **Gemini Developer API**
   backend. This is what lets the client call Gemini without a key.

### 2. Local config

```bash
cp .env.example .env      # then paste the values from step 1
npm install
npm run web
```

Until `.env` is filled in, the app boots to a setup screen listing exactly
which variables are missing rather than throwing an SDK error.

The `EXPO_PUBLIC_*` values are inlined into the client bundle. That is expected
for Firebase web config — they identify the project, they do not authorise
anything. Access is enforced by `firestore.rules`. Restrict
the API key by HTTP referrer in the Google Cloud console before going public.

### 3. Cloudflare R2

See [`worker/README.md`](worker/README.md). Deploy the Worker, set its three
secrets, apply the bucket CORS policy, then put the Worker URL in `.env` as
`EXPO_PUBLIC_R2_WORKER_URL`.

### 4. Deploy the rules

```bash
npx firebase login
npx firebase use notomii
npm run deploy:rules     # firestore rules + indexes
```

Nothing works without this — the default rules deny every read and write.

### 5. Deploy the app

```bash
npm run deploy:hosting   # builds dist/ and pushes to Firebase Hosting
```

Hosting is configured as a single-page app: every route rewrites to
`index.html`, hashed bundles are cached immutably, and `index.html` is not.

`build:web` passes `--clear`. That is deliberate: `EXPO_PUBLIC_*` values are
inlined at transform time, so a warm Metro cache will happily ship a bundle
carrying an older `.env` — which is exactly how a deploy ends up pointing at
the wrong project.

## Local development against emulators

```bash
npx firebase emulators:start --only auth,firestore
```

Then set `EXPO_PUBLIC_USE_FIREBASE_EMULATORS=1` in `.env`. Auth and Firestore
point at localhost. Gemini and R2 always talk to the real services — neither
has a local emulator.

## Data model

Everything hangs off `users/{uid}`, which is what makes the security rules a
single ownership check.

```
users/{uid}
  subjects/{subjectId}          name, moduleCode, color, documentCount
    documents/{documentId}      title, rawText (full extracted source),
                                r2FileKey, r2FileUrl, summary, charCount,
                                createdAt
  todos/{todoId}                title, dueDate, isCompleted, priority,
                                subTasks[], source: manual | syllabus
  weak_concepts/{conceptId}     concept, box (Leitner 0-4), nextReviewAt
```

Originals live in Cloudflare R2 at `users/{userId}/{subjectId}/{fileName}`.
The key carries a timestamp prefix so re-uploading a file with the same name
cannot overwrite an object an older document still points at.

## Features

- **Sign-in** — Email/Password, Google, or anonymous guest.
- **Dashboard** — subjects, source counts, and the next deadlines.
- **Library** — subject folders, each grouping its documents by module code.
- **Easy Reader** — chat grounded in every source for a subject, answering with
  inline quotes and refusing to go beyond the material.
- **Audio Overview** — Gemini writes a two-speaker podcast about the sources;
  `expo-speech` performs it with a different device voice per speaker.
- **Study Center** — 10-question quizzes written from the material. Misses are
  recorded in `weak_concepts` on a Leitner schedule (1/3/7/16/35 days) and
  resurface as targeted review sessions.
- **To-dos** — manual tasks and syllabus-extracted deadlines in one list,
  grouped Overdue / Today / Upcoming / No date, with nested subtasks.

Ingestion is resilient by design: if Gemini or R2 is unreachable,
the extracted text is still saved and the document is flagged with what failed,
rather than losing the upload.

## Scripts

| Script | Purpose |
| --- | --- |
| `npm run web` | Dev server in the browser |
| `npm run ios` / `android` | Native dev (Expo Go / dev client) |
| `npm run build:web` | Static export to `dist/` |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run deploy:rules` | Firestore rules + indexes |
| `npm run deploy:hosting` | Build and deploy to Firebase Hosting |

`postinstall` copies the pdf.js worker into `public/` so it is served
same-origin instead of from a CDN.
