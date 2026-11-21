# Putting the app online with Vercel and Turso

Vercel runs the app, Turso holds the database, and Vercel Blob keeps uploaded
files (study materials, gallery photos, the school logo). All three have free
plans to start with.

**Lesson videos are still made on your own computer.** Vercel can't run the
video service (it needs Python, Manim, FFmpeg and LaTeX). On the online app,
teachers and admins can still add videos from a YouTube link, and admins
approve and publish them. Making new AI videos needs the app and the video
service running on your computer, or a server of your own later.

## 1. Turso (the database)

1. Sign up at https://turso.tech and create a database (pick the region
   closest to your users).
2. On the database's page, copy its URL (`libsql://...`) and create a token.
3. In the project folder, make a file named `.env.deploy.local` (git ignores
   it) with:

   ```
   TURSO_DATABASE_URL=libsql://your-db-name.turso.io
   TURSO_AUTH_TOKEN=the-token
   ```

4. Copy your current data across, once, into the new empty database:

   ```
   node --env-file=.env.deploy.local scripts/copy-db-to-turso.mjs
   ```

   After a later change to `prisma/schema.prisma`, make the migration locally
   with `npx prisma migrate dev`, then apply it to Turso with
   `node --env-file=.env.deploy.local scripts/turso-migrate.mjs`.

## 2. Vercel (the app)

1. Sign up at https://vercel.com with GitHub and import this repository.
   Vercel finds the Next.js settings itself; the production branch is `starter`.
2. Before the first deploy, add these Environment Variables:

   | Name | Value |
   | --- | --- |
   | `TURSO_DATABASE_URL` | from step 1 |
   | `TURSO_AUTH_TOKEN` | from step 1 |
   | `AUTH_SECRET` | a new random one (see `.env.example`) |
   | `SCHOOL_TIMEZONE` | `Africa/Johannesburg` |
   | `APP_URL` | the site's address, e.g. `https://your-app.vercel.app` |

   Add the email (`SMTP_*`, `MAIL_FROM`) and online class (`ZOOM_*`, `MS_*`)
   values too if you use them. Leave out `DATABASE_URL`, `VIDEO_SERVICE_URL`
   and `VIDEO_SERVICE_SECRET`.
3. In the project, open **Storage**, create a **Blob** store and connect it.
   Vercel adds `BLOB_READ_WRITE_TOKEN` for you. Redeploy afterwards.
4. Copy your existing uploads across: add the same `BLOB_READ_WRITE_TOKEN`
   to `.env.deploy.local`, then run

   ```
   node --env-file=.env.deploy.local scripts/copy-storage-to-blob.mjs
   ```

## Limits to know about

- Vercel takes uploads up to about 4.5 MB per file, so bigger study materials
  or photos fail there. Compress them first, or host the app on a server.
- Sign-in sessions use `AUTH_SECRET`. Changing it signs everyone out.
