# Firebase Setup — SkillVerse BD

Firebase Authentication is not live until the Firebase Web App config is added.

## Required setup
1. Open Firebase Console: https://console.firebase.google.com/
2. Create a Firebase project for SkillVerse BD (or select your existing project).
3. In **Authentication → Sign-in method**, enable **Email/Password**.
4. In **Project settings → General → Your apps**, create/register a Web App (</>).
5. Copy the web app configuration object values into `firebase-config.js`. Replace each `PASTE_...` placeholder. Keep the object keys as written.
6. Ensure Firebase Authentication's authorized domains include the GitHub Pages domain `kdcamir5-crypto.github.io` (Authentication → Settings → Authorized domains).

## Notes
- Firebase web config is client-side configuration, not a service-account secret. Do not put private service-account credentials or Admin SDK keys in this repository.
- Protect future Firestore data with Security Rules; client-side sign-in alone does not secure database documents.
- The current auth page supports email/password sign-up, sign-in, and password reset. The profile still uses browser local storage; cloud profile sync is a separate next task.
