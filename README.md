# Notomi

A NotebookLM-style study workspace for **desktop, iPhone and iPadOS**, built on
Expo Router + React Native Web and running entirely on your own Firebase
project. There are no third-party AI keys anywhere in the stack — Gemini is
reached through Firebase AI Logic, and document parsing happens on the device.

## How it works

| Concern | Choice |
| --- | --- |
| UI | Expo Router + `react-native-web`, NativeWind (Tailwind) |
| Auth / data / files | Firebase Auth, Cloud Firestore, Cloud Storage |
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
2. **Authentication → Sign-in method** — enable **Email/Password** and
   **Anonymous** (the latter powers "Continue as guest").
3. **Firestore Database** — create the database.
4. **Storage** — enable it.
5. **Build → AI Logic** — enable it and pick the **Gemini Developer API**
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
anything. Access is enforced by `firestore.rules` and `storage.rules`. Restrict
the API key by HTTP referrer in the Google Cloud console before going public.

### 3. Deploy the rules

```bash
npx firebase login
npx firebase use notomii
npm run deploy:rules     # firestore rules + indexes + storage rules
```

Nothing works without this — the default rules deny every read and write.

### 4. Deploy the app

```bash
npm run deploy:hosting   # builds dist/ and pushes to Firebase Hosting
```

Hosting is configured as a single-page app: every route rewrites to
`index.html`, hashed bundles are cached immutably, and `index.html` is not.

## Local development against emulators

```bash
npx firebase emulators:start --only auth,firestore,storage
```

Then set `EXPO_PUBLIC_USE_FIREBASE_EMULATORS=1` in `.env`. Auth, Firestore and
Storage point at localhost; Gemini always calls the real service, since there
is no local emulator for it.

## Data model

Everything hangs off `users/{uid}`, which is what makes the security rules a
single ownership check.

```
users/{uid}
  subjects/{subjectId}          name, moduleCode, color, documentCount
    documents/{documentId}      text (full extracted source), summary,
                                storagePath, downloadUrl, charCount
  todos/{todoId}                title, dueDate, isCompleted, priority,
                                subTasks[], source: manual | syllabus
  weak_concepts/{conceptId}     concept, box (Leitner 0-4), nextReviewAt
```

Original uploads live in Cloud Storage at
`materials/{uid}/{subjectId}/{documentId}-{fileName}`.

## Features

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

Ingestion is resilient by design: if Gemini or Cloud Storage is unreachable,
the extracted text is still saved and the document is flagged with what failed,
rather than losing the upload.

## Scripts

| Script | Purpose |
| --- | --- |
| `npm run web` | Dev server in the browser |
| `npm run ios` / `android` | Native dev (Expo Go / dev client) |
| `npm run build:web` | Static export to `dist/` |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run deploy:rules` | Firestore rules + indexes, Storage rules |
| `npm run deploy:hosting` | Build and deploy to Firebase Hosting |

`postinstall` copies the pdf.js worker into `public/` so it is served
same-origin instead of from a CDN.
