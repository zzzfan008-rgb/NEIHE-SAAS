# Docker runtime data

Production uses two independent named volumes: `garment-canvas_postgres_data`
for PostgreSQL and `garment-canvas_app_data` for uploads, assets and template
files. The `garment-canvas` name comes from `compose.yaml`.

The app must not bind-mount a development checkout's `data/`: Git stash and
branch switches can restore old template files while the server is running.
Built-in template definitions live in `server/routes/templates.ts`; startup
creates missing templates and upgrades managed legacy templates. Generated
`data/templates/builtin/` files are ignored by Git. Historical inputs needed for
regression tests live in `tests/fixtures/legacy-builtin-templates/`.

## Upgrade an existing bind-mount deployment

Do not run `docker compose up` with the new configuration until the old files
have been copied into `garment-canvas_app_data`. An empty volume cannot supply
the files referenced by the existing database.

1. Inspect the running app's mount source and image ID. Verify no generation or
   analysis job is active, then stop only the app (`docker compose stop app`).
2. Create `garment-canvas_app_data`. Refuse to overwrite a non-empty destination.
3. Using the existing app image as a temporary helper, mount the old directory
   read-only and the new volume writable. Copy all files, preserve timestamps,
   and assign ownership to the image's `node` user. Compare each regular file's
   SHA-256 hash and the full relative path inventory before continuing. Keep the
   original directory as the rollback copy.
4. Start the rebuilt app with `docker compose up -d --no-deps --no-build --wait app`.
   Recreate the proxy if needed so its upstream resolves to the new app container.
   Do not recreate PostgreSQL or remove either volume.
5. Check `/api/ready`, the LAN page, existing image loading and authenticated
   `/api/templates`. All three sketch templates must have the optimization node;
   AI styling must be available. Compare non-built-in files to the copy manifest.

Built-in template files may legitimately change during startup. User templates,
uploads and assets must retain their content. Existing project workflows are
not rewritten to add nodes. Never restore an old template stash over production.

## Backup and rollback

Back up the app volume and PostgreSQL separately. The old checkout's `data/`
stops receiving production writes after migration and is not a current backup.
`backups/` is ignored by Git.

Before reopening writes, a failed migration can be rolled back by restoring the
previous image and old bind mount. After reopening writes, take fresh backups
and reconcile new app files before any rollback; switching to the old directory
alone would lose access to newer uploads. Never run `docker compose down -v` on
production.
