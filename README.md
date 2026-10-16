# 10BArchive

A GitHub Pages frontend with a Render-hosted Node.js API. Student submissions go to a **private** repository for moderation. Only approved files are copied into the public website repository.

## Repository setup

Create two repositories under the same GitHub account:

- `10BArchive` — **public**, contains `frontend/index.html` copied to the repository root as `index.html`, plus approved files.
- `10BArchive-Pending` — **private**, used only by the backend for pending submissions.

Both should use the `main` branch. Enable GitHub Pages for `10BArchive` from the `main` branch and `/ (root)`.

## Backend deployment on Render

Create a **Web Service** from this project/repository and set **Root Directory** to `backend`.

- Runtime: Node
- Build command: `npm install`
- Start command: `npm start`

Set these environment variables in Render (never commit actual secrets):

- `GITHUB_TOKEN`: fine-grained token with access only to `10BArchive` and `10BArchive-Pending`; Contents read/write; Metadata read-only.
- `GITHUB_OWNER`: exact GitHub username/owner.
- `PUBLIC_REPO`: `10BArchive`
- `PENDING_REPO`: `10BArchive-Pending`
- `GITHUB_BRANCH`: `main`
- `ADMIN_PASSWORD`: long, unique password used only for the moderator dashboard.
- `FRONTEND_ORIGIN`: exact GitHub Pages origin, e.g. `https://USERNAME.github.io` (no trailing slash). If using a custom domain, include that origin too, comma-separated.
- `MAX_UPLOAD_MB`: `25`

After deployment, check `https://YOUR-RENDER-SERVICE.onrender.com/api/health`, then open `/admin` for the moderator dashboard.

## Connect the frontend

In `frontend/index.html`, replace `https://SET-YOUR-RENDER-SERVICE-URL` in `API_BASE` with your actual Render service URL (no trailing slash). Copy that file's contents to the root `index.html` in the public `10BArchive` repository. Keep the token and moderator password out of all frontend files.

## Workflow

1. Student submits an allowed file (max 25 MB) and chooses a destination.
2. The backend writes the file and submission metadata into `pending/` in the private repository.
3. Moderator opens `/admin`, signs in, then approves or rejects.
4. Approval copies the file to the public repository and then removes the pending copy. Rejection removes the pending file and metadata.
5. The public website lists only files in the public repository; pending files are never listed by public endpoints.

## Important notes

- Use only material you have permission to share. Check school/copyright rules before publishing books or paid study guides.
- GitHub's API has file-size and rate limits. This setup intentionally limits each upload to 25 MB.
- A GitHub token with Contents write access can change both repositories. Restrict it to only these two repositories and keep it only in Render environment variables.
- This project has not been deployed to your GitHub account or Render by this package. You must configure the repositories and service before public submissions work.
